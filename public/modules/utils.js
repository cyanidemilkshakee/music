// ── Utility / Helper Functions ────────────────────────────────────────────────
import { state, DEFAULT_COVER } from "./state.js";

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
    ? `/api/artwork/${encodeURIComponent(track.id)}`
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

/** Build clickable artist/album subtitle HTML for a track card */
export function trackSubtitle(track) {
  const artist = track?.artist || "Unknown Artist";
  const album  = track?.album;
  let html = `<span class="nav-link" data-group-type="artist" data-group-key="${esc(makeGroupKey("artist", artist))}">${esc(artist)}</span>`;
  if (album) {
    html += ` - <span class="nav-link" data-group-type="album" data-group-key="${esc(makeGroupKey("album", album))}">${esc(album)}</span>`;
  }
  return html;
}
