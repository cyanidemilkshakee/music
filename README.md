# Local Amp

Local Amp is a local music library and browser player for Windows. It indexes your music with FFprobe, keeps metadata, playlists, favorites and saved folders in SQLite, and serves the interface from one Rust executable. It has no runtime CDN or cloud account requirement.

## Windows installer

Run **LocalAmp-Setup-1.1.0.exe** from **dist**, then open **Local Amp** from the Start menu. Installation is per user and does not require administrator access. Rust, Node.js and C++ build tools are not required to run the installed app. Windows release builds link the C runtime statically and verify DLL imports before packaging.

FFmpeg and FFprobe are external prerequisites and are **not bundled**. Install a trusted FFmpeg distribution and make both commands available on PATH, or set the **FFMPEG_PATH** and **FFPROBE_PATH** environment variables to absolute local executable paths. The backend resolves each command once at startup to an absolute local file; PATH search skips empty, relative, current-directory, network and filesystem redirect entries. Explicit paths must identify local executable files without symbolic links or reparse points; Windows tools must be **.exe** files. The launcher also validates tool paths before starting the backend. Restart Local Amp after changing them. Missing tools leave the app available with actionable diagnostics, and manual folder entry remains available if the Windows picker is unavailable.

The launcher uses [http://127.0.0.1:1111](http://127.0.0.1:1111) and stores library data in **%LOCALAPPDATA%\LocalAmp**. Open **Local Amp** from the Start menu to authorize a browser tab. Before connecting, the launcher verifies that the listening process has the expected executable path and belongs to your Windows account. The backend creates owner-protected **launch.json** and **launch.html** files. The launcher opens the private HTML page so the credential stays out of browser process arguments; the page redirects using a URL fragment that the interface immediately removes. Keep both files private and never share a launch URL. The interface is embedded in the executable, so it works regardless of the working directory. Upgrades and uninstall preserve this data directory. Closing the browser leaves the local server running; use **Stop Local Amp server** in Settings before replacing it manually. The installer uses Windows application-close handling during upgrades.

Release packaging requires a trusted Authenticode code-signing certificate with its private key. The build signs and timestamps the server, launcher, installer and uninstaller, then verifies the signatures. An explicit **-AllowUnsigned** option creates a local development installer; the release workflow never accepts unsigned artifacts. No certificate or signing key is included in the repository. Complete clean-machine testing before publication.

## Use

- **Add Folder** opens the Windows picker or accepts an absolute local folder path. A local file URL dropped from Explorer also works when the browser supplies that path; remote shares, device paths and ordinary browser folder drops without a local path are refused.
- Scan progress survives page reloads. **Cancel scan** stops an active job; the result and bounded failure report stay available. A completed rescan skips unchanged files, recognizes unambiguous file moves, and marks missing files without discarding playlist/favorite references. Reconnect unavailable folders before rescanning.
- Browse songs, artists, albums or playlists using server-side pages, search and sorting. Filters apply to the displayed collection and its play action. Album artist plus album title separates unrelated albums while keeping tagged compilations together.
- A single click focuses a song. Use its Play button, double-click, or press Enter/Space on a focused song to play it. The global keyboard shortcuts leave native buttons, inputs and dialogs alone.
- Playlist Move up/down actions persist order. The queue supports repeated songs, drag reorder, Move up/down and removal.
- **Library & Playback** (Settings on narrow screens) contains library totals, top genres, recently played tracks, missing-file warnings, tool/database diagnostics, cache controls, quality, optional ReplayGain attenuation, backup/restore, and M3U import. Song information exposes codec, bitrate, sample rate, bit depth and path; removing an entry never deletes the audio file.
- The queue, shuffle, repeat, volume, layout and saved position persist in the browser. Reopening restores a paused track; press Play to resume. Media Session controls integrate with supported system/browser media keys.

Supported originals play directly with byte-range seeking. Unsupported originals use a completed, seekable FLAC conversion when the browser supports it. **MP3 compatibility** explicitly selects lossy conversion. The player shows its active playback path; fallback conversion may take time for long tracks.

Continuous, sample-accurate gapless playback is not guaranteed by the current HTML audio player. ReplayGain uses track gain/peak tags to attenuate safely; it does not analyze untagged music or boost above unity. Surround audio is preserved by direct/lossless paths subject to browser and output-device support; MP3 compatibility can be unsuitable for multichannel sources.

## Backups

When moving from a source checkout to the installer, export a JSON backup from the existing app, add your music folders in the installed app, then restore the backup. The repository data directory and installed per-user directory are separate; installation does not move or delete the checkout library.

Download a JSON backup in Settings before major library changes. It contains metadata, absolute music paths, sources, playlists, favorites and recent tracks, **not audio files or browser preferences**. Keep it private if local filenames are sensitive.

Restore performs an atomic merge: it adds validated audio entries in independently approved library folders, maps matching paths to existing track IDs, preserves existing playlists with matching IDs, and skips unknown references. A backup's own source list cannot authorize a new folder: use **Add Folder** first. Missing supported files within approved folders keep their unavailable metadata for later reconnection and rescan. Network/device paths and non-audio files are refused. M3U import accepts absolute paths to tracks already indexed; unknown paths are reported as skipped and are not fetched. Export M3U from All Playlists. Settings checks the selected file's size **before reading it**, then checks the UTF-8 size of the actual JSON request, including escaped M3U text, before uploading.

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

Cargo output in **backend/target** is local build cache and can grow across debug, release and verification builds. It is ignored by Git. To reclaim that space, run `node scripts/clean-rust-artifacts.js` from the repository root. This removes only **backend/target**, including custom verification build folders; the next Rust build will compile its artifacts again. Run it when the cache has grown, not after every build.

Development binaries under **backend/target** default to this repository's **data** directory to retain existing libraries. Distributed binaries default to the per-user directory. **DATA_DIR** overrides both; relative overrides resolve against the server working directory.

Optional configuration: copy **.env.example** to **.env**. Environment variables take precedence. Use absolute paths for data/tools. The server must bind to a loopback address; it validates local Host/Origin, rejects cross-site requests, and requires the private launch credential in **x-local-amp-token** for all API and metrics requests. Browser credentials remain in sessionStorage for this origin and tab; they are not set as HTTP cookies or put in HTTP query strings. Native audio, artwork and metrics links use narrowly scoped signed URLs rather than the broad session credential. Other local accounts cannot retrieve the credential through an anonymous session request; processes running as your own account can read your files and remain within the same trust boundary.

Create a Windows installer with the verified official **Inno Setup 7.1.0** compiler and, for signing, the Microsoft Windows SDK SignTool. Import your real code-signing certificate into **Cert:\CurrentUser\My** and use its thumbprint:

~~~powershell
powershell -NoProfile -File scripts/Build-WindowsInstaller.ps1 -CertificateThumbprint 'YOUR_40_HEX_DIGIT_CERTIFICATE_THUMBPRINT'
# Unsigned local development only:
npm run installer -- -AllowUnsigned
~~~

Installer verification: run **scripts/Test-WindowsInstaller.ps1 -RequireSignature** in a disposable Windows profile with no existing Local Amp installation. It checks trusted signatures, install, upgrade, authorized API access, relaunch, graceful stop, uninstall and retained test data under TEMP. Omit **-RequireSignature** only when testing an explicitly unsigned local development installer. **scripts/Test-WindowsLauncher.ps1 -Executable 'C:\Path\To\LocalAmp.exe'** separately verifies rejection of spoofed services and unsigned release packaging without using an existing library.

GitHub Actions is configured for frontend unused-code/import/asset checks, formatting, all-target Clippy, unit/integration tests, isolated Chromium browser/API smoke tests, benchmarks and release builds on Windows/Linux/macOS, plus dependency/license policy checks. Actions are pinned to verified full commit hashes; CI uses Node.js **22.23.3**, Windows FFmpeg **9.0.2**, and a hash- and publisher-verified Inno Setup **7.1.0** download. The manual Windows installer workflow requires a real signing credential in the protected **windows-release** environment and uploads a verified artifact without publishing a release. Configure **LOCAL_AMP_SIGNING_PFX_BASE64** and **LOCAL_AMP_SIGNING_PFX_PASSWORD** as environment secrets for an exportable certificate supported by your issuer; hardware/service-backed credentials require that provider's protected runner integration. Do not export hardware-protected keys. The workflow imports the certificate temporarily and removes it after the job. Only Windows runtime and installer behavior were verified locally; Linux/macOS builds and manual-path imports remain experimental until their CI results and runtime checks are available. Their native picker is intentionally unavailable.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| HOST | 127.0.0.1 | Loopback bind address; remote interfaces rejected. |
| PORT | 1111 | Port from 1 to 65535. |
| DATA_DIR | See above | Persistent SQLite database and cache directory. |
| FFMPEG_PATH / FFPROBE_PATH | ffmpeg / ffprobe | Simple executable name resolved from absolute local PATH directories, or an absolute local executable file. Relative paths, remote paths and filesystem redirects are rejected. |
| SCAN_CONCURRENCY | 4 | Simultaneous scan tasks, 1-32. |
| TRANSCODE_CONCURRENCY | 2 | Simultaneous cached conversions, 1-8. |
| STREAM_CONCURRENCY | 8 | Shared process budget for probes, conversions, artwork, health and picker, 1-32. |
| CACHE_MAX_MB | 1024 | Aggregate audio/artwork cache and conversion reservation budget, 16-100000 MiB. Active temporary files and in-use media are protected from eviction. |
| TRANSCODE_MAX_MB | 512 | Live output limit per conversion, 1-100000 MiB, capped by CACHE_MAX_MB. Oversized conversions are stopped and their temporary output is removed. |
| CACHE_MIN_FREE_MB | 256 | Free disk reserve required for new conversions, 0-100000 MiB. |
| MAX_SCAN_FILES | 100000 | Per-scan file cap, 1-1000000. Partial scans do not mark unseen tracks missing. |
| MAX_SCAN_FAILURES | 10000 | Failure-detail retention cap; total failure counts remain accurate. |
| MAX_SCAN_ENTRIES | 1000000 | Total filesystem entries inspected per scan, 1-10000000. |
| MAX_SCAN_DIRECTORIES | 100000 | Directories visited per scan, 1-1000000. |
| MAX_SCAN_HASH_MB | 524288 | Total bytes fingerprinted per scan, 1-10485760 MiB. |
| MAX_SCAN_FILE_MB | 8192 | Largest file admitted to scan fingerprinting, 1-1048576 MiB. |
| FINGERPRINT_TIMEOUT_MS | 30000 | Per-file fingerprint deadline, 1000-600000 ms. |
| SCAN_TIMEOUT_MS | 1800000 | Full scan deadline, 1000-86400000 ms. |
| FFPROBE_TIMEOUT_MS | 10000 | Probe/artwork timeout, 1000-600000 ms. |
| FFMPEG_TIMEOUT_MS | 3600000 | Conversion timeout, 1000-3600000 ms. |
| JSON_LIMIT | 20mb | JSON request limit: 1, 2, 5, 10, 20, 50 or 100 MB. Increase for larger backups. |
| MAX_CONCURRENT_REQUESTS | 512 | Active handler cap, 1-10000. Audio bodies separately hold STREAM_CONCURRENCY permits until closed; request-body buffering is capped at eight requests. |
| MAX_CONNECTIONS | 128 | Concurrent accepted TCP connection cap, 1-2048. |
| REQUEST_READ_TIMEOUT_MS | 30000 | HTTP request read deadline, 1000-120000 ms. |

## API and diagnostics

Authenticated GET **/api/health** reports configured import limits and database/tool status (503 when prerequisites are unavailable); authenticated **/api/session** identifies the app/version and returns the existing session token and scoped metrics link. Anonymous **/api/identity** only supplies app, version and process ID for readiness checks. GET **/api/state** keeps its full-library response for compatibility. The UI uses **/api/state?includeTracks=false** for the library ID index, playlists, favorites, recent IDs and filter facets, then requests metadata pages from **/api/library/tracks** (limit 1-1000). Search, filters, sorting, album/artist groups and playlist scope run on the server; ordered matching IDs preserve the full playback context across pages. Metadata for queue pages and tracks outside the current view is loaded in batches. See the [query contract](docs/API_CONTRACT.md).

Playlist creation POST **/api/playlists** accepts a name; PATCH **/api/playlists/{id}** accepts only a required name. Add tracks with POST **/api/playlists/{id}/tracks**, replace/reorder them atomically with PUT **/api/playlists/{id}/tracks**, and set a track's playlist memberships with PUT **/api/tracks/{id}/playlists**. Unknown IDs fail without partial changes.

POST **/api/scan** accepts an absolute directory; GET **/api/scan/{jobId}** reads its snapshot, GET **/api/scan/{jobId}/stream** streams progress, and POST **/api/scan/{jobId}/cancel** cancels. The last 32 jobs are retained; interrupted jobs become failed after restart.

API errors use JSON with error and optional detail; **x-request-id** correlates responses and logs. **/metrics** exposes HTTP latency/status and media process/cache counters locally. Launcher logs are in the data directory. If playback fails, check file availability and tool diagnostics, then use Retry. After changing metadata, Refresh metadata also versions the artwork URL.

Source code is [MIT licensed](LICENSE). The installer also includes the dependency license texts and Rust standard-library notices; see [third-party notices](THIRD_PARTY_NOTICES.md). Browser tests generate their own music and database under TEMP; they never use your library.
