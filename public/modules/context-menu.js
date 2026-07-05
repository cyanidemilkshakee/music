// ── Context Menu ─────────────────────────────────────────────────────────────
import { state } from "./state.js";
import { el }    from "./dom.js";
import { icons } from "./icons.js";
import { activePlaylist } from "./helpers.js";
import { esc } from "./utils.js";

let ctxTrackId = null;

export function getCtxTrackId() { return ctxTrackId; }

export function showCtx(x, y, trackId) {
  if (!state.tracks.some(track => track.id === trackId)) return;
  ctxTrackId = trackId;
  const playlist  = activePlaylist();
  const canRemove = playlist && (playlist.trackIds || []).includes(trackId);

  el.contextMenu.innerHTML = `
    <button class="ctx-item" data-ctx="play">${icons.play_overlay}<span>Play</span></button>
    <button class="ctx-item" data-ctx="next">${icons["skip-forward"]}<span>Play Next</span></button>
    <button class="ctx-item" data-ctx="queue">${icons.queue}<span>Add to Queue</span></button>
    <button class="ctx-item" data-ctx="playlist">${icons.plus}<span>Add / Remove Playlists</span></button>
    ${canRemove ? `<button class="ctx-item" data-ctx="remove-playlist">${icons.x}<span>Remove from Playlist</span></button>` : ""}
    <button class="ctx-item" data-ctx="metadata">${icons.album}<span>Refresh Metadata</span></button>
    <button class="ctx-item" data-ctx="copy">${icons.copy}<span>Copy Title</span></button>`;

  // Show temporarily hidden to measure dimensions accurately
  el.contextMenu.style.visibility = "hidden";
  el.contextMenu.classList.add("is-open");
  el.contextMenu.setAttribute("aria-hidden", "false");

  const vw = window.innerWidth, vh = window.innerHeight;
  const mw = el.contextMenu.offsetWidth  || 180;
  const mh = el.contextMenu.offsetHeight || 200;
  el.contextMenu.style.left = `${Math.max(8, Math.min(x, vw - mw - 8))}px`;
  el.contextMenu.style.top  = `${Math.max(8, Math.min(y, vh - mh - 8))}px`;
  el.contextMenu.style.visibility = "";
}

export function closeCtx() {
  el.contextMenu.classList.remove("is-open");
  el.contextMenu.setAttribute("aria-hidden", "true");
  ctxTrackId = null;
}
