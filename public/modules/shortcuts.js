import { state } from "./state.js";
import { el } from "./dom.js";
import { icons } from "./icons.js";
import { playPause, nextTrack, prevTrack, storedVolume } from "./player.js";
import { setView, goBack } from "./navigation.js";
import { closeImportSheet, openImportSheet } from "./import-lib.js";
import { updateVolumeUI } from "./audio.js";
import { renderTransport, renderQueue } from "./render.js";
import { closeCtx } from "./context-menu.js";
import { closePlaylistPicker } from "./playlists.js";

const SHORTCUTS = [
  {
    category: "Playback",
    items: [
      { keys: ["Space"], label: "Play / Pause" },
      { keys: ["N"], label: "Next track" },
      { keys: ["P"], label: "Previous track / Restart" },
      { keys: ["Up"], label: "Volume Up 5%" },
      { keys: ["Down"], label: "Volume Down 5%" },
      { keys: ["M"], label: "Toggle mute" },
      { keys: ["R"], label: "Repeat: Off -> All -> One -> Off" },
      { keys: ["Right"], label: "Seek forward 10s" },
      { keys: ["Left"], label: "Seek backward 10s" },
      { keys: ["Shift", "Right"], label: "Seek forward 5s" },
      { keys: ["Shift", "Left"], label: "Seek backward 5s" },
      { keys: ["Ctrl", "Right"], label: "Seek forward 60s" },
      { keys: ["Ctrl", "Left"], label: "Seek backward 60s" },
      { keys: ["S"], label: "Toggle shuffle" }
    ]
  },
  {
    category: "Navigation",
    items: [
      { keys: ["H"], label: "Go to Home" },
      { keys: ["A"], label: "Go to Artists" },
      { keys: ["B"], label: "Go to Albums" },
      { keys: ["F", "/"], label: "Focus Search" }
    ]
  },
  {
    category: "Interface",
    items: [
      { keys: ["Q"], label: "Toggle Queue" },
      { keys: ["I"], label: "Import Music" },
      { keys: ["L"], label: "Toggle List / Grid" },
      { keys: ["Esc"], label: "Close / Dismiss" },
      { keys: ["?"], label: "Show / Hide Shortcuts" }
    ]
  }
];

const overlay = document.createElement("div");
overlay.id = "shortcut-overlay";
overlay.className = "shortcut-overlay";
overlay.setAttribute("aria-modal", "true");
overlay.setAttribute("role", "dialog");
overlay.setAttribute("aria-label", "Keyboard Shortcuts");
overlay.style.display = "none";
document.body.appendChild(overlay);

let isOpen = false;
let closeTimer = null;

function buildOverlay() {
  overlay.innerHTML = `
    <div class="shortcut-glass" id="shortcutGlass">
      <div class="shortcut-header">
        <span class="shortcut-icon">${icons.keyboard}</span>
        <h2 class="shortcut-title">Keyboard Shortcuts</h2>
        <button class="shortcut-close" id="shortcutClose" aria-label="Close shortcuts">${icons.x}</button>
      </div>
      <div class="shortcut-grid">
        ${SHORTCUTS.map(section => `
          <div class="shortcut-section">
            <div class="shortcut-category">${section.category}</div>
            <div class="shortcut-items">
              ${section.items.map(item => `
                <div class="shortcut-row">
                  <div class="shortcut-keys">
                    ${item.keys.map(key => `<kbd class="shortcut-kbd">${key}</kbd>`).join("<span class=\"shortcut-plus\">+</span>")}
                  </div>
                  <span class="shortcut-label">${item.label}</span>
                </div>`).join("")}
            </div>
          </div>`).join("")}
      </div>
      <div class="shortcut-footer">Press <kbd class="shortcut-kbd shortcut-kbd--sm">?</kbd> or <kbd class="shortcut-kbd shortcut-kbd--sm">Esc</kbd> to close</div>
    </div>`;

  document.getElementById("shortcutClose")?.addEventListener("click", closeShortcuts, { once: true });
}

export function openShortcuts() {
  if (isOpen) return;
  isOpen = true;
  clearTimeout(closeTimer);
  buildOverlay();
  overlay.style.display = "flex";
  requestAnimationFrame(() => {
    overlay.classList.add("is-open");
    document.getElementById("shortcutGlass")?.classList.add("is-open");
  });
}

