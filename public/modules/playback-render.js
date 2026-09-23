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
    return;
  }
  el.trackTitle.textContent = trackTitle(track);
  el.trackArtist.innerHTML = trackSubtitle(track);
  el.coverImage.src = coverUrl(track);
  el.coverImage.onerror = () => { el.coverImage.onerror = null; el.coverImage.src = DEFAULT_COVER; };
}

export function renderTransport() {
  el.playerPill.classList.toggle("is-playing", Boolean(state.currentTrackId && !el.audio.paused));
  el.shuffleButton.classList.toggle("is-active", state.shuffle);
  el.repeatButton.classList.toggle("is-active", state.repeat !== "none");
  el.repeatButton.innerHTML = state.repeat === "one" ? icons["repeat-one"] : icons.repeat;
  el.repeatButton.title = state.repeat === "none" ? "Repeat off" : state.repeat === "all" ? "Repeat all" : "Repeat one";
  if (state.buffering && state.currentTrackId) { el.playButton.innerHTML = icons.spinner; el.playButton.classList.add("is-loading"); }
  else if (el.audio.paused) { el.playButton.innerHTML = icons["play-solid"]; el.playButton.classList.remove("is-loading"); }
  else { el.playButton.innerHTML = icons["pause-solid"]; el.playButton.classList.remove("is-loading"); }
}

export function updateProgress() {
  const track = currentTrack() || selectedTrack();
  let duration = el.audio.duration;
  if (!Number.isFinite(duration) || Number.isNaN(duration)) duration = track?.duration || 0;
  const current = el.audio.currentTime || 0;
  const percent = duration ? Math.max(0, Math.min(100, current / duration * 100)) : 0;
  el.currentTime.textContent = fmt(current);
  el.timeRemaining.textContent = `-${fmt(Math.max(0, duration - current))}`;
  if (el.scrubberProgress) el.scrubberProgress.style.width = `${percent}%`;
  if (el.scrubberHandle) el.scrubberHandle.style.left = `${percent}%`;
  if (el.seekRange) { el.seekRange.max = String(Math.max(0, Math.round(duration))); el.seekRange.value = String(Math.min(Math.round(current), Math.max(0, Math.round(duration)))); }
}

export function renderLayoutToggle() {
  const toList = state.layout !== "list";
  el.layoutToggleButton.innerHTML = icons[toList ? "list" : "grid"];
  el.layoutToggleButton.title = toList ? "Switch to List" : "Switch to Grid";
  el.layoutToggleButton.setAttribute("aria-label", el.layoutToggleButton.title);
}
