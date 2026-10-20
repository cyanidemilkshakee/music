//! Connection admission and read deadlines, independent of streaming responses.
use axum::{body::Body, Router};
use hyper::{body::Incoming, server::conn::http1, Request};
use hyper_util::{
    rt::{TokioIo, TokioTimer},
    service::TowerToHyperService,
};
use std::{sync::Arc, time::Duration};
use tokio::{net::TcpListener, sync::Semaphore, task::JoinSet};
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

struct Limits {
    max_connections: usize,
    header_read_timeout: Duration,
    connection_shutdown_timeout: Duration,
    server_shutdown_timeout: Duration,
}

pub async fn serve(
    listener: TcpListener,
    app: Router,
    shutdown: CancellationToken,
    max_connections: usize,
    read_timeout_ms: u64,
) -> std::io::Result<()> {
    serve_with_limits(
        listener,
        app,
        shutdown,
        Limits {
            max_connections,
            header_read_timeout: Duration::from_millis(read_timeout_ms),
            connection_shutdown_timeout: Duration::from_secs(5),
            server_shutdown_timeout: Duration::from_secs(6),
        },
    )
    .await
}

async fn serve_with_limits(
    listener: TcpListener,
    app: Router,
    shutdown: CancellationToken,
    limits: Limits,
) -> std::io::Result<()> {
    let permits = Arc::new(Semaphore::new(limits.max_connections));
    let mut connections = JoinSet::new();
    loop {
        while connections.try_join_next().is_some() {}
        let permit = tokio::select! {
            _ = shutdown.cancelled() => break,
            permit = permits.clone().acquire_owned() => permit.map_err(std::io::Error::other)?,
        };
        let (socket, _) = tokio::select! {
            _ = shutdown.cancelled() => break,
            accepted = listener.accept() => accepted?,
        };
        let service = TowerToHyperService::new(
            app.clone()
                .map_request(|request: Request<Incoming>| request.map(Body::new)),
        );
        let cancelled = shutdown.clone();
        let header_read_timeout = limits.header_read_timeout;
        let connection_shutdown_timeout = limits.connection_shutdown_timeout;
        connections.spawn(async move {
            let _permit = permit;
            let mut builder = http1::Builder::new();
            builder
                .timer(TokioTimer::new())
                .header_read_timeout(header_read_timeout)
                .max_headers(64)
                .max_buf_size(64 * 1024);
            let connection = builder.serve_connection(TokioIo::new(socket), service);
            tokio::pin!(connection);
            tokio::select! {
                result = &mut connection => {
                    if let Err(error) = result { tracing::debug!(%error,"HTTP connection ended"); }
                }
                _ = cancelled.cancelled() => {
                    connection.as_mut().graceful_shutdown();
                    let _ = tokio::time::timeout(connection_shutdown_timeout, &mut connection).await;
                }
            }
        });
    }
    drop(listener);
    if tokio::time::timeout(limits.server_shutdown_timeout, async {
        while connections.join_next().await.is_some() {}
    })
    .await
    .is_err()
    {
        connections.abort_all();
        while connections.join_next().await.is_some() {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;
    use axum::routing::get;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpStream,
        sync::Notify,
        task::JoinHandle,
    };

    struct Server {
        address: std::net::SocketAddr,
        shutdown: CancellationToken,
        task: JoinHandle<std::io::Result<()>>,
    }

    impl Server {
        async fn start(app: Router, limits: Limits) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let shutdown = CancellationToken::new();
            let task = tokio::spawn(serve_with_limits(listener, app, shutdown.clone(), limits));
            Self {
                address,
                shutdown,
                task,
            }
        }

        async fn stop(self) {
            self.shutdown.cancel();
            tokio::time::timeout(Duration::from_secs(2), self.task)
                .await
                .unwrap()
                .unwrap()
                .unwrap();
        }
    }

    fn limits(max_connections: usize, header_timeout_ms: u64) -> Limits {
        Limits {
            max_connections,
            header_read_timeout: Duration::from_millis(header_timeout_ms),
            connection_shutdown_timeout: Duration::from_millis(100),
            server_shutdown_timeout: Duration::from_millis(300),
        }
    }

    async fn request(address: std::net::SocketAddr, path: &str) -> TcpStream {
        let mut stream = TcpStream::connect(address).await.unwrap();
        stream
            .write_all(
                format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
        stream
    }

    async fn response(stream: &mut TcpStream) -> Vec<u8> {
        let mut bytes = Vec::new();
        tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut bytes))
            .await
            .unwrap()
            .unwrap();
        bytes
    }

    fn held_response(entered: Arc<Notify>, release: Arc<Notify>) -> Router {
        Router::new().route("/ok", get(|| async { "ready" })).route(
            "/hold",
            get(move || {
                let entered = entered.clone();
                let release = release.clone();
                async move {
                    entered.notify_one();
                    release.notified().await;
                    "finished"
                }
            }),
        )
    }

    #[tokio::test]
    async fn connections_wait_for_capacity_and_resume_after_release() {
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let server = Server::start(
            held_response(entered.clone(), release.clone()),
            limits(1, 1000),
        )
        .await;
        let mut first = request(server.address, "/hold").await;
        tokio::time::timeout(Duration::from_secs(1), entered.notified())
            .await
            .unwrap();
        let mut second = request(server.address, "/ok").await;
        let mut byte = [0_u8; 1];
        assert!(
            tokio::time::timeout(Duration::from_millis(75), second.read(&mut byte))
                .await
                .is_err()
        );

        release.notify_one();
        assert!(String::from_utf8_lossy(&response(&mut first).await).ends_with("finished"));
        assert!(String::from_utf8_lossy(&response(&mut second).await).ends_with("ready"));
        server.stop().await;
    }

    #[tokio::test]
    async fn partial_headers_expire_and_release_connection_capacity() {
        let calls = Arc::new(AtomicUsize::new(0));
        let called = calls.clone();
        let app = Router::new().route(
            "/ok",
            get(move || {
                let called = called.clone();
                async move {
                    called.fetch_add(1, Ordering::SeqCst);
                    "ready"
                }
            }),
        );
        let server = Server::start(app, limits(1, 60)).await;
        let mut slow = TcpStream::connect(server.address).await.unwrap();
        slow.write_all(b"GET /ok HTTP/1.1\r\nHost: localhost\r\n")
            .await
            .unwrap();
        let _ = response(&mut slow).await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);

        let mut complete = request(server.address, "/ok").await;
        assert!(String::from_utf8_lossy(&response(&mut complete).await).ends_with("ready"));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        server.stop().await;
    }

    #[tokio::test]
    async fn graceful_shutdown_finishes_an_in_flight_response() {
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let server = Server::start(
            held_response(entered.clone(), release.clone()),
            limits(1, 1000),
        )
        .await;
        let mut stream = request(server.address, "/hold").await;
        tokio::time::timeout(Duration::from_secs(1), entered.notified())
            .await
            .unwrap();
        server.shutdown.cancel();
        release.notify_one();
        assert!(String::from_utf8_lossy(&response(&mut stream).await).ends_with("finished"));
        server.stop().await;
    }

    #[tokio::test]
    async fn graceful_shutdown_is_bounded_when_a_handler_never_finishes() {
        let entered = Arc::new(Notify::new());
        let never_released = Arc::new(Notify::new());
        let server = Server::start(
            held_response(entered.clone(), never_released),
            limits(1, 1000),
        )
        .await;
        let mut stream = request(server.address, "/hold").await;
        tokio::time::timeout(Duration::from_secs(1), entered.notified())
            .await
            .unwrap();
        server.shutdown.cancel();
        assert!(response(&mut stream).await.is_empty());
        server.stop().await;
    }
}
