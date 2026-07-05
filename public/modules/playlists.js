import { state, DEFAULT_COVER } from "./state.js";
import { el } from "./dom.js";
import { api } from "./api.js";
import { showToast } from "./toast.js";
import { render, renderPlaylistsSidebar, renderGrid } from "./render.js";
import { openPlaylist, setView } from "./navigation.js";
import { activePlaylist } from "./helpers.js";
import { esc, coverUrl, cssEscape, trackTitle } from "./utils.js";

let creatingPlaylist = false;
const playlistOps = new Set();
const metadataOps = new Set();
let pickerTrackId = null;

export function showActionError(error) {
  showToast(`Warning: ${error?.message || "The action could not be completed."}`);
}

function syncPlaylists(data) {
  if (Array.isArray(data.playlists)) {
    state.playlists = data.playlists;
  } else if (data.playlist) {
    state.playlists = [
      ...state.playlists.filter(playlist => playlist.id !== data.playlist.id),
      data.playlist
    ];
  }
}

function rerenderPlaylists() {
  renderPlaylistsSidebar();
  render();
}

export async function createPlaylist(name = "") {
  if (creatingPlaylist) return null;
  creatingPlaylist = true;
  try {
    const data = await api("/api/playlists", {
      method: "POST",
      body: JSON.stringify({ name }),
      timeoutMs: 15_000
    });

    if (!data.playlist) return null;
    syncPlaylists(data);
    renderPlaylistsSidebar();
    return state.playlists.find(playlist => playlist.id === data.playlist.id) || data.playlist;
  } finally {
    creatingPlaylist = false;
  }
}

function nextPlaylistName() {
  const names = new Set(state.playlists.map(playlist => String(playlist.name || "").toLowerCase()));
  let index = state.playlists.length + 1;
  let name = `Playlist ${index}`;
  while (names.has(name.toLowerCase())) {
    index++;
    name = `Playlist ${index}`;
  }
  return name;
}

export async function createPlaylistFromButton() {
  const playlist = await createPlaylist(nextPlaylistName()).catch(error => {
    showActionError(error);
    return null;
  });
  if (playlist) openPlaylist(playlist.id);
}

function choosePlaylist() {
  if (state.activePlaylistId) return activePlaylist();
  if (!state.playlists.length) return null;
  return state.playlists[0];
}

export async function addToPlaylist(track) {
  if (!track?.id) return;
  let playlist = choosePlaylist();
  if (playlist === undefined) return;
  if (!playlist) playlist = await createPlaylist("My Playlist");
  if (!playlist) return;

  await setTrackPlaylistMembership(track.id, new Set([...playlist.trackIds, track.id]), {
    onlyPlaylistId: playlist.id,
    toast: `Added to "${playlist.name}"`
  });
}

async function addTrackToPlaylistId(playlistId, trackId) {
  const opKey = `${playlistId}:${trackId}:add`;
  if (playlistOps.has(opKey)) return null;
  playlistOps.add(opKey);
  try {
    const data = await api(`/api/playlists/${encodeURIComponent(playlistId)}/tracks`, {
      method: "POST",
      body: JSON.stringify({ trackId }),
      timeoutMs: 15_000
    });
    syncPlaylists(data);
    return data.playlist || null;
  } finally {
    playlistOps.delete(opKey);
  }
}

async function removeTrackFromPlaylistId(playlistId, trackId) {
  const opKey = `${playlistId}:${trackId}:remove`;
  if (playlistOps.has(opKey)) return null;
  playlistOps.add(opKey);
  try {
    const data = await api(`/api/playlists/${encodeURIComponent(playlistId)}/tracks/${encodeURIComponent(trackId)}`, {
      method: "DELETE",
      timeoutMs: 15_000
    });
    syncPlaylists(data);
    return data.playlist || null;
  } finally {
    playlistOps.delete(opKey);
  }
}

