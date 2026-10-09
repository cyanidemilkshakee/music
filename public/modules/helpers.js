// ── State Accessor Helpers ───────────────────────────────────────────────────
import { state } from "./state.js";

/** The track the user has selected (highlighted) */
export function selectedTrack() {
  return state.tracks.find(t => t.id === state.selectedTrackId) || null;
}

/** The track currently loaded in the audio element */
export function currentTrack() {
  return state.tracks.find(t => t.id === state.currentTrackId) || null;
}

/** The playlist object for the active playlist view */
export function activePlaylist() {
  return state.playlists.find(p => p.id === state.activePlaylistId) || null;
}

/** The active group object (album/artist drill-down) */
export function activeGroup() {
  return state.activeGroup;
}

/** Ordered tracks belonging to a playlist, resolved against the library */
function playlistTracks(playlist) {
  const byId = trackIndex();
  return (playlist?.trackIds || []).map(id => byId.get(id)).filter(Boolean);
}
let indexedTracks, index;
function trackIndex() {
  if (indexedTracks !== state.tracks) { indexedTracks = state.tracks; index = new Map(state.tracks.map(track => [track.id, track])); }
  return index;
}

/** Human-readable song count for a playlist */
export function playlistSummary(playlist) {
  const n = (playlist.trackIds || []).length;
  return `${n} ${n === 1 ? "song" : "songs"}`;
}

/** First resolved track in a playlist (for artwork) */
export function firstPlaylistTrack(playlist) {
  return playlistTracks(playlist)[0] || null;
}
