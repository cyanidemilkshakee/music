# Local Amp

Local Amp is a local-only music player inspired by compact album-art-first players. It uses:

- `ffprobe` to extract audio metadata.
- `ffmpeg` to stream-decode local tracks with low startup latency.
- Roboto from `public/assets/fonts/Roboto-Regular.ttf`.
- SQLite in `data/local-amp.db` for the local library, playlists, and recent plays.
- A high-performance Rust backend (`axum` + `tokio`).

## Prerequisites

- **FFmpeg & FFprobe**: Must be installed and available in your `PATH` or configured via `.env`.
- **Rust**: Ensure you have the Rust toolchain installed.
- **Windows Users**: You must have the **MSVC C++ Build Tools** installed (specifically the desktop C++ workload) for the Rust backend to compile successfully natively.

## Configuration

We use environment variables for configuration. Copy the example file and modify as needed:
```powershell
cp .env.example .env
```
*Note: You can tune concurrency limits, ports, and FFmpeg paths in this file.*

## Run

```powershell
npm install
npm start
```

Then open:

```text
http://localhost:1111
```

The server defaults to port `1111`.

Playback defaults to low-latency FFmpeg streaming, so a track can start before the whole file is transcoded. To force the older full decode-to-cache path, edit your `.env` or set the variable inline:

```powershell
$env:LOW_LATENCY_STREAMING="false"
npm start
```

## Use

1. Enter a local music folder path.
2. Click `Import Folder`.
3. Select or play a track.
4. Create playlists from the sidebar plus button.
5. Right-click a track and choose `Refresh Metadata` to refresh its tags.

## Troubleshooting

If import shows `0 tracks imported` and many skipped files, the status line now shows the first `ffprobe` error. The most common cause is a server process started from a restricted environment; close it and run `npm start` from a normal PowerShell window.
