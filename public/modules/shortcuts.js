import { state } from "./state.js";
import { el } from "./dom.js";
import { icons } from "./icons.js";
import { playPause, nextTrack, prevTrack, storedVolume } from "./player.js";
import { setView, goBack } from "./navigation.js";
import { closeImportSheet, openImportSheet } from "./import-lib.js";
import { updateVolumeUI } from "./audio.js";
import { renderTransport, renderQueue } from "./render.js";
import { closeCtx } from "./context-menu.js";

const SHORTCUTS = [
  {
    category: "Playback",
    items: [
      { keys: ["Space"], label: "Play / Pause" },
      { keys: ["Right"], label: "Next track" },
      { keys: ["Left"], label: "Previous track / Restart" },
      { keys: ["M"], label: "Toggle mute" },
      { keys: ["R"], label: "Repeat: Off -> All -> One -> Off" },
      { keys: ["S"], label: "Toggle shuffle" }
    ]
  },
  {
    category: "Navigation",
    items: [
      { keys: ["H"], label: "Go to Home" },
      { keys: ["A"], label: "Go to Artists" },
      { keys: ["B"], label: "Go to Albums" },
      { keys: ["P"], label: "Go to Playlists" },
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
            ${section.items.map(item => `
              <div class="shortcut-row">
                <div class="shortcut-keys">
                  ${item.keys.map(key => `<kbd class="shortcut-kbd">${key}</kbd>`).join("<span class=\"shortcut-plus\">+</span>")}
                </div>
                <span class="shortcut-label">${item.label}</span>
              </div>`).join("")}
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

  if (inInput || event.ctrlKey || event.metaKey || event.altKey) return;

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
      event.preventDefault();
      nextTrack();
      break;
    case "ArrowLeft":
      event.preventDefault();
      prevTrack();
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
    case "KeyP":
      event.preventDefault();
      setView("playlists");
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
