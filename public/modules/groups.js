// ── Group / Collection Logic ─────────────────────────────────────────────────
import { state } from "./state.js";
import { makeGroupKey, esc } from "./utils.js";

/** Label for a group of type "album" or "artist" */
export function groupLabel(track, type) {
  if (type === "album")  return track.album  || "Unknown Album";
  if (type === "artist") return track.artist || "Unknown Artist";
  return "Unknown";
}

/** Deduplicate non-falsy values */
export function uniqueValues(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

/**
 * Group all tracks (or supplied subset) by "album" or "artist".
 * Returns alphabetically sorted group objects.
 */
export function groupTracks(type, tracks = state.tracks) {
  const groups = new Map();

  tracks.forEach(track => {
    const label = groupLabel(track, type);
    const key   = makeGroupKey(type, label);
    if (!groups.has(key)) {
      groups.set(key, { type, key, name: label, tracks: [], artworkTrack: track });
    }
    groups.get(key).tracks.push(track);
  });

  return Array.from(groups.values())
    .map(g => ({
      ...g,
      artists: uniqueValues(g.tracks.map(t => t.artist || "Unknown Artist")),
      albums:  uniqueValues(g.tracks.map(t => t.album  || "Unknown Album")),
      duration: g.tracks.reduce((sum, t) => sum + (Number(t.duration) || 0), 0)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Which grouping mode is active for the current view (or the given view)? */
export function groupKindForView(view = state.activeView) {
  if (view === "albums")  return "album";
  if (view === "artists") return "artist";
  return null;
}

/** One-line human summary for a group card */
export function groupSummary(group) {
  if (group.type === "album") {
    return group.artists.slice(0, 2).join(", ");
  }
  return `${group.albums.length} ${group.albums.length === 1 ? "album" : "albums"}`;
}
