import { state } from "./state.js";
import { api } from "./api.js";
import { showToast } from "./toast.js";
import { render, renderPlaylistsSidebar, renderGrid } from "./render.js";
import { openPlaylist } from "./navigation.js";
import { activePlaylist } from "./helpers.js";

let creatingPlaylist = false;
const playlistOps = new Set();
const metadataOps = new Set();

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

  const opKey = `${playlist.id}:${track.id}:add`;
  if (playlistOps.has(opKey)) return;
  playlistOps.add(opKey);
  try {
    const data = await api(`/api/playlists/${encodeURIComponent(playlist.id)}/tracks`, {
      method: "POST",
      body: JSON.stringify({ trackId: track.id }),
      timeoutMs: 15_000
    });
    syncPlaylists(data);
    renderPlaylistsSidebar();
    if (state.activePlaylistId === playlist.id) renderGrid();
    showToast(`Added to "${playlist.name}"`, 2500);
  } finally {
    playlistOps.delete(opKey);
  }
}

export async function removeFromActivePlaylist(trackId) {
  const playlist = activePlaylist();
  if (!playlist || !trackId) return;

  const opKey = `${playlist.id}:${trackId}:remove`;
  if (playlistOps.has(opKey)) return;
  playlistOps.add(opKey);
  try {
    const data = await api(`/api/playlists/${encodeURIComponent(playlist.id)}/tracks/${encodeURIComponent(trackId)}`, {
      method: "DELETE",
      timeoutMs: 15_000
    });
    syncPlaylists(data);
    renderPlaylistsSidebar();
    render();
  } finally {
    playlistOps.delete(opKey);
  }
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
