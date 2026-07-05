// ── State Accessor Helpers ───────────────────────────────────────────────────
import { state } from "./state.js";
import { groupTracks } from "./groups.js";

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
  if (!state.activeGroup) return null;
  return groupTracks(state.activeGroup.type)
    .find(g => g.key === state.activeGroup.key) || null;
}

/** Ordered tracks belonging to a playlist, resolved against the library */
export function playlistTracks(playlist) {
  const byId = new Map(state.tracks.map(t => [t.id, t]));
  return (playlist?.trackIds || []).map(id => byId.get(id)).filter(Boolean);
}

/** Human-readable song count for a playlist */
export function playlistSummary(playlist) {
  const n = playlistTracks(playlist).length;
  return `${n} ${n === 1 ? "song" : "songs"}`;
}

/** First resolved track in a playlist (for artwork) */
export function firstPlaylistTrack(playlist) {
  return playlistTracks(playlist)[0] || null;
}
