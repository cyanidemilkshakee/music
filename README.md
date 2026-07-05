# Local Amp

Local Amp is a local-only music player inspired by compact album-art-first players. It uses:

- `ffprobe` to extract audio metadata.
- `ffmpeg` to stream-decode local tracks with low startup latency.
- Roboto from `public/assets/fonts/Roboto-Regular.ttf`.
- SQLite in `data/local-amp.db` for the local library, playlists, and recent plays.

## Run

```powershell
npm start
```

Then open:

```text
http://localhost:1111
```

The server listens on port `1111`.

Playback defaults to low-latency FFmpeg streaming, so a track can start before the whole file is transcoded. To force the older full decode-to-cache path:

```powershell
$env:LOW_LATENCY_STREAMING="false"
npm start
```

Useful backend tuning knobs:

```powershell
$env:SCAN_CONCURRENCY="8"
$env:TRANSCODE_CONCURRENCY="4"
$env:MAX_SCAN_FILES="100000"
$env:REQUEST_TIMEOUT_MS="120000"
```

If Windows cannot find FFmpeg from Node, set explicit paths before starting:

```powershell
$env:FFMPEG_PATH="C:\Program Files\ffmpeg\bin\ffmpeg.exe"
$env:FFPROBE_PATH="C:\Program Files\ffmpeg\bin\ffprobe.exe"
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
