import { state } from "./state.js";
import { el } from "./dom.js";
import { api } from "./api.js";
import { showToast } from "./toast.js";
import { render, renderGrid, renderTransport, renderQueue } from "./render.js";
import { getVisibleTracks } from "./sort.js";
import { selectedTrack, playlistTracks } from "./helpers.js";
import { getStorage, setStorage } from "./storage.js";
import { coverUrl } from "./utils.js";
import { updateThemeColor, updateVinylArt } from "./visualizer.js";

let playRequestId = 0;
let activeDecodeController = null;
const QUEUE_STORAGE_KEY = "amp-queue";

function persistQueue() {
  setStorage(QUEUE_STORAGE_KEY, JSON.stringify({
    ids: state.queue,
    index: state.queueIndex,
    shuffle: state.shuffle,
    repeat: state.repeat,
  }));
}

export function restoreQueue() {
  try {
    const saved = JSON.parse(getStorage(QUEUE_STORAGE_KEY, "{}"));
    const validIds = new Set(state.tracks.map(track => track.id));
    const ids = Array.isArray(saved.ids) ? saved.ids.filter(id => validIds.has(id)) : [];
    if (ids.length) {
      state.queue = ids;
      state.queueIndex = Math.max(-1, Math.min(Number(saved.index) || -1, ids.length - 1));
    }
    state.shuffle = Boolean(saved.shuffle);
    state.repeat = ["none", "all", "one"].includes(saved.repeat) ? saved.repeat : "none";
  } catch {
    // Queue persistence is a convenience; a corrupt local value should not affect playback.
  }
}

async function updateThemeFromArtwork(url) {
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  await image.decode();

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, 1, 1);
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  const hex = `#${[red, green, blue].map(value => value.toString(16).padStart(2, "0")).join("")}`;
  updateThemeColor(hex);
}

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
  persistQueue();
  renderTransport();
  renderQueue();
}

export function cycleRepeat() {
  const cycle = { none: "all", all: "one", one: "none" };
  state.repeat = cycle[state.repeat] || "none";
  persistQueue();
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
  persistQueue();
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
  persistQueue();
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
  persistQueue();
  render();
}

export function moveQueueItem(fromIndex, toIndex) {
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)
    || fromIndex < 0 || toIndex < 0
    || fromIndex >= state.queue.length || toIndex >= state.queue.length
    || fromIndex === toIndex) return;
  const [trackId] = state.queue.splice(fromIndex, 1);
  state.queue.splice(toIndex, 0, trackId);
  refreshQueueIndex();
  persistQueue();
  renderQueue();
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
  persistQueue();
  setStorage("amp-last-played", track.id);

  if (track.hasArtwork) {
    const artUrl = coverUrl(track);
    updateVinylArt(artUrl);
    updateThemeFromArtwork(artUrl)
      .catch(() => {}); // silently ignore — no artwork embedded
  } else {
    updateVinylArt(null); // reset to default
  }

  render();
  api(`/api/recent/${encodeURIComponent(track.id)}`, { method: "POST", timeoutMs: 10_000 })
    .then(() => { state.recentIds = [track.id, ...state.recentIds.filter(id => id !== track.id)].slice(0, 50); })
    .catch(() => {});

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
