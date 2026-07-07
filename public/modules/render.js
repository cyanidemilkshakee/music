// ── Render Functions ─────────────────────────────────────────────────────────
import { state, DEFAULT_COVER } from "./state.js";
import { icons }                from "./icons.js";
import { el }                   from "./dom.js";
import { esc, fmt, coverUrl, trackTitle, trackSubtitle, makeGroupKey, cssEscape } from "./utils.js";
import { groupTracks, groupKindForView, groupSummary } from "./groups.js";
import { activeGroup, activePlaylist, playlistTracks, playlistSummary, firstPlaylistTrack, currentTrack, selectedTrack } from "./helpers.js";
import { getVisibleTracks } from "./sort.js";

// ── Empty State ───────────────────────────────────────────────────────────────
export function toggleEmptyState() {
  const hasTracks = state.tracks.length > 0;
  el.importPanel.classList.toggle("is-hidden", hasTracks);
  el.contentScroll.classList.toggle("is-hidden", !hasTracks);
}

// ── View Title ────────────────────────────────────────────────────────────────
export function renderViewTitle() {
  const group    = activeGroup();
  const playlist = activePlaylist();
  if (group)    { el.viewTitle.textContent = group.name;    return; }
  if (playlist) { el.viewTitle.textContent = playlist.name; return; }
  const titleMap = {
    home: "Home", recent: "Recently Added", artists: "Artists",
    albums: "Albums", songs: "Songs", playlists: "All Playlists", search: "Search Results"
  };
  el.viewTitle.textContent = titleMap[state.activeView] || "Library";
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
export function renderPlaylistsSidebar() {
  el.sidebarPlaylistList.innerHTML = state.playlists.map(p => `
    <li>
      <button class="nav-item ${p.id === state.activePlaylistId ? "is-active" : ""}"
              data-playlist-id="${esc(p.id)}">
        <span>${esc(p.name)}</span>
        <span class="playlist-inline-actions">
          <span class="playlist-mini-action" data-playlist-rename="${esc(p.id)}" title="Rename playlist">${icons.edit || icons.album}</span>
          <span class="playlist-mini-action" data-playlist-delete="${esc(p.id)}" title="Delete playlist">${icons.x}</span>
        </span>
      </button>
    </li>`).join("");
}

export function renderGroupSidebar() {
  // Sidebar group list intentionally left empty (breadcrumb navigation used instead)
}

// ── Playlist Collection Grid ──────────────────────────────────────────────────
function renderPlaylistCollection() {
  el.trackGrid.classList.remove("is-list");
  if (el.listHeaders) el.listHeaders.classList.add("is-hidden");

  if (!state.playlists.length) {
    el.trackGrid.innerHTML = `<div class="empty-grid-message">No playlists yet. Click <strong>+</strong> in the sidebar to create one.</div>`;
    return;
  }

  el.trackGrid.innerHTML = state.playlists.map(playlist => {
    const first   = firstPlaylistTrack(playlist);
    const summary = playlistSummary(playlist);
    return `
      <div class="grid-card group-card" data-playlist-card-id="${esc(playlist.id)}">
        <div class="card-art">
          <img src="${coverUrl(first)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${DEFAULT_COVER}'">
          <div class="card-play" data-playlist-play="true">${icons.play_pause_morph}</div>
        </div>
        <div class="card-copy">
          <div class="card-title">${esc(playlist.name)}</div>
          <div class="card-subtitle">${esc(summary)}</div>
        </div>
        <div class="playlist-card-actions">
          <button class="card-glass-action" data-playlist-rename="${esc(playlist.id)}" type="button">Rename</button>
          <button class="card-glass-action danger" data-playlist-delete="${esc(playlist.id)}" type="button">Delete</button>
        </div>
        <div class="card-meta">Playlist</div>
        <div class="card-duration">${esc(summary)}</div>
      </div>`;
  }).join("");
}

// ── Track / Group Grid ────────────────────────────────────────────────────────
export function renderGrid() {
  if (state.activeView === "playlists" && !state.activePlaylistId) {
    renderPlaylistCollection();
    return;
  }

  const groupType   = groupKindForView();
  const showGroups  = Boolean(groupType && !state.activeGroup);
  const tracks      = getVisibleTracks();
  const isList      = state.layout === "list";

  el.trackGrid.classList.toggle("is-list", isList);
  if (el.listHeaders) {
    const showHeaders = isList && !showGroups && tracks.length > 0;
    el.listHeaders.classList.toggle("is-hidden", !showHeaders);
    if (showHeaders) {
      el.headerCols.forEach(col => {
        const field     = col.dataset.sort;
        const iconSpan  = col.querySelector(".sort-icon");
        const isActive  = state.sortField === field;
        col.classList.toggle("is-active", isActive);
        if (iconSpan) {
          iconSpan.innerHTML = isActive
            ? (state.sortDir === "asc" ? icons["arrow-down"] : icons["arrow-up"])
            : "";
        }
      });
    }
  }

  if (showGroups) {
    const groups = groupTracks(groupType);
    if (!groups.length) {
      el.trackGrid.innerHTML = `<div class="empty-grid-message">No ${groupType === "album" ? "albums" : "artists"} found.</div>`;
      return;
    }
    el.trackGrid.innerHTML = groups.map(g => {
      const meta = g.type === "album"
        ? g.artists.slice(0, 3).join(", ")
        : g.albums.slice(0, 3).join(", ");
      return `
        <div class="grid-card group-card" data-group-type="${g.type}" data-group-key="${esc(g.key)}">
          <div class="card-art">
            <img src="${coverUrl(g.artworkTrack)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${DEFAULT_COVER}'">
            <div class="card-play" data-play-btn="true">${icons.play_pause_morph}</div>
          </div>
          <div class="card-copy">
            <div class="card-title">${esc(g.name)}</div>
            <div class="card-subtitle">${esc(groupSummary(g))}</div>
          </div>
          <div class="card-meta">${esc(meta || groupSummary(g))}</div>
          <div class="card-duration">${g.tracks.length} ${g.tracks.length === 1 ? "song" : "songs"}</div>
        </div>`;
    }).join("");
    return;
  }

  if (!tracks.length) {
    const msg = state.search
      ? `No results for "${esc(state.search)}".`
      : "No tracks found.";
    el.trackGrid.innerHTML = `<div class="empty-grid-message">${msg}</div>`;
    return;
  }

  const audio = el.audio;
  const playlist = activePlaylist();
  el.trackGrid.innerHTML = tracks.map(track => {
    const isCurrent  = track.id === state.currentTrackId;
    const isPlaying  = isCurrent && !audio.paused;
    const isSelected = track.id === state.selectedTrackId;
    const artist     = track.artist || "Unknown Artist";
    const album      = track.album  || "Unknown Album";
    const subtitle   = `<span class="nav-link" data-group-type="artist" data-group-key="${esc(makeGroupKey("artist", artist))}">${esc(artist)}</span>`;
    const meta       = `<span class="nav-link" data-group-type="album" data-group-key="${esc(makeGroupKey("album", album))}">${esc(album)}</span>`;
    return `
      <div class="grid-card ${isCurrent ? "is-active" : ""} ${isSelected ? "is-selected" : ""} ${isPlaying ? "is-playing" : ""}"
           data-track-id="${esc(track.id)}">
        <div class="card-art">
          <img src="${coverUrl(track)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${DEFAULT_COVER}'">
          <div class="card-play" data-play-btn="true">${icons.play_pause_morph}</div>
          <div class="track-card-actions">
            <button class="track-mini-action" data-track-playlist="${esc(track.id)}" title="Add or remove from playlists" aria-label="Add or remove from playlists" type="button">${icons.plus}</button>
            ${playlist ? `<button class="track-mini-action danger" data-track-remove-playlist="${esc(track.id)}" title="Remove from this playlist" aria-label="Remove from this playlist" type="button">${icons.x}</button>` : ""}
          </div>
        </div>
        <div class="card-copy">
          <div class="card-title">${esc(trackTitle(track))}</div>
          <div class="card-subtitle">${subtitle}</div>
        </div>
        <div class="card-meta">${meta}</div>
        <div class="card-duration">${fmt(track.duration)}</div>
      </div>`;
  }).join("");
}

// ── Now Playing Panel ─────────────────────────────────────────────────────────
export function renderNowPlaying() {
  const track = currentTrack() || selectedTrack();
  if (!track) {
    el.trackTitle.textContent  = "Not Playing";
    el.trackArtist.textContent = "Local Amp";
    el.coverImage.src = DEFAULT_COVER;
    el.codecDisplay.textContent = "";
    el.bitrateDisplay.textContent = "";
    // Pill is always visible.
    return;
  }
  el.trackTitle.textContent = trackTitle(track);
  el.trackArtist.innerHTML  = trackSubtitle(track);
  el.coverImage.src = coverUrl(track);
  el.coverImage.onerror = () => {
    el.coverImage.onerror = null;
    el.coverImage.src = DEFAULT_COVER;
  };

  el.codecDisplay.textContent = track.codec ? track.codec : (track.format || '');
  el.bitrateDisplay.textContent = track.bitRate ? `${Math.round(track.bitRate / 1000)} kbps` : '';
}

// ── Transport Controls ──────────────────────────────────────────────────────
export function renderTransport() {
  el.shuffleButton.classList.toggle("is-active", state.shuffle);
  el.repeatButton.classList.toggle("is-active", state.repeat !== "none");

  // Swap the repeat icon: repeat-one has the "1" built into the SVG
  el.repeatButton.innerHTML = state.repeat === "one"
    ? icons["repeat-one"]
    : icons.repeat;

  el.repeatButton.title = state.repeat === "none" ? "Repeat off"
    : state.repeat === "all"  ? "Repeat all"
    : "Repeat one";

  const isLoading = state.buffering && !!state.currentTrackId;
  if (isLoading) {
    el.playButton.innerHTML = icons.spinner;
    el.playButton.classList.add("is-loading");
  } else if (el.audio.paused) {
    el.playButton.innerHTML = icons["play-solid"];
    el.playButton.classList.remove("is-loading");
  } else {
    el.playButton.innerHTML = icons["pause-solid"];
    el.playButton.classList.remove("is-loading");
  }
}

// ── Scrubber / Time ───────────────────────────────────────────────────────────
export function updateProgress() {
  const track    = currentTrack() || selectedTrack();
  let duration   = el.audio.duration;
  if (!Number.isFinite(duration) || isNaN(duration)) duration = track?.duration || 0;
  const current  = el.audio.currentTime || 0;
  const pct      = duration ? Math.max(0, Math.min(100, (current / duration) * 100)) : 0;
  el.currentTime.textContent  = fmt(current);
  el.timeRemaining.textContent = `-${fmt(Math.max(0, duration - current))}`;
  el.scrubberProgress.style.width = `${pct}%`;
  el.scrubberHandle.style.left    = `${pct}%`;
}

// ── Layout Toggle Button ──────────────────────────────────────────────────────
export function renderLayoutToggle() {
  const toList = state.layout !== "list";
  el.layoutToggleButton.innerHTML = icons[toList ? "list" : "grid"];
  el.layoutToggleButton.title = toList ? "Switch to List" : "Switch to Grid";
  el.layoutToggleButton.setAttribute("aria-label", el.layoutToggleButton.title);
}

// ── Queue Panel ───────────────────────────────────────────────────────────────
export function renderQueue() {
  el.queuePanel.classList.toggle("is-open", state.queueOpen);
  el.queuePanel.setAttribute("aria-hidden", String(!state.queueOpen));
  el.queueButton.classList.toggle("is-active", state.queueOpen);

  const byId    = new Map(state.tracks.map(t => [t.id, t]));
  const entries = state.queue
    .map((id, i) => ({ track: byId.get(id), index: i }))
    .filter(e => e.track);

  const modeParts = [];
  if (state.shuffle) modeParts.push("shuffled");
  if (state.repeat === "all") modeParts.push("repeat all");
  if (state.repeat === "one") modeParts.push("repeat one");
  el.queueCount.textContent = `${entries.length} ${entries.length === 1 ? "song" : "songs"}${modeParts.length ? ` • ${modeParts.join(" • ")}` : ""}`;
  el.queueClearButton.disabled = entries.length === 0;

  if (!entries.length) {
    el.queueList.innerHTML = `<div class="queue-empty">Queue is empty.</div>`;
    return;
  }

  el.queueList.innerHTML = entries.map(({ track, index }) => {
    const isCurrent = index === state.queueIndex;
    const badges = [];
    if (isCurrent) badges.push("Now");
    if (state.shuffle && index > state.queueIndex) badges.push("Shuffled");
    if (isCurrent && state.repeat === "one") badges.push("Repeating");
    if (state.repeat === "all" && state.queueIndex >= 0 && index === 0 && index < state.queueIndex) badges.push("Loops");
    return `
    <button class="queue-item ${index === state.queueIndex ? "is-current" : ""}"
            data-queue-index="${index}" type="button">
      <img class="queue-art" src="${coverUrl(track)}" alt="" onerror="this.onerror=null;this.src='${DEFAULT_COVER}'">
      <span class="queue-copy">
        <span class="queue-title">${esc(trackTitle(track))}</span>
        <span class="queue-artist">
          ${esc(track.artist || "Unknown Artist")}
          ${badges.length ? `<span class="queue-badges">${badges.map(badge => `<span class="queue-badge">${esc(badge)}</span>`).join("")}</span>` : ""}
        </span>
      </span>
      <span class="queue-duration">${fmt(track.duration)}</span>
      <span class="queue-remove" data-queue-remove="${index}" title="Remove">${icons.x}</span>
    </button>`;
  }).join("");
}

// ── Full Render ───────────────────────────────────────────────────────────────
export function render() {
  renderViewTitle();
  renderGrid();
  renderNowPlaying();
  renderTransport();
  renderLayoutToggle();
  renderGroupSidebar();
  renderQueue();
  updateProgress();
}
