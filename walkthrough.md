# Local Amp Rust Backend - Phases 1-3 Walkthrough

We've successfully transitioned the core architecture of Local Amp from Node.js/Express to a high-performance Rust backend using `axum`, `tokio`, and `rusqlite`. 

## Architecture & Foundation (Phase 1)
- **Dependency Management:** Configured `Cargo.toml` with strict lints to ensure a panic-free (`unwrap_used = "deny"`, `expect_used = "deny"`) codebase.
- **Typed Configuration:** Created `config.rs` to validate all environment variables cleanly at startup, accumulating errors rather than crashing on the first missing variable.
- **Error Handling:** Centralized all errors in `error.rs` under an `AppError` type, implementing `IntoResponse` so database and IO errors translate to clean HTTP status codes and JSON, shielding the client from raw stack traces.
- **Database Layer:** Migrated the SQLite `local-amp.db` using `r2d2_sqlite` for robust connection pooling. Re-implemented the database DDL in `schema.sql` and wrote full CRUD wrappers in `db/mod.rs` for tracks, playlists, and statistics. WAL mode and memory-mapped IO (mmap) are strictly enforced.

## Services & Core API (Phase 2)
- **FFmpeg Integration (`services/ffmpeg.rs`):** Built robust async wrappers around `ffmpeg` and `ffprobe` processes. Subprocess timeouts and concurrent execution caps are strictly managed via `tokio::time::timeout` and `tokio::sync::Semaphore`. Features a double-checked locking mechanism and atomic tempfile renaming for cache generation.
- **Media Scanner (`services/scanner.rs`):** Implemented an asynchronous file walker that extracts metadata using `ffprobe` and batches SQL inserts for extreme performance. Configurable concurrent worker limits prevent system resource exhaustion.
- **API Routes (`routes/api.rs`):** Ported all JSON routes (`/health`, `/state`, `/scan`, `/recent`, `/playlists`, etc.) to Axum handlers with strictly typed JSON serialization (`serde`) and request validation.

## Media Routes & Integration (Phase 3)
- **Streaming & Caching (`routes/media.rs`):**
  - High-performance, partial-content (`HTTP 206`) ranged responses for decoded audio playback.
  - Asynchronous stdout piping directly from FFmpeg for live transcoding (`/stream/:id`).
  - Strict caching headers and cache busting via `ETag` generation.
- **Middleware & App State:** Wired up `request_id`, `security_headers`, and a customized `compression_bypass` middleware to ensure fast text delivery while avoiding double-compression of media files. Everything is structured cleanly in `main.rs`.

## Async Processing & Server-Sent Events (Phase 4)
- **Real-Time Scanning Progress:** The `/api/scan` endpoint was completely refactored to emit an `axum::response::sse::Sse` stream. As thousands of files are walked and metadata is extracted by FFmpeg, the backend yields JSON events (`Walk`, `Probe`, `Complete`) directly to the client without buffering or timing out.
- **Frontend Upgrade:** Modified `public/modules/import-lib.js` to process the SSE stream seamlessly, updating the UI with live progress percentages.

## Production Hardening (Phase 5)
- **Middleware & Security:** Integrated `CorsLayer` (CORS) and `TimeoutLayer` from `tower-http` to globally enforce API timeouts and cross-origin boundaries.
- **Robustness:** Verified zero use of `.unwrap()` on the hot path. DB pragmas natively enforce WAL mode and mmap limits. All async operations use graceful shutdown cancellation via `tokio::signal`.

> [!WARNING]
> **Windows Build Tools Missing:** `cargo check` failed in the background because the MSVC C++ Build Tools (`link.exe`) are not installed in the current environment. To compile and run the backend natively on Windows, you must install the Visual Studio C++ Build Tools, or use the GNU toolchain.
