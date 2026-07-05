// ── Sort & Filter ────────────────────────────────────────────────────────────
import { state } from "./state.js";
import { activeGroup, activePlaylist } from "./helpers.js";

/** Importation/modification timestamp for "recently added" sorting */
export function recentTime(track) {
  const imported = Date.parse(track.importedAt || "");
  if (Number.isFinite(imported)) return imported;
  return Number(track.modifiedAt) || 0;
}

/**
 * Sort tracks according to the current sort state and active scope
 * (album drill-down, artist drill-down, or flat library view).
 */
export function sortSongsForScope(tracks) {
  // User-selected column sort takes priority
  if (state.sortField !== "none") {
    const byText = (a, b, f) => String(a[f] || "").localeCompare(String(b[f] || ""));
    const byNum  = (a, b, f) => (Number(a[f]) || 0) - (Number(b[f]) || 0);
    return [...tracks].sort((a, b) => {
      let res = 0;
      if (state.sortField === "title")    res = byText(a, b, "title");
      if (state.sortField === "album")    res = byText(a, b, "album");
      if (state.sortField === "duration") res = byNum(a, b, "duration");
      return state.sortDir === "asc" ? res : -res;
    });
  }

  const byText  = (a, b, f) => String(a[f] || "").localeCompare(String(b[f] || ""));
  const byDisc  = (a, b) => (Number(a.discNumber)   || 0) - (Number(b.discNumber)   || 0);
  const byTrack = (a, b) => (Number(a.trackNumber)  || 0) - (Number(b.trackNumber)  || 0);

  if (state.activeGroup?.type === "album") {
    return [...tracks].sort((a, b) => byDisc(a, b) || byTrack(a, b) || byText(a, b, "title"));
  }
  if (state.activeGroup?.type === "artist") {
    return [...tracks].sort((a, b) =>
      byText(a, b, "album") || byDisc(a, b) || byTrack(a, b) || byText(a, b, "title"));
  }
  if (state.activeView === "albums")  return [...tracks].sort((a, b) => byText(a, b, "album") || byTrack(a, b));
  if (state.activeView === "artists") return [...tracks].sort((a, b) =>
    byText(a, b, "artist") || byText(a, b, "album") || byTrack(a, b));
  return tracks;
}

/**
 * Returns the tracks visible in the current view after:
 * 1. Scoping to active group or playlist
 * 2. Applying the search query
 * 3. Sorting
 */
export function getVisibleTracks() {
  let tracks = [...state.tracks];
  const group    = activeGroup();
  const playlist = activePlaylist();

  if (group) {
    tracks = [...group.tracks];
  } else if (playlist) {
    const byId = new Map(state.tracks.map(t => [t.id, t]));
    tracks = (playlist.trackIds || []).map(id => byId.get(id)).filter(Boolean);
  }

  const q = state.search.trim().toLowerCase();
  if (q) {
    tracks = tracks.filter(t =>
      [t.title, t.artist, t.album].join(" ").toLowerCase().includes(q)
    );
  }

  if (state.activeView === "recent" && !group && !playlist) {
    return [...tracks].sort((a, b) => recentTime(b) - recentTime(a));
  }
  return sortSongsForScope(tracks);
}
