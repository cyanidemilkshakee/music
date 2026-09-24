import { state, DEFAULT_COVER } from "./state.js";
import { icons } from "./icons.js";
import { el } from "./dom.js";
import { coverUrl, esc, fmt, trackTitle } from "./utils.js";

export function renderQueue() {
  el.queuePanel.classList.toggle("is-open", state.queueOpen);
  el.queuePanel.setAttribute("aria-hidden", String(!state.queueOpen));
  el.queueButton.classList.toggle("is-active", state.queueOpen);
  const byId = new Map(state.tracks.map(track => [track.id, track]));
  const entries = state.queue.map((id, index) => ({ track: byId.get(id), index })).filter(entry => entry.track);
  const modes = [state.shuffle && "shuffled", state.repeat === "all" && "repeat all", state.repeat === "one" && "repeat one"].filter(Boolean);
  el.queueCount.textContent = `${entries.length} ${entries.length === 1 ? "song" : "songs"}${modes.length ? ` • ${modes.join(" • ")}` : ""}`;
  el.queueClearButton.disabled = entries.length === 0;
  if (!entries.length) { el.queueList.innerHTML = `<div class="queue-empty">Queue is empty.</div>`; return; }
  el.queueList.innerHTML = entries.map(({ track, index }) => {
    const current = index === state.queueIndex;
    return `<button class="queue-item ${current ? "is-current" : ""}" data-queue-index="${index}" data-queue-drag-index="${index}" draggable="true" type="button">
      <img class="queue-art" src="${coverUrl(track)}" alt="" onerror="this.onerror=null;this.src='${DEFAULT_COVER}'"><span class="queue-copy"><span class="queue-title">${esc(trackTitle(track))}</span><span class="queue-artist">${esc(track.artist || "Unknown Artist")}${current ? `<span class="queue-badges"><span class="queue-badge">Now</span></span>` : ""}</span></span><span class="queue-duration">${fmt(track.duration)}</span><span class="queue-remove" data-queue-remove="${index}" title="Remove">${icons.x}</span>
    </button>`;
  }).join("");
}
