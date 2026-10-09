import { state } from "./state.js";
import { el } from "./dom.js";
import { api } from "./api.js";
import { showToast } from "./toast.js";
import { render, renderGrid, renderTransport, renderQueue } from "./render.js";
import { getVisibleTracks } from "./sort.js";
import { selectedTrack } from "./helpers.js";
import { getStorage, setStorage } from "./storage.js";
import { coverUrl } from "./utils.js";
import { updateVinylArt } from "./visualizer.js";
import { createEntries, shuffled, moveEntry, nextIndex } from "./queue-model.js";
import { ensureTracks, matchingTrackIds } from "./library-data.js";

let entries = [], base = [];
let playRequestId = 0, activeDecodeController = null, recordedRequest = 0;
let resumePosition = 0, persistedAt = 0;
function currentKey() { return entries[state.queueIndex]?.key; }
function syncQueue(key = currentKey()) {
  state.queue = entries.map(entry => entry.id);
  state.queueIndex = entries.findIndex(entry => entry.key === key);
}
function persistQueue() {
  setStorage("amp-queue", JSON.stringify({ entries, base, index: state.queueIndex, shuffle: state.shuffle, repeat: state.repeat,
    position: !el.audio.getAttribute("src") && resumePosition > 0 ? resumePosition : (Number.isFinite(el.audio.currentTime) ? el.audio.currentTime : 0) }));
}
export function restoreQueue() {
  try {
    const saved = JSON.parse(getStorage("amp-queue", "{}"));
    const valid = new Set(state.trackIds);
    const raw = Array.isArray(saved.entries) ? saved.entries : createEntries(Array.isArray(saved.ids) ? saved.ids : state.queue);
    const key = raw[saved.index]?.key;
    const seen = new Set();
    entries = raw.filter(entry => typeof entry.key === "string" && valid.has(entry.id) && !seen.has(entry.key) && seen.add(entry.key));
    const byKey = new Map(entries.map(entry => [entry.key, entry]));
    base = Array.isArray(saved.base) ? saved.base.map(entry => byKey.get(entry.key)).filter(Boolean) : [...entries];
    const baseKeys = new Set(base.map(entry => entry.key));
    base.push(...entries.filter(entry => !baseKeys.has(entry.key)));
    state.shuffle = Boolean(saved.shuffle);
    state.repeat = ["none", "one", "all"].includes(saved.repeat) ? saved.repeat : "none";
    syncQueue(key);
    state.currentTrackId = state.queue[state.queueIndex] || null;
    if (state.currentTrackId) state.selectedTrackId = state.currentTrackId;
    resumePosition = Math.max(0, Number(saved.position) || 0);
  } catch { entries = createEntries(state.queue); base = [...entries]; syncQueue(); }
}
export function storedVolume() {
  const value = Number.parseFloat(getStorage("amp-volume", "1"));
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}
async function contextQueue(id, signal) {
  const visible = getVisibleTracks().map(track => track.id);
  if (!visible.includes(id)) return state.trackIds;
  return matchingTrackIds({}, signal);
}
export function reconcileQueue() {
  const key = currentKey(), valid = new Set(state.trackIds);
  entries = entries.filter(entry => valid.has(entry.id));
  base = base.filter(entry => valid.has(entry.id));
  syncQueue(key); persistQueue();
}
export function setShuffle(enabled) {
  if (state.shuffle === Boolean(enabled)) return;
  const key = currentKey();
  state.shuffle = Boolean(enabled);
  entries = state.shuffle ? shuffled(entries, key) : [...base];
  syncQueue(key); persistQueue(); renderTransport(); renderQueue();
}
export function cycleRepeat() {
  state.repeat = ({ none: "all", all: "one", one: "none" })[state.repeat] || "none";
  persistQueue(); renderTransport(); renderQueue();
}
export function queueTrack(id, placement = "end") {
  if (!state.trackIds.includes(id)) return;
  const key = currentKey(), entry = createEntries([id])[0];
  const at = placement === "next" ? Math.max(0, state.queueIndex + 1) : entries.length;
  entries.splice(at, 0, entry);
  const baseAt = placement === "next" ? Math.max(0, base.findIndex(item => item.key === key) + 1) : base.length;
  base.splice(baseAt, 0, entry);
  syncQueue(key); persistQueue(); renderQueue();
  showToast(placement === "next" ? "Playing next" : "Added to queue");
}
export function clearQueue() {
  const current = entries[state.queueIndex];
  entries = current ? [current] : []; base = [...entries];
  syncQueue(current?.key); persistQueue(); renderQueue();
}
export function removeQueueItem(index) {
  if (!entries[index]) return;
  const key = currentKey(), removed = entries[index];
  entries.splice(index, 1); base = base.filter(entry => entry.key !== removed.key);
  syncQueue(key);
  if (removed.key === key) {
    const next = Math.min(index, entries.length - 1);
    if (next >= 0) playTrack(entries[next].id, state.queue, next);
    else { el.audio.pause(); el.audio.removeAttribute("src"); state.currentTrackId = null; render(); }
  }
  persistQueue(); renderQueue();
}
export function moveQueueItem(from, to) {
  const key = currentKey(); entries = moveEntry(entries, from, to);
  base = [...entries]; syncQueue(key); persistQueue(); renderQueue();
}
export function playPlaylist(playlist) {
  const valid = new Set(state.trackIds);
  const ids = playlist.trackIds.filter(id => valid.has(id));
  if (ids.length) return playTrack(ids[0], ids, 0);
  showToast("This playlist is empty.");
}
function playbackFormat(track) {
  const ext = (track.fileName || "").split(".").pop().toLowerCase();
  const mime = ({mp3:"audio/mpeg",flac:"audio/flac",wav:"audio/wav",m4a:'audio/mp4; codecs="mp4a.40.2"',aac:"audio/aac",ogg:"audio/ogg",opus:'audio/ogg; codecs="opus"'})[ext];
  if (getStorage("amp-quality", "lossless") === "compatibility") return ext === "mp3" ? "original" : "mp3";
  if (mime && el.audio.canPlayType(mime) && track.codec !== "alac") return "original";
  return el.audio.canPlayType("audio/flac") ? "flac" : "mp3";
}
export function updatePlayingMetadata() {
  const track = state.tracks.find(item => item.id === state.currentTrackId);
  updateVinylArt(track?.hasArtwork ? coverUrl(track) : null);
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = track ? new MediaMetadata({
      title: track.title || track.fileName, artist: track.artist || '', album: track.album || '',
      artwork: [{ src: coverUrl(track), sizes: '512x512' }]
    }) : null;
  }
}
export async function playTrack(id, queueIds = null, requestedIndex = null) {
  if (!state.trackIds.includes(id)) return;
  const preserves = queueIds === state.queue;
  const requestedKey = preserves
    ? (Number.isInteger(requestedIndex) && entries[requestedIndex]?.id === id
      ? entries[requestedIndex].key : entries.find(entry => entry.id === id)?.key) : null;
  const request = ++playRequestId;
  activeDecodeController?.abort(); activeDecodeController = new AbortController();
  const controller = activeDecodeController;
  state.playbackError = ''; state.buffering = true; renderTransport();
  try {
    await ensureTracks([id]);
    if (request !== playRequestId) return;
    const track = state.tracks.find(track => track.id === id);
    if (!track) throw new Error('This track is no longer in the library. Refresh the library and try again.');
    if (!preserves) {
      const context = queueIds || await contextQueue(id, controller.signal);
      if (request !== playRequestId) return;
      const valid = new Set(state.trackIds);
      if (!valid.has(id)) { state.buffering = false; renderTransport(); return; }
      base = createEntries(context.filter(id => valid.has(id)));
      let index = Number.isInteger(requestedIndex) && base[requestedIndex]?.id === id ? requestedIndex : base.findIndex(entry => entry.id === id);
      if (index < 0) { base.push(...createEntries([id])); index = base.length - 1; }
      const key = base[index].key;
      entries = state.shuffle ? shuffled(base, key) : [...base]; syncQueue(key);
    } else {
      const index = entries.findIndex(entry => entry.key === requestedKey);
      if (index < 0) { state.buffering = false; renderTransport(); return; }
      state.queueIndex = index;
    }
    const position = id === state.currentTrackId && !el.audio.getAttribute('src') ? resumePosition : 0;
    resumePosition = 0;
    el.audio.pause(); el.audio.removeAttribute('src'); el.audio.load();
    state.currentTrackId = state.selectedTrackId = id; state.playbackFormat = '';
    setStorage('amp-last-played', id);
    updatePlayingMetadata();
    render(); persistQueue();
    const data = await api('/api/decode/' + encodeURIComponent(id), { method: 'POST', body: JSON.stringify({ format: playbackFormat(track) }),
      signal: controller.signal, timeoutMs: 15 * 60000 });
    if (request !== playRequestId) return;
    state.playbackFormat = data.format;
    el.audio.src = data.audioUrl; el.audio.volume = storedVolume();
    if (position > 0) el.audio.addEventListener('loadedmetadata', () => {
      if (request === playRequestId && Number.isFinite(el.audio.duration)) el.audio.currentTime = Math.min(position, el.audio.duration);
    }, { once: true });
    await el.audio.play();
    if (request !== playRequestId) return;
    state.buffering = false;
    renderTransport(); renderGrid();
  } catch (error) {
    if (request !== playRequestId || controller.signal.aborted) return;
    state.buffering = false; state.playbackError = error.message || 'Playback failed.';
    el.audio.pause(); el.audio.removeAttribute('src');
    showToast(state.playbackError); render();
  } finally { if (request === playRequestId) activeDecodeController = null; }
}
export function playPause() {
  if (!el.audio.getAttribute("src")) {
    const id = state.currentTrackId || selectedTrack()?.id || getVisibleTracks()[0]?.id;
    if (id) return playTrack(id, state.queue.includes(id) ? state.queue : null, state.queueIndex);
    return;
  }
  if (el.audio.paused) el.audio.play().catch(error => showToast(error.message));
  else el.audio.pause();
}
export function nextTrack(ended = false) {
  const next = nextIndex(state.queueIndex, state.queue.length, state.repeat, ended === true);
  if (next < 0) { persistQueue(); renderTransport(); return; }
  if (ended === true && next === state.queueIndex) { el.audio.currentTime = 0; el.audio.play().catch(error => showToast(error.message)); return; }
  return playTrack(state.queue[next], state.queue, next);
}
export function prevTrack() {
  if (el.audio.currentTime > 3) { el.audio.currentTime = 0; return; }
  const index = Math.max(0, state.queueIndex - 1);
  if (state.queue[index]) return playTrack(state.queue[index], state.queue, index);
}
el.audio.addEventListener("playing", () => {
  if (recordedRequest === playRequestId || !state.currentTrackId) return;
  recordedRequest = playRequestId; const id = state.currentTrackId;
  api("/api/recent/" + encodeURIComponent(id), {method:"POST"}).then(data => { state.recentIds = data.recentIds || []; if (state.filters.recentlyPlayed) renderGrid(); }).catch(() => {});
});
el.audio.addEventListener("timeupdate", () => {
  if (Date.now() - persistedAt > 5000) { persistedAt = Date.now(); persistQueue(); }
  if ("mediaSession" in navigator && Number.isFinite(el.audio.duration) && el.audio.duration > 0) {
    try { navigator.mediaSession.setPositionState({duration:el.audio.duration,playbackRate:el.audio.playbackRate,position:Math.min(el.audio.currentTime,el.audio.duration)}); } catch { /* Unsupported platform. */ }
  }
});
window.addEventListener("pagehide", persistQueue);
if ("mediaSession" in navigator) {
  for (const [action, handler] of Object.entries({play:playPause,pause:()=>el.audio.pause(),previoustrack:prevTrack,nexttrack:()=>nextTrack(),
    seekto:event=>{ if (Number.isFinite(event.seekTime)) el.audio.currentTime=event.seekTime; }})) {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* Unsupported action. */ }
  }
}
