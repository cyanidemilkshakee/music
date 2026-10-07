// ── Utility / Helper Functions ────────────────────────────────────────────────
import { DEFAULT_COVER } from "./state.js";

/** HTML-escape a value for safe interpolation into innerHTML */
export function esc(v) {
  return String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Format seconds into M:SS string */
export function fmt(secs) {
  const t = Math.floor(Number(secs) || 0);
  const m = Math.floor(t / 60);
  const s = String(t % 60).padStart(2, "0");
  return `${m}:${s}`;
}

/** Get artwork URL or default cover */
export function coverUrl(track) {
  return track?.hasArtwork
    ? `/api/artwork/${encodeURIComponent(track.id)}?v=${encodeURIComponent(track.metadataExtractedAt || track.modifiedAt || "0")}`
    : DEFAULT_COVER;
}

/** Best display title for a track */
export function trackTitle(track) {
  return track?.title || track?.fileName || "Untitled";
}

/** CSS.escape polyfill for selector usage */
export function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(String(value));
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** Canonical group key: "type:lowercaselabel" */
export function makeGroupKey(type, label) {
  return `${type}:${String(label || "").trim().toLowerCase()}`;
}

export function albumKey(track) {
  return makeGroupKey("album", JSON.stringify([track.album || "Unknown Album", track.albumArtist || track.artist || "Unknown Artist"]));
}

/** Build clickable artist/album subtitle HTML for a track card */
export function trackSubtitle(track) {
  const artist = track?.artist || "Unknown Artist";
  const album  = track?.album;
  let html = `<button type="button" class="nav-link" data-group-type="artist" data-group-key="${esc(makeGroupKey("artist", artist))}">${esc(artist)}</button>`;
  if (album) {
    html += ` · <button type="button" class="nav-link" data-group-type="album" data-group-key="${esc(albumKey(track))}">${esc(album)}</button>`;
  }
  return html;
}
