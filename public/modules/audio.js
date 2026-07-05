import { state } from "./state.js";
import { el } from "./dom.js";
import { icons } from "./icons.js";
import { showToast } from "./toast.js";
import { renderTransport, renderGrid, renderNowPlaying, updateProgress } from "./render.js";
import { nextTrack, storedVolume } from "./player.js";
import { setStorage } from "./storage.js";

export function updateVolumeUI() {
  const volume = el.audio.muted ? 0 : el.audio.volume;
  el.volProgress.style.height = `${Math.max(0, Math.min(1, volume)) * 100}%`;

  let iconKey = "volume-high";
  if (volume === 0 || el.audio.muted) iconKey = "volume-mute";
  else if (volume < 0.35) iconKey = "volume-low";
  else if (volume < 0.70) iconKey = "volume-mid";
  el.muteBtn.innerHTML = icons[iconKey] || "";
}

function setVolumeAt(clientY) {
  const rect = el.volScrubberBg.getBoundingClientRect();
  if (!rect.height) return;
  const ratio = Math.min(1, Math.max(0, (rect.bottom - clientY) / rect.height));
  el.audio.volume = ratio;
  if (ratio > 0) el.audio.muted = false;
  updateVolumeUI();
  setStorage("amp-volume", ratio);
}

let scrubbing = false;
let volScrubbing = false;

function scrubAt(clientX) {
  const rect = el.scrubberBar.getBoundingClientRect();
  if (!rect.width) return;
  const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  const duration = Number(el.audio.duration) || 0;
  if (!Number.isFinite(duration) || duration <= 0) return;
  el.audio.currentTime = ratio * duration;
  updateProgress();
}

el.scrubberBar.addEventListener("mousedown", event => {
  scrubbing = true;
  scrubAt(event.clientX);
});
el.scrubberBar.addEventListener("touchstart", event => {
  if (!event.touches[0]) return;
  scrubbing = true;
  scrubAt(event.touches[0].clientX);
  event.preventDefault();
}, { passive: false });

el.volScrubberBg.addEventListener("mousedown", event => {
  volScrubbing = true;
  setVolumeAt(event.clientY);
});

document.addEventListener("mousemove", event => {
  if (scrubbing) scrubAt(event.clientX);
  if (volScrubbing) setVolumeAt(event.clientY);
});
document.addEventListener("touchmove", event => {
  if (scrubbing && event.touches[0]) {
    scrubAt(event.touches[0].clientX);
    event.preventDefault();
  }
}, { passive: false });
document.addEventListener("mouseup", () => {
  scrubbing = false;
  volScrubbing = false;
});
document.addEventListener("touchend", () => {
  scrubbing = false;
  volScrubbing = false;
});

el.muteBtn.addEventListener("click", () => {
  if (el.audio.muted) {
    el.audio.muted = false;
    if (el.audio.volume === 0) el.audio.volume = storedVolume() || 1;
  } else {
    el.audio.muted = true;
  }
  updateVolumeUI();
});

el.audio.addEventListener("timeupdate", updateProgress);
el.audio.addEventListener("loadedmetadata", updateProgress);
el.audio.addEventListener("play", () => {
  state.buffering = false;
  renderTransport();
  renderGrid();
});
el.audio.addEventListener("pause", () => {
  renderTransport();
  renderGrid();
});
el.audio.addEventListener("ended", nextTrack);

el.audio.addEventListener("waiting", () => {
  state.buffering = true;
  renderTransport();
});
el.audio.addEventListener("canplay", () => {
  state.buffering = false;
  renderTransport();
});
el.audio.addEventListener("stalled", () => {
  state.buffering = true;
  renderTransport();
});

el.audio.addEventListener("error", () => {
  if (!state.currentTrackId && !el.audio.getAttribute("src")) return;
  const codes = {
    1: "Playback aborted.",
    2: "Network error during playback.",
    3: "Audio decoding failed.",
    4: "Audio format not supported."
  };
  const error = el.audio.error;
  const message = (error && codes[error.code]) || "An audio error occurred.";
  state.buffering = false;
  state.currentTrackId = null;
  showToast(`Warning: ${message}`);
  renderTransport();
  renderGrid();
  renderNowPlaying();
});
