# Local Amp

Local Amp is a local-only music player for browsing, organizing, and playing a folder of audio files. The Rust backend indexes metadata with `ffprobe`, stores the library and playlists in SQLite, and serves a browser-based player.

The application does not use runtime CDN assets or send library data to an external service.

## Requirements

- Rust (the stable toolchain)
- FFmpeg and FFprobe available on `PATH`, or paths configured in `.env`
- Node.js and npm to use the convenience scripts
- On Windows, the MSVC C++ Build Tools with the Desktop development with C++ workload

## Setup

Optional configuration starts from the provided example:

```powershell
Copy-Item .env.example .env
```

Start the player:

```powershell
npm start
```

Open [http://localhost:1111](http://localhost:1111).

You can also start the backend directly:

```powershell
Set-Location backend
cargo run --release
```

## Local-only behavior

Local Amp listens on `127.0.0.1` by default. The `HOST` value must be a loopback address such as `127.0.0.1` or `::1`; network-facing addresses are rejected. This protects the API, which has access to local library paths and playlist data.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `1111` | Local HTTP port. |
| `HOST` | `127.0.0.1` | Loopback address used by the server. |
| `DATA_DIR` | `data` | SQLite database and decoded-audio cache location. |
| `FFMPEG_PATH` | `ffmpeg` | FFmpeg executable or absolute path. |
| `FFPROBE_PATH` | `ffprobe` | FFprobe executable or absolute path. |
| `LOW_LATENCY_STREAMING` | `true` | Stream a track through FFmpeg as it plays. Set to `false` to decode the full track into the local cache first. |
| `SCAN_CONCURRENCY` | `4` | Maximum simultaneous metadata probes during import. |
| `TRANSCODE_CONCURRENCY` | `2` | Maximum simultaneous full-track decodes. |
| `MAX_SCAN_FILES` | `100000` | Upper limit on audio files considered in one import. |
| `MAX_SCAN_FAILURES` | `10000` | Upper limit on individual import failures retained for reporting. |
| `FFPROBE_TIMEOUT_MS` | `10000` | Per-file metadata probe timeout. |
| `FFMPEG_TIMEOUT_MS` | `3600000` | Full decode timeout. |
| `JSON_LIMIT` | `2mb` | Maximum JSON request-body size. Allowed values: `1mb`, `2mb`, `5mb`, and `10mb`. |
| `MAX_CONCURRENT_REQUESTS` | `512` | Maximum active server requests. |

## Using the player

1. Open the import sheet and enter an absolute path to a music folder.
2. Select **Import Folder**. Import progress is streamed to the interface.
3. Choose a track to play it. With the default streaming mode, playback can begin before the full track is transcoded.
4. Use the sidebar to create playlists and the track context menu to add tracks or refresh metadata.

Imports report a terminal error when a folder cannot be opened, rather than leaving the interface waiting for progress.

## Development and verification

```powershell
npm test
npm run lint
npm run build
```

`npm test` runs the backend integration suite using isolated ports and temporary database directories. `npm run lint` runs Clippy with warnings treated as errors.

## Troubleshooting

If the health endpoint reports FFmpeg or FFprobe as unavailable, install FFmpeg and ensure both commands work from the same PowerShell session that starts Local Amp. You can also set `FFMPEG_PATH` and `FFPROBE_PATH` to absolute executable paths in `.env`.

If an import reports skipped tracks, the first metadata or filesystem error is shown in the import status. Confirm that the folder exists, is readable by the account running Local Amp, and contains supported audio files.