export async function setTrackPlaylistMembership(trackId, selectedPlaylistIds, options = {}) {
  if (!trackId) return;

  if (options.onlyPlaylistId) {
    await addTrackToPlaylistId(options.onlyPlaylistId, trackId);
  } else {
    const existing = new Set(
      state.playlists
        .filter(playlist => (playlist.trackIds || []).includes(trackId))
        .map(playlist => playlist.id)
    );
    const selected = new Set(selectedPlaylistIds);
    const adds = [...selected].filter(id => !existing.has(id));
    const removes = [...existing].filter(id => !selected.has(id));

    for (const playlistId of adds) await addTrackToPlaylistId(playlistId, trackId);
    for (const playlistId of removes) await removeTrackFromPlaylistId(playlistId, trackId);
  }

  renderPlaylistsSidebar();
  if (state.activePlaylistId) renderGrid();
  if (options.toast) showToast(options.toast, 2500);
}

export async function removeFromActivePlaylist(trackId) {
  const playlist = activePlaylist();
  if (!playlist || !trackId) return;
  await removeTrackFromPlaylistId(playlist.id, trackId);
  rerenderPlaylists();
}

export async function renamePlaylist(playlistId) {
  const playlist = state.playlists.find(item => item.id === playlistId);
  if (!playlist) return;
  const name = await askPlaylistName(playlist.name);
  if (name === null) return;
  const normalized = name.replace(/\s+/g, " ").trim();
  if (!normalized || normalized === playlist.name) return;

  const data = await api(`/api/playlists/${encodeURIComponent(playlist.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name: normalized }),
    timeoutMs: 15_000
  });
  syncPlaylists(data);
  rerenderPlaylists();
}

export async function deletePlaylist(playlistId) {
  const playlist = state.playlists.find(item => item.id === playlistId);
  if (!playlist) return;
  if (!await confirmPlaylistDelete(playlist.name)) return;

  const data = await api(`/api/playlists/${encodeURIComponent(playlist.id)}`, {
    method: "DELETE",
    timeoutMs: 15_000
  });
  syncPlaylists(data);
  if (state.activePlaylistId === playlist.id) {
    state.activePlaylistId = null;
    setView("playlists", true);
  } else {
    rerenderPlaylists();
  }
}

function closeDialog(overlay, resolve, value) {
  overlay.classList.remove("is-open");
  setTimeout(() => overlay.remove(), 180);
  resolve(value);
}

function buildDialog(title, bodyHtml) {
  const overlay = document.createElement("div");
  overlay.className = "glass-dialog-layer is-open";
  overlay.innerHTML = `
    <div class="glass-dialog" role="dialog" aria-modal="true">
      <h2>${esc(title)}</h2>
      ${bodyHtml}
    </div>`;
  document.body.appendChild(overlay);
  return overlay;
}

function askPlaylistName(currentName) {
  return new Promise(resolve => {
    const overlay = buildDialog("Rename Playlist", `
      <input class="glass-dialog-input" value="${esc(currentName)}" maxlength="120">
      <div class="glass-dialog-actions">
        <button class="glass-btn" data-dialog-cancel type="button">Cancel</button>
        <button class="glass-btn glass-btn-primary" data-dialog-save type="button">Save</button>
      </div>`);
    const input = overlay.querySelector(".glass-dialog-input");
    input.focus();
    input.select();

    overlay.querySelector("[data-dialog-cancel]").addEventListener("click", () => closeDialog(overlay, resolve, null));
    overlay.querySelector("[data-dialog-save]").addEventListener("click", () => closeDialog(overlay, resolve, input.value));
    overlay.addEventListener("click", event => {
      if (event.target === overlay) closeDialog(overlay, resolve, null);
    });
    input.addEventListener("keydown", event => {
      if (event.key === "Enter") closeDialog(overlay, resolve, input.value);
      if (event.key === "Escape") closeDialog(overlay, resolve, null);
    });
  });
}

function confirmPlaylistDelete(name) {
  return new Promise(resolve => {
    const overlay = buildDialog("Delete Playlist", `
      <p class="glass-dialog-copy">Delete "${esc(name)}"? Songs stay in your library.</p>
      <div class="glass-dialog-actions">
        <button class="glass-btn" data-dialog-cancel type="button">Cancel</button>
        <button class="glass-btn glass-btn-primary danger" data-dialog-delete type="button">Delete</button>
      </div>`);

    overlay.querySelector("[data-dialog-cancel]").addEventListener("click", () => closeDialog(overlay, resolve, false));
    overlay.querySelector("[data-dialog-delete]").addEventListener("click", () => closeDialog(overlay, resolve, true));
    overlay.addEventListener("click", event => {
      if (event.target === overlay) closeDialog(overlay, resolve, false);
    });
    overlay.addEventListener("keydown", event => {
      if (event.key === "Escape") closeDialog(overlay, resolve, false);
    });
    overlay.querySelector("[data-dialog-delete]").focus();
  });
}

function currentPickerTrack() {
  return state.tracks.find(track => track.id === pickerTrackId) || null;
}

function renderPlaylistPicker() {
  const track = currentPickerTrack();
  if (!track) return;

  el.playlistPickerTrack.innerHTML = `
    <img src="${coverUrl(track)}" alt="" onerror="this.onerror=null;this.src='${DEFAULT_COVER}'">
    <span>
      <strong>${esc(trackTitle(track))}</strong>
      <small>${esc(track.artist || "Unknown Artist")}</small>
    </span>`;

  if (!state.playlists.length) {
    el.playlistPickerList.innerHTML = `<div class="picker-empty">No playlists yet. Create one to start sorting this song.</div>`;
    return;
  }

  const memberships = new Set(
    state.playlists
      .filter(playlist => (playlist.trackIds || []).includes(track.id))
      .map(playlist => playlist.id)
  );

  el.playlistPickerList.innerHTML = state.playlists.map(playlist => `
    <label class="picker-row">
      <input type="checkbox" data-picker-playlist="${esc(playlist.id)}" ${memberships.has(playlist.id) ? "checked" : ""}>
      <span class="picker-check"></span>
      <span class="picker-name">${esc(playlist.name)}</span>
      <span class="picker-count">${(playlist.trackIds || []).length}</span>
    </label>
  `).join("");
}

export function openPlaylistPicker(trackId) {
  if (!state.tracks.some(track => track.id === trackId)) return;
  pickerTrackId = trackId;
  renderPlaylistPicker();
  el.playlistPicker.classList.remove("is-hidden");
  el.playlistPicker.setAttribute("aria-hidden", "false");
}

export function closePlaylistPicker() {
  el.playlistPicker.classList.add("is-hidden");
  el.playlistPicker.setAttribute("aria-hidden", "true");
  pickerTrackId = null;
}

export async function savePlaylistPicker() {
  const track = currentPickerTrack();
  if (!track) return;
  const selected = new Set(
    [...el.playlistPickerList.querySelectorAll("[data-picker-playlist]:checked")]
      .map(input => input.dataset.pickerPlaylist)
  );
  await setTrackPlaylistMembership(track.id, selected, { toast: "Playlist membership updated" });
  closePlaylistPicker();
}

export async function createPlaylistFromPicker() {
  const playlist = await createPlaylist(nextPlaylistName());
  if (!playlist) return;
  renderPlaylistPicker();
  const checkbox = el.playlistPickerList.querySelector(`[data-picker-playlist="${cssEscape(playlist.id)}"]`);
  if (checkbox) checkbox.checked = true;
}

export async function refreshTrackMetadata(trackId) {
  if (!trackId || metadataOps.has(trackId)) return;
  metadataOps.add(trackId);
  try {
    const data = await api(`/api/metadata/${encodeURIComponent(trackId)}`, {
      method: "POST",
      timeoutMs: 60_000
    });
    if (!data.track) return;

    state.tracks = state.tracks.map(track => track.id === trackId ? data.track : track);
    if (state.selectedTrackId === trackId) state.selectedTrackId = data.track.id;
    if (state.currentTrackId === trackId) state.currentTrackId = data.track.id;
    state.queue = state.queue.map(id => id === trackId ? data.track.id : id);
    render();
    showToast("Metadata refreshed", 2000);
  } finally {
    metadataOps.delete(trackId);
  }
}
