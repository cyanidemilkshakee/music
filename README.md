# Local Amp

Local Amp is a local music library and browser player for Windows. It indexes your music with FFprobe, keeps metadata, playlists, favorites and saved folders in SQLite, and serves the interface from one Rust executable. It has no runtime CDN or cloud account requirement.

## Windows installer

Run **LocalAmp-Setup-1.1.0.exe** from **dist**, then open **Local Amp** from the Start menu. Installation is per user and does not require administrator access. Rust, Node.js and C++ build tools are not required to run the installed app. Windows release builds link the C runtime statically and verify DLL imports before packaging.

FFmpeg and FFprobe are external prerequisites and are **not bundled**. Install a trusted FFmpeg distribution and make both commands available on PATH, or set the **FFMPEG_PATH** and **FFPROBE_PATH** environment variables to absolute executable paths. Restart Local Amp after changing them. The app reports missing tools and retains manual folder entry if the Windows picker is unavailable.

The launcher uses [http://127.0.0.1:1111](http://127.0.0.1:1111) and stores library data in **%LOCALAPPDATA%\LocalAmp**. The interface is embedded in the executable, so it works regardless of the working directory. Upgrades and uninstall preserve this data directory. Closing the browser leaves the local server running; use **Stop Local Amp server** in Settings before replacing it manually. The installer uses Windows application-close handling during upgrades.

The locally built installer is unsigned. Public distribution should use an Authenticode signing certificate and complete clean-machine testing before publication.

## Use

- **Add Folder** opens the Windows picker or accepts an absolute folder path. A file URL dropped from Explorer also works when the browser supplies that path; ordinary browser folder drops may not expose it.
- Scan progress survives page reloads. **Cancel scan** stops an active job; the result and bounded failure report stay available. A completed rescan skips unchanged files, recognizes unambiguous file moves, and marks missing files without discarding playlist/favorite references. Reconnect unavailable folders before rescanning.
- Browse songs, artists, albums or playlists using server-side pages, search and sorting. Filters apply to the displayed collection and its play action. Album artist plus album title separates unrelated albums while keeping tagged compilations together.
- A single click focuses a song. Use its Play button, double-click, or press Enter/Space on a focused song to play it. The global keyboard shortcuts leave native buttons, inputs and dialogs alone.
- Playlist Move up/down actions persist order. The queue supports repeated songs, drag reorder, Move up/down and removal.
- **Library & Playback** (Settings on narrow screens) contains library totals, top genres, recently played tracks, missing-file warnings, tool/database diagnostics, cache controls, quality, optional ReplayGain attenuation, backup/restore, and M3U import. Song information exposes codec, bitrate, sample rate, bit depth and path; removing an entry never deletes the audio file.
- The queue, shuffle, repeat, volume, layout and saved position persist in the browser. Reopening restores a paused track; press Play to resume. Media Session controls integrate with supported system/browser media keys.

Supported originals play directly with byte-range seeking. Unsupported originals use a completed, seekable FLAC conversion when the browser supports it. **MP3 compatibility** explicitly selects lossy conversion. The player shows its active playback path; fallback conversion may take time for long tracks.

Continuous, sample-accurate gapless playback is not guaranteed by the current HTML audio player. ReplayGain uses track gain/peak tags to attenuate safely; it does not analyze untagged music or boost above unity. Surround audio is preserved by direct/lossless paths subject to browser and output-device support; MP3 compatibility can be unsuitable for multichannel sources.

## Backups

When moving from a source checkout to the installer, export a JSON backup from the existing app and restore it in the installed app. The repository data directory and installed per-user directory are separate; installation does not move or delete the checkout library.

Download a JSON backup in Settings before major library changes. It contains metadata, absolute music paths, sources, playlists, favorites and recent tracks, **not audio files or browser preferences**. Keep it private if local filenames are sensitive.

Restore performs an atomic merge: it adds missing entries, maps matching paths to existing track IDs, preserves existing playlists with matching IDs, and skips unknown references. Music files must exist at their original paths, or be reconnected and rescanned. M3U import accepts absolute paths to tracks already indexed; unknown paths are reported as skipped and are not fetched. Export M3U from All Playlists. Settings displays the configured import limits and checks the UTF-8 size of the actual JSON request, including escaped M3U text, before uploading.

For a full local snapshot, stop the server and copy the data directory, including the SQLite database. Do not copy a live WAL-mode database by itself.

## Source development

Use Rust **1.97.1**, Node.js **22.13 or newer supported LTS**, FFmpeg/FFprobe, and (on Windows) the MSVC C++ build tools. The repository pins Rust and commits Cargo.lock. npm dependencies are development-only lint and browser-test tooling; the installed application has no Node.js runtime dependency.

~~~powershell
npm ci --ignore-scripts
npm run dev
npm run lint
npm test
npm run test:api
npx playwright install chromium
npm run test:browser
npm run bench
npm run build
~~~

Development binaries under **backend/target** default to this repository's **data** directory to retain existing libraries. Distributed binaries default to the per-user directory. **DATA_DIR** overrides both; relative overrides resolve against the server working directory.

Optional configuration: copy **.env.example** to **.env**. Environment variables take precedence. Use absolute paths for data/tools. The server must bind to a loopback address; it validates local Host/Origin, rejects cross-site requests, and requires the **/api/session** token in **x-local-amp-token** for mutations.

Create a Windows installer with the official Inno Setup 6 or 7 compiler:

~~~powershell
npm run installer
# Or:
powershell -NoProfile -File scripts/Build-WindowsInstaller.ps1 -Compiler 'C:\Path\To\ISCC.exe'
~~~

Installer verification: run **scripts/Test-WindowsInstaller.ps1** in a disposable Windows profile with no existing Local Amp installation. It checks install, upgrade, relaunch, graceful stop, uninstall and retained test data under TEMP.

GitHub Actions is configured for frontend unused-code/import/asset checks, formatting, all-target Clippy, unit/integration tests, isolated Chromium browser/API smoke tests, benchmarks and release builds on Windows/Linux/macOS, plus dependency/license policy checks. The manual Windows installer workflow uploads an artifact without publishing a release. Only Windows runtime and installer behavior were verified locally; Linux/macOS builds and manual-path imports remain experimental until their CI results and runtime checks are available. Their native picker is intentionally unavailable.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| HOST | 127.0.0.1 | Loopback bind address; remote interfaces rejected. |
| PORT | 1111 | Port from 1 to 65535. |
| DATA_DIR | See above | Persistent SQLite database and cache directory. |
| FFMPEG_PATH / FFPROBE_PATH | ffmpeg / ffprobe | Tool command or absolute path. |
| SCAN_CONCURRENCY | 4 | Simultaneous scan tasks, 1-32. |
| TRANSCODE_CONCURRENCY | 2 | Simultaneous cached conversions, 1-8. |
| STREAM_CONCURRENCY | 8 | Shared process budget for probes, conversions, artwork, health and picker, 1-32. |
| CACHE_MAX_MB | 1024 | Audio/artwork cache budget, 16-100000 MB. In-use files may delay eviction. |
| MAX_SCAN_FILES | 100000 | Per-scan file cap, 1-1000000. Partial scans do not mark unseen tracks missing. |
| MAX_SCAN_FAILURES | 10000 | Failure-detail retention cap; total failure counts remain accurate. |
| FFPROBE_TIMEOUT_MS | 10000 | Probe/artwork timeout, 1000-600000 ms. |
| FFMPEG_TIMEOUT_MS | 3600000 | Conversion timeout, 1000-3600000 ms. |
| JSON_LIMIT | 20mb | JSON request limit: 1, 2, 5, 10, 20, 50 or 100 MB. Increase for larger backups. |
| MAX_CONCURRENT_REQUESTS | 512 | Active HTTP request cap, 1-10000. |

## API and diagnostics

GET **/api/health** reports configured import limits and database/tool status (503 when prerequisites are unavailable); **/api/session** identifies the app/version and supplies the mutation token. GET **/api/state** keeps its full-library response for compatibility. The UI uses **/api/state?includeTracks=false** for the library ID index, playlists, favorites, recent IDs and filter facets, then requests metadata pages from **/api/library/tracks** (limit 1-1000). Search, filters, sorting, album/artist groups and playlist scope run on the server; ordered matching IDs preserve the full playback context across pages. Metadata for queue pages and tracks outside the current view is loaded in batches. See the [query contract](docs/API_CONTRACT.md).

Playlist creation POST **/api/playlists** accepts a name; PATCH **/api/playlists/{id}** accepts only a required name. Add tracks with POST **/api/playlists/{id}/tracks**, replace/reorder them atomically with PUT **/api/playlists/{id}/tracks**, and set a track's playlist memberships with PUT **/api/tracks/{id}/playlists**. Unknown IDs fail without partial changes.

POST **/api/scan** accepts an absolute directory; GET **/api/scan/{jobId}** reads its snapshot, GET **/api/scan/{jobId}/stream** streams progress, and POST **/api/scan/{jobId}/cancel** cancels. The last 32 jobs are retained; interrupted jobs become failed after restart.

API errors use JSON with error and optional detail; **x-request-id** correlates responses and logs. **/metrics** exposes HTTP latency/status and media process/cache counters locally. Launcher logs are in the data directory. If playback fails, check file availability and tool diagnostics, then use Retry. After changing metadata, Refresh metadata also versions the artwork URL.

Source code is [MIT licensed](LICENSE). The installer also includes the dependency license texts and Rust standard-library notices; see [third-party notices](THIRD_PARTY_NOTICES.md). Browser tests generate their own music and database under TEMP; they never use your library.
