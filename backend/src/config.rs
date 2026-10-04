use std::net::IpAddr;
use std::num::NonZeroUsize;
use std::path::PathBuf;

fn default_data_dir() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // Development preserves the existing library. Distributed binaries use a
    // stable per-user directory, independent of their working directory.
    if std::env::current_exe().is_ok_and(|exe| exe.starts_with(manifest.join("target"))) {
        return manifest.parent().unwrap_or(&manifest).join("data");
    }
    if let Some(base) =
        std::env::var_os("LOCALAPPDATA").or_else(|| std::env::var_os("XDG_DATA_HOME"))
    {
        return PathBuf::from(base).join("LocalAmp");
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join(".local/share/local-amp")
}

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub host: IpAddr,
    pub scan_concurrency: NonZeroUsize,      // 1..=32
    pub transcode_concurrency: NonZeroUsize, // 1..=8
    pub stream_concurrency: NonZeroUsize,    // 1..=32
    pub max_scan_files: NonZeroUsize,        // 1..=1_000_000
    pub max_scan_failures: NonZeroUsize,     // 1..=100_000
    pub json_limit_bytes: usize,             // parsed "2mb" -> bytes
    pub ffmpeg_path: PathBuf,
    pub ffprobe_path: PathBuf,
    pub ffprobe_timeout_ms: u64, // 1_000..=600_000
    pub ffmpeg_timeout_ms: u64,  // 1_000..=3_600_000
    pub data_dir: PathBuf,
    pub cache_max_bytes: u64,
    pub max_concurrent_requests: usize, // default 512
}

impl Config {
    pub fn from_env() -> Result<Self, Vec<String>> {
        let mut errors = Vec::new();

        let port = std::env::var("PORT")
            .unwrap_or_else(|_| "1111".to_string())
            .parse::<u16>()
            .unwrap_or_else(|_| {
                errors.push("PORT must be a valid u16 (e.g. 1111)".to_string());
                1111
            });

        if port == 0 {
            errors.push("PORT must be between 1 and 65535.".to_string());
        }
        let host = std::env::var("HOST")
            .unwrap_or_else(|_| "127.0.0.1".to_string())
            .parse::<IpAddr>()
            .unwrap_or_else(|_| {
                errors.push("HOST must be a valid IP address (e.g. 127.0.0.1)".to_string());
                std::net::IpAddr::V4(std::net::Ipv4Addr::new(127, 0, 0, 1))
            });

        if !host.is_loopback() {
            errors.push("HOST must be a loopback address (127.0.0.1 or ::1); Local Amp does not expose its library over the network.".to_string());
        }

        let scan_concurrency = Self::parse_nonzero("SCAN_CONCURRENCY", 4, 1, 32, &mut errors);
        let transcode_concurrency =
            Self::parse_nonzero("TRANSCODE_CONCURRENCY", 2, 1, 8, &mut errors);
        let stream_concurrency = Self::parse_nonzero("STREAM_CONCURRENCY", 8, 1, 32, &mut errors);
        let max_scan_files =
            Self::parse_nonzero("MAX_SCAN_FILES", 100_000, 1, 1_000_000, &mut errors);
        let max_scan_failures =
            Self::parse_nonzero("MAX_SCAN_FAILURES", 10_000, 1, 100_000, &mut errors);

        let json_limit_bytes = match std::env::var("JSON_LIMIT") {
            Ok(v) => match v.to_lowercase().as_str() {
                "1mb" => 1024 * 1024,
                "2mb" => 2 * 1024 * 1024,
                "5mb" => 5 * 1024 * 1024,
                "10mb" => 10 * 1024 * 1024,
                "20mb" => 20 * 1024 * 1024,
                "50mb" => 50 * 1024 * 1024,
                "100mb" => 100 * 1024 * 1024,
                _ => {
                    errors.push("JSON_LIMIT must be like '1mb', '2mb', '5mb', etc.".to_string());
                    2 * 1024 * 1024
                }
            },
            Err(_) => 20 * 1024 * 1024,
        };

        let ffmpeg_path =
            PathBuf::from(std::env::var("FFMPEG_PATH").unwrap_or_else(|_| "ffmpeg".to_string()));
        let ffprobe_path =
            PathBuf::from(std::env::var("FFPROBE_PATH").unwrap_or_else(|_| "ffprobe".to_string()));

        let ffprobe_timeout_ms =
            Self::parse_u64("FFPROBE_TIMEOUT_MS", 10_000, 1_000, 600_000, &mut errors);
        let ffmpeg_timeout_ms = Self::parse_u64(
            "FFMPEG_TIMEOUT_MS",
            3_600_000,
            1_000,
            3_600_000,
            &mut errors,
        );

        let data_dir = std::env::var_os("DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(default_data_dir);
        let cache_max_bytes =
            Self::parse_u64("CACHE_MAX_MB", 1024, 16, 100_000, &mut errors) * 1024 * 1024;

        let max_concurrent_requests =
            Self::parse_usize("MAX_CONCURRENT_REQUESTS", 512, 1, 10_000, &mut errors);

        if errors.is_empty() {
            Ok(Self {
                port,
                host,
                scan_concurrency,
                transcode_concurrency,
                stream_concurrency,
                max_scan_files,
                max_scan_failures,
                json_limit_bytes,
                ffmpeg_path,
                ffprobe_path,
                ffprobe_timeout_ms,
                ffmpeg_timeout_ms,
                data_dir,
                cache_max_bytes,
                max_concurrent_requests,
            })
        } else {
            Err(errors)
        }
    }

    fn parse_nonzero(
        name: &str,
        default: usize,
        min: usize,
        max: usize,
        errors: &mut Vec<String>,
    ) -> NonZeroUsize {
        let val = Self::parse_usize(name, default, min, max, errors);
        NonZeroUsize::new(val)
            .unwrap_or_else(|| NonZeroUsize::new(default).unwrap_or(NonZeroUsize::MIN))
    }

    fn parse_usize(
        name: &str,
        default: usize,
        min: usize,
        max: usize,
        errors: &mut Vec<String>,
    ) -> usize {
        match std::env::var(name) {
            Ok(v) => match v.parse::<usize>() {
                Ok(val) if val >= min && val <= max => val,
                Ok(_) => {
                    errors.push(format!("{} must be between {} and {}", name, min, max));
                    default
                }
                Err(_) => {
                    errors.push(format!("{} must be a valid integer", name));
                    default
                }
            },
            Err(_) => default,
        }
    }

    fn parse_u64(name: &str, default: u64, min: u64, max: u64, errors: &mut Vec<String>) -> u64 {
        match std::env::var(name) {
            Ok(v) => match v.parse::<u64>() {
                Ok(val) if val >= min && val <= max => val,
                Ok(_) => {
                    errors.push(format!("{} must be between {} and {}", name, min, max));
                    default
                }
                Err(_) => {
                    errors.push(format!("{} must be a valid integer", name));
                    default
                }
            },
            Err(_) => default,
        }
    }
}
