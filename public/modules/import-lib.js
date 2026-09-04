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
            }
          } catch(e) {
             console.error("SSE parse error", e, payload);
          }
        }
      }
    }

    if (!resultData) {
      throw new Error("Scan finished without complete event.");
    }

    syncImportedTracks(resultData);

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
