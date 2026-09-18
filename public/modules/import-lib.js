import { state } from "./state.js";
import { el } from "./dom.js";
import { api } from "./api.js";
import { toggleEmptyState, render } from "./render.js";
import { esc } from "./utils.js";
import { trapModalFocus } from "./modal-focus.js";

let releaseImportFocus = null;

function setImportStatus(message, className = "") {
  el.importStatusSheet.textContent = message;
  el.importStatusSheet.className = `import-status ${className}`.trim();
}

export function openImportSheet() {
  setImportStatus("");
  el.importSheet.classList.remove("is-hidden");
  releaseImportFocus?.();
  releaseImportFocus = trapModalFocus(el.importSheet, { onClose: closeImportSheet, initialFocus: el.folderInputSheet });
  refreshLibrarySources().catch(() => {});
}

export function closeImportSheet() {
  el.importSheet.classList.add("is-hidden");
  releaseImportFocus?.();
  releaseImportFocus = null;
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

export async function refreshLibrarySources() {
  const data = await api("/api/library/sources", { timeoutMs: 10_000 });
  const sources = Array.isArray(data.sources) ? data.sources : [];
  state.librarySources = sources;
  if (!el.librarySourceList) return;
  el.librarySourceList.innerHTML = sources.length
    ? sources.map(source => `
      <div class="library-source">
        <button class="library-source-path" data-library-source="${esc(source.path)}" type="button" title="Import ${esc(source.path)}">${esc(source.path)}</button>
        <button class="library-source-remove" data-library-source-remove="${esc(source.id)}" type="button" aria-label="Remove saved folder">×</button>
      </div>`).join("")
    : `<p class="source-empty">Folders you import will appear here.</p>`;
}

export async function chooseLibraryFolder() {
  if (state.busy) return;
  const button = el.pickFolderButton;
  if (button) button.disabled = true;
  try {
    const data = await api("/api/library/pick-folder", { method: "POST", timeoutMs: 120_000 });
    if (data.directory) {
      el.folderInputSheet.value = data.directory;
      el.folderInputSheet.focus();
    }
  } catch (error) {
    setImportStatus(error.message || "Could not open the folder picker.", "is-error");
  } finally {
    if (button) button.disabled = false;
  }
}

export async function forgetLibrarySource(id) {
  if (!id) return;
  await api(`/api/library/sources/${encodeURIComponent(id)}`, { method: "DELETE", timeoutMs: 10_000 });
  await refreshLibrarySources();
}

export function directoryFromDrop(event) {
  const rawUri = (event.dataTransfer?.getData("text/uri-list") || "")
    .split(/\r?\n/)
    .find(value => value && !value.startsWith("#"));
  if (!rawUri?.startsWith("file:")) return "";
  try {
    const url = new URL(rawUri);
    if (url.protocol !== "file:") return "";
    const path = decodeURIComponent(url.pathname);
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1).replaceAll("/", "\\") : path;
  } catch {
    return "";
  }
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
    const initResponse = await fetch("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directory })
    });

    if (!initResponse.ok) {
      let msg = "Import failed.";
      try {
        const errData = await initResponse.json();
        msg = errData.detail || errData.error || msg;
      } catch (e) {}
      throw new Error(msg);
    }
    
    const { jobId } = await initResponse.json();
    if (!jobId) throw new Error("Did not receive a job ID.");
    
    const response = await fetch(`/api/scan/${jobId}/stream`, {
      method: "GET"
    });

    if (!response.ok) {
      throw new Error("Failed to attach to scan stream.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    
    let resultData = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep remainder
      
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const payload = line.slice(6);
          if (!payload.trim()) continue;
          
          try {
            const event = JSON.parse(payload);
            if (event.phase === "walk") {
               setImportStatus(`Found ${event.found} audio files...`);
            } else if (event.phase === "probe") {
               const p = Math.round((event.done / event.total) * 100);
               setImportStatus(`Processing metadata... ${p}% (${event.done}/${event.total})`);
            } else if (event.phase === "complete") {
               resultData = event;
               reader.cancel(); // close the SSE stream early
               break;
            } else if (event.phase === "failed") {
               throw new Error(event.message || "Scan failed.");
            }
          } catch(e) {
             console.error("SSE parse error", e, payload);
          }
        }
      }
      if (resultData) break;
    }

    if (!resultData) {
      throw new Error("Scan finished without complete event.");
    }

    syncImportedTracks(resultData);
    refreshLibrarySources().catch(() => {});

    const imported = Number(resultData.imported) || 0;
    const failures = Array.isArray(resultData.failures) ? resultData.failures : [];
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