export function closeShortcuts() {
  if (!isOpen) return;
  isOpen = false;
  overlay.classList.remove("is-open");
  document.getElementById("shortcutGlass")?.classList.remove("is-open");
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    if (!isOpen) overlay.style.display = "none";
  }, 300);
}

export function toggleShortcuts() {
  isOpen ? closeShortcuts() : openShortcuts();
}

export function cycleRepeat() {
  const cycle = { none: "all", all: "one", one: "none" };
  state.repeat = cycle[state.repeat] || "none";
  renderTransport();
}

overlay.addEventListener("click", event => {
  if (event.target === overlay) closeShortcuts();
});

document.addEventListener("keydown", event => {
  const tag = document.activeElement?.tagName || "";
  const inInput = ["INPUT", "TEXTAREA"].includes(tag);

  if (event.key === "?" && !event.ctrlKey && !event.metaKey) {
    if (!inInput || event.shiftKey) {
      event.preventDefault();
      toggleShortcuts();
      return;
    }
  }

  if (event.key === "Escape") {
    if (isOpen) {
      closeShortcuts();
      return;
    }
    if (!el.playlistPicker.classList.contains("is-hidden")) {
      closePlaylistPicker();
      return;
    }
    if (!el.importSheet.classList.contains("is-hidden")) {
      closeImportSheet();
      return;
    }
    if (state.queueOpen) {
      state.queueOpen = false;
      renderQueue();
      return;
    }
    closeCtx();
    return;
  }

  if (inInput || event.altKey) return;
  if ((event.ctrlKey || event.metaKey) && !event.code.startsWith("Arrow")) return;

  switch (event.code) {
    case "Space":
      event.preventDefault();
      playPause();
      break;
    case "Backspace":
      event.preventDefault();
      goBack();
      break;
    case "ArrowRight":
    case "ArrowLeft":
      event.preventDefault();
      if (el.audio.duration) {
        const dir = event.code === "ArrowRight" ? 1 : -1;
        let amount = 10;
        if (event.shiftKey) amount = 5;
        else if (event.ctrlKey || event.metaKey) amount = 60;
        el.audio.currentTime = Math.max(0, Math.min(el.audio.duration, el.audio.currentTime + (amount * dir)));
      }
      break;
    case "ArrowUp":
      event.preventDefault();
      el.audio.volume = Math.min(1, Math.round((el.audio.volume + 0.05) * 100) / 100);
      if (el.audio.muted) el.audio.muted = false;
      updateVolumeUI();
      break;
    case "ArrowDown":
      event.preventDefault();
      el.audio.volume = Math.max(0, Math.round((el.audio.volume - 0.05) * 100) / 100);
      if (el.audio.muted && el.audio.volume > 0) el.audio.muted = false;
      updateVolumeUI();
      break;
    case "KeyM":
      event.preventDefault();
      if (el.audio.muted) {
        el.audio.muted = false;
        if (el.audio.volume === 0) el.audio.volume = storedVolume() || 1;
      } else {
        el.audio.muted = true;
      }
      updateVolumeUI();
      break;
    case "KeyR":
      event.preventDefault();
      cycleRepeat();
      break;
    case "KeyS":
      event.preventDefault();
      state.shuffle = !state.shuffle;
      renderTransport();
      break;
    case "KeyH":
      event.preventDefault();
      setView("home");
      break;
    case "KeyA":
      event.preventDefault();
      setView("artists");
      break;
    case "KeyB":
      event.preventDefault();
      setView("albums");
      break;
    case "KeyN":
      event.preventDefault();
      nextTrack();
      break;
    case "KeyP":
      event.preventDefault();
      prevTrack();
      break;
    case "KeyQ":
      event.preventDefault();
      state.queueOpen = !state.queueOpen;
      renderQueue();
      break;
    case "KeyI":
      event.preventDefault();
      openImportSheet();
      break;
    case "KeyL":
      event.preventDefault();
      el.layoutToggleButton?.click();
      break;
    case "KeyF":
    case "Slash":
      event.preventDefault();
      el.searchInput?.focus();
      break;
  }
});
