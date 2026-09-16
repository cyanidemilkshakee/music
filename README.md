# Local Amp

Local Amp is a local-only music player for browsing, organizing, and playing a folder of audio files. The Rust backend indexes metadata with `ffprobe`, stores the library and playlists in SQLite, and serves a browser-based player.

The application does not use runtime CDN assets or send library data to an external service.

## Requirements

- Rust (the stable toolchain)
- FFmpeg and FFprobe available on `PATH`, or paths configured in `.env`
- On Windows, the MSVC C++ Build Tools with the Desktop development with C++ workload

## Setup

Optional configuration starts from the provided example:

```powershell
Copy-Item .env.example .env
```

Start the player:

```powershell
Set-Location backend
cargo run --release
```

Open [http://localhost:1111](http://localhost:1111). `npm start` remains available as a convenience alias for the same command.

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

1. Select **Add Folder**, then choose a folder with the native Windows picker, drag a folder from File Explorer, or enter an absolute path. Imported folders are kept as saved sources for one-click rescans.
2. Import progress is streamed to the interface. A failed scan reports its error without leaving the sheet waiting.
3. Use the filter panel to narrow the library by genre, year, codec, duration, favorites, or recently played tracks.
4. Choose a track to play it. The queue persists between sessions, supports drag-and-drop reordering, and has a full track-details view with embedded metadata and lyrics when available.
5. Use the sidebar to create playlists and the track context menu to add tracks or refresh metadata.

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
