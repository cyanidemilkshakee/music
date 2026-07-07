import { state } from "./state.js";
import { el } from "./dom.js";
import { api } from "./api.js";
import { showToast } from "./toast.js";
import { render, renderGrid, renderTransport, renderQueue } from "./render.js";
import { getVisibleTracks } from "./sort.js";
import { selectedTrack, playlistTracks } from "./helpers.js";
import { getStorage, setStorage } from "./storage.js";

let playRequestId = 0;
let activeDecodeController = null;

export function storedVolume() {
  const value = parseFloat(getStorage("amp-volume", "1.0"));
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

export function contextQueue(trackId) {
  const visible = getVisibleTracks().map(track => track.id);
  return visible.includes(trackId) ? visible : state.tracks.map(track => track.id);
}

export function refreshQueueIndex() {
  if (!state.currentTrackId) {
    state.queueIndex = -1;
    return;
  }
  if (state.queue[state.queueIndex] === state.currentTrackId) return;
  state.queueIndex = state.queue.findIndex(id => id === state.currentTrackId);
}

function shuffleIds(ids) {
  const next = [...ids];
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

function sameIdSet(left, right) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every(id => rightSet.has(id));
}

function reorderQueueForShuffle(currentId = state.currentTrackId) {
  if (!state.queue.length) return;
  refreshQueueIndex();

  if (!currentId || state.queueIndex < 0) {
    state.queue = shuffleIds(state.queue);
    return;
  }

  const played = state.queue.slice(0, state.queueIndex + 1);
  const upcoming = state.queue.slice(state.queueIndex + 1);
  state.queue = [...played, ...shuffleIds(upcoming)];
}

function restoreQueueOrder(currentId = state.currentTrackId) {
  if (!state.queue.length) return;
  const ordered = contextQueue(currentId || state.selectedTrackId || state.queue[0]);
  if (!sameIdSet(state.queue, ordered)) return;
  state.queue = ordered;
  refreshQueueIndex();
}

export function setShuffle(enabled) {
  const next = Boolean(enabled);
  if (state.shuffle === next) return;
  state.shuffle = next;
  if (state.shuffle) reorderQueueForShuffle();
  else restoreQueueOrder();
  renderTransport();
  renderQueue();
}

export function cycleRepeat() {
  const cycle = { none: "all", all: "one", one: "none" };
  state.repeat = cycle[state.repeat] || "none";
  renderTransport();
  renderQueue();
}

export function queueTrack(trackId, placement = "end") {
  if (!state.tracks.some(track => track.id === trackId)) return;
  refreshQueueIndex();

  if (!state.queue.length && state.currentTrackId) {
    state.queue = [state.currentTrackId];
    state.queueIndex = 0;
  }

  if (placement === "next") {
    const at = state.queueIndex >= 0 ? state.queueIndex + 1 : 0;
    state.queue.splice(at, 0, trackId);
  } else {
    state.queue.push(trackId);
  }
  renderQueue();
  showToast(placement === "next" ? "Playing next" : "Added to queue", 2000);
}

export function clearQueue() {
  refreshQueueIndex();
  if (state.currentTrackId && state.queueIndex >= 0) {
    state.queue = [state.currentTrackId];
    state.queueIndex = 0;
  } else {
    state.queue = [];
    state.queueIndex = -1;
  }
  render();
}

export function removeQueueItem(index) {
  if (!Number.isInteger(index) || index < 0 || index >= state.queue.length) return;
  const removingCurrent = index === state.queueIndex;
  state.queue.splice(index, 1);

  if (index < state.queueIndex) {
    state.queueIndex -= 1;
  } else if (removingCurrent) {
    if (state.queue.length) {
      const next = Math.min(index, state.queue.length - 1);
      playTrack(state.queue[next], [...state.queue], next);
      return;
    }
    state.queueIndex = -1;
    state.currentTrackId = null;
    el.audio.pause();
    el.audio.removeAttribute("src");
  }
  render();
}

export function playPlaylist(playlist) {
  const ids = playlistTracks(playlist).map(track => track.id);
  if (ids.length) playTrack(ids[0], ids, 0);
}

function abortActiveDecode() {
  if (activeDecodeController) {
    activeDecodeController.abort();
    activeDecodeController = null;
  }
}

export async function playTrack(trackId, queueIds = contextQueue(trackId), requestedIndex = -1) {
  const track = state.tracks.find(item => item.id === trackId);
  if (!track) return;

  abortActiveDecode();
  const requestId = ++playRequestId;
  activeDecodeController = new AbortController();

  const preservesQueueOrder = queueIds === state.queue;
  let nextQueue = queueIds.length ? [...queueIds] : [track.id];
  if (!nextQueue.includes(track.id)) nextQueue.push(track.id);
  let nextIndex = Number.isInteger(requestedIndex) ? requestedIndex : nextQueue.indexOf(track.id);
  if (nextIndex < 0 || nextQueue[nextIndex] !== track.id) {
    nextIndex = Math.max(0, nextQueue.indexOf(track.id));
  }
  if (state.shuffle && !preservesQueueOrder && nextQueue.length > 1) {
    const upcoming = nextQueue.filter(id => id !== track.id);
    nextQueue = [track.id, ...shuffleIds(upcoming)];
    nextIndex = 0;
  }

  state.selectedTrackId = track.id;
  state.currentTrackId = track.id;
  state.playbackError = "";
  state.buffering = true;
  state.queue = nextQueue;
  state.queueIndex = nextIndex;
  setStorage("amp-last-played", track.id);

  render();
  api(`/api/recent/${encodeURIComponent(track.id)}`, { method: "POST", timeoutMs: 10_000 }).catch(() => {});

  try {
    const data = await api(`/api/decode/${encodeURIComponent(track.id)}`, {
      method: "POST",
      signal: activeDecodeController.signal,
      timeoutMs: 15 * 60_000
    });
    if (requestId !== playRequestId || state.currentTrackId !== track.id) return;

    el.audio.pause();
    el.audio.src = data.audioUrl;
    el.audio.volume = storedVolume();
    await el.audio.play();

    if (requestId !== playRequestId || state.currentTrackId !== track.id) return;
    state.buffering = false;
    renderTransport();
    renderGrid();
  } catch (error) {
    if (requestId !== playRequestId || error?.name === "AbortError") return;
    state.buffering = false;
    state.playbackError = error.message || "Playback failed.";
    state.currentTrackId = null;
    el.audio.pause();
    el.audio.removeAttribute("src");
    showToast(`Warning: ${state.playbackError}`);
    render();
  } finally {
    if (requestId === playRequestId) activeDecodeController = null;
  }
}

export function playPause() {
  if (!state.currentTrackId || !el.audio.getAttribute("src")) {
    const track = selectedTrack() || getVisibleTracks()[0];
    if (track) playTrack(track.id);
    return;
  }

  if (el.audio.paused) {
    el.audio.play().catch(error => {
      state.playbackError = error.message || "Playback failed.";
      showToast(`Warning: ${state.playbackError}`);
      render();
    });
  } else {
    el.audio.pause();
  }
  renderTransport();
  renderGrid();
}

export function nextTrack() {
  if (state.repeat === "one" && state.currentTrackId) {
    el.audio.currentTime = 0;
    el.audio.play().catch(() => {});
    return;
  }

  if (!state.queue.length) return;
  refreshQueueIndex();

  let nextIndex;
  nextIndex = state.queueIndex + 1;
  if (nextIndex >= state.queue.length) {
    if (state.repeat !== "all") return;
    nextIndex = 0;
    if (state.shuffle && state.queue.length > 2) {
      const currentId = state.currentTrackId;
      const remaining = state.queue.filter(id => id !== currentId);
      state.queue = currentId ? [currentId, ...shuffleIds(remaining)] : shuffleIds(state.queue);
      nextIndex = currentId ? 1 : 0;
    }
  }
  playTrack(state.queue[nextIndex], state.queue, nextIndex);
}

export function prevTrack() {
  if (!state.queue.length) return;
  if (el.audio.currentTime > 3) {
    el.audio.currentTime = 0;
    return;
  }
  refreshQueueIndex();
  const previousIndex = Math.max(0, state.queueIndex - 1);
  playTrack(state.queue[previousIndex], state.queue, previousIndex);
}
