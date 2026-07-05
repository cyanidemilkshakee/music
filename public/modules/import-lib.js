import { state } from "./state.js";
import { el } from "./dom.js";
import { api } from "./api.js";
import { toggleEmptyState, render } from "./render.js";

function setImportStatus(message, className = "") {
  el.importStatusSheet.textContent = message;
  el.importStatusSheet.className = `import-status ${className}`.trim();
}

export function openImportSheet() {
  setImportStatus("");
  el.importSheet.classList.remove("is-hidden");
  el.folderInputSheet.focus();
}

export function closeImportSheet() {
  el.importSheet.classList.add("is-hidden");
}

function syncImportedTracks(data) {
  state.tracks = Array.isArray(data.tracks) ? data.tracks : [];
  if (!state.tracks.some(track => track.id === state.selectedTrackId)) {
    state.selectedTrackId = state.tracks[0]?.id || null;
  }
  if (!state.tracks.some(track => track.id === state.currentTrackId)) {
    state.currentTrackId = null;
    el.audio.pause();
    el.audio.removeAttribute("src");
  }
  state.queue = state.tracks.map(track => track.id);
  state.queueIndex = -1;
}

export async function doImport(directory) {
  if (state.busy) {
    setImportStatus("A scan is already running.", "is-error");
    return;
  }

  if (!directory) {
    setImportStatus("Choose a folder path first.", "is-error");
    return;
  }

  state.busy = true;
  el.importButtonSheet.disabled = true;
  el.importSheet.setAttribute("aria-busy", "true");
  setImportStatus("Scanning...");

  try {
    const data = await api("/api/scan", {
      method: "POST",
      body: JSON.stringify({ directory }),
      timeoutMs: 0
    });

    syncImportedTracks(data);

    const imported = Number(data.imported) || 0;
    const failures = Array.isArray(data.failures) ? data.failures : [];
    const skipped = failures.length;
    const firstFailure = failures[0]?.message ? ` First skipped: ${failures[0].message}` : "";
    const note = skipped ? ` (${skipped} skipped).${firstFailure}` : "";
    setImportStatus(`${imported} track${imported === 1 ? "" : "s"} imported.${note}`, "is-success");

    setTimeout(() => {
      closeImportSheet();
      toggleEmptyState();
      render();
    }, 1200);
  } catch (error) {
    setImportStatus(error.message || "Import failed.", "is-error");
  } finally {
    state.busy = false;
    el.importButtonSheet.disabled = false;
    el.importSheet.setAttribute("aria-busy", "false");
  }
}
