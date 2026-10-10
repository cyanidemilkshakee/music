import { state, DEFAULT_COVER } from "./state.js";
import { icons } from "./icons.js";
import { el } from "./dom.js";
import { coverUrl, fmt, trackSubtitle, trackTitle } from "./utils.js";
import { currentTrack, selectedTrack } from "./helpers.js";

export function renderNowPlaying() {
  const track = currentTrack() || selectedTrack();
  if (!track) {
    el.trackTitle.textContent = "Not Playing";
    el.trackArtist.textContent = "Local Amp";
    el.coverImage.src = DEFAULT_COVER;
    if (el.fsTrackTitle) el.fsTrackTitle.textContent = "Not Playing";
    if (el.fsTrackArtist) el.fsTrackArtist.textContent = "Local Amp";
    return;
  }
  el.trackTitle.textContent = trackTitle(track);
  el.trackArtist.innerHTML = trackSubtitle(track);
  el.coverImage.src = coverUrl(track);
  el.coverImage.onerror = () => { el.coverImage.onerror = null; el.coverImage.src = DEFAULT_COVER; };
  if (el.fsTrackTitle) el.fsTrackTitle.textContent = trackTitle(track);
  if (el.fsTrackArtist) el.fsTrackArtist.textContent = track.artist || "Unknown Artist";
}

export function renderTransport() {
  const status = document.getElementById("playbackStatus");
  status.hidden = !state.playbackError && !state.buffering;
  status.querySelector("span").textContent = state.playbackError || "Preparing audio…";
  document.getElementById("retryPlaybackButton").hidden = !state.playbackError;
  document.getElementById("playbackQuality").textContent = ({ original: "Original audio", flac: "Lossless FLAC fallback", mp3: "MP3 compatibility conversion" })[state.playbackFormat] || "";
  el.playButton.setAttribute("aria-label", el.audio.paused ? "Play" : "Pause");
  el.playButton.title = el.audio.paused ? "Play" : "Pause";
  el.fsPlayButton?.setAttribute("aria-label", el.playButton.title);
  el.shuffleButton.setAttribute("aria-pressed", String(state.shuffle));
  el.fsShuffleButton?.setAttribute("aria-pressed", String(state.shuffle));
  el.repeatButton.setAttribute("aria-pressed", String(state.repeat !== "none"));
  el.playerPill.classList.toggle("is-playing", Boolean(state.currentTrackId && !el.audio.paused));
  el.shuffleButton.classList.toggle("is-active", state.shuffle);
  el.repeatButton.classList.toggle("is-active", state.repeat !== "none");
  el.repeatButton.innerHTML = state.repeat === "one" ? icons["repeat-one"] : icons.repeat;
  el.repeatButton.title = state.repeat === "none" ? "Repeat off" : state.repeat === "all" ? "Repeat all" : "Repeat one";
  el.repeatButton.setAttribute("aria-label", el.repeatButton.title);
  el.fsShuffleButton?.classList.toggle("is-active", state.shuffle);
  if (el.fsShuffleButton) el.fsShuffleButton.title = state.shuffle ? "Shuffle on" : "Shuffle off";
  el.fsRepeatButton?.classList.toggle("is-active", state.repeat !== "none");
  if (el.fsRepeatButton) {
    el.fsRepeatButton.innerHTML = state.repeat === "one" ? icons["repeat-one"] : icons.repeat;
    el.fsRepeatButton.title = el.repeatButton.title;
  }
  if (state.buffering && state.currentTrackId) { el.playButton.innerHTML = icons.spinner; el.playButton.classList.add("is-loading"); }
  else if (el.audio.paused) { el.playButton.innerHTML = icons["play-solid"]; el.playButton.classList.remove("is-loading"); }
  else { el.playButton.innerHTML = icons["pause-solid"]; el.playButton.classList.remove("is-loading"); }
  if (el.fsPlayButton) {
    el.fsPlayButton.innerHTML = el.audio.paused ? icons["play-solid"] : icons["pause-solid"];
    el.fsPlayButton.classList.toggle("is-loading", Boolean(state.buffering && state.currentTrackId));
  }
}

export function updateProgress() {
  const track = currentTrack() || selectedTrack();
  let duration = el.audio.duration;
  if (!Number.isFinite(duration) || Number.isNaN(duration)) duration = track?.duration || 0;
  const current = el.audio.currentTime || 0;
  const percent = duration ? Math.max(0, Math.min(100, current / duration * 100)) : 0;
  el.currentTime.textContent = fmt(current);
  el.timeRemaining.textContent = `-${fmt(Math.max(0, duration - current))}`;
  if (el.fsCurrentTime) el.fsCurrentTime.textContent = fmt(current);
  if (el.fsTimeRemaining) el.fsTimeRemaining.textContent = `-${fmt(Math.max(0, duration - current))}`;
  if (el.scrubberProgress) el.scrubberProgress.style.width = `${percent}%`;
  if (el.scrubberHandle) el.scrubberHandle.style.left = `${percent}%`;
  if (el.seekRange) {
    el.seekRange.disabled = !state.currentTrackId || !Number.isFinite(el.audio.duration) || !el.audio.seekable.length;
    el.seekRange.max = String(Math.max(0, Math.round(duration)));
    el.seekRange.value = String(Math.min(Math.round(current), Math.max(0, Math.round(duration))));
    el.seekRange.setAttribute("aria-valuetext", `${fmt(current)} of ${fmt(duration)}`);
  }
}

export function renderLayoutToggle() {
  const toList = state.layout !== "list";
  el.layoutToggleButton.innerHTML = icons[toList ? "list" : "grid"];
  el.layoutToggleButton.title = toList ? "Switch to List" : "Switch to Grid";
  el.layoutToggleButton.setAttribute("aria-label", el.layoutToggleButton.title);
}
