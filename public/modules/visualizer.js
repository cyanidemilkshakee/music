import { trapModalFocus } from "./modal-focus.js";
import { api } from "./api.js";
import { state } from "./state.js";
import { getStorage } from "./storage.js";
import { el } from "./dom.js";

let audioContext;
let analyser;
let source;
let frequencies;
const THEME_COLOR = "#ffa551";
let artwork = null;
let rotation = 0;
let running = false, frame = 0, artRequest = 0, releaseFocus = null, gainNode, gainRequest = 0;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
function schedule() {
  if(running || document.hidden || el.fullScreenPlayer?.classList.contains("is-hidden")) return;
  running=true; frame=requestAnimationFrame(renderLoop);
}
async function setGain() {
  const request = ++gainRequest;
  if(!gainNode) return;
  gainNode.gain.value=1;
  if(getStorage("amp-replaygain","off")!=="track" || !state.currentTrackId) return;
  const id=state.currentTrackId;
  try {
    const {track}=await api("/api/tracks/"+encodeURIComponent(id));
    if(state.currentTrackId!==id || request !== gainRequest || getStorage('amp-replaygain','off') !== 'track') return;
    const db=Number.parseFloat(track.tags?.replaygain_track_gain);
    const peak=Number.parseFloat(track.tags?.replaygain_track_peak);
    if(Number.isFinite(db)) gainNode.gain.value=Math.min(1,10**(db/20),Number.isFinite(peak) && peak>0 ? 1/peak : 1);
  } catch { /* Missing tags leave the source level unchanged. */ }
}

export function initVisualizer() {
  document.addEventListener('playback-preferences-changed', setGain);
  document.addEventListener('library-updated', setGain);
  window.addEventListener('storage', event => { if (event.key === 'amp-replaygain') setGain(); });
  el.fsExpandBtn?.addEventListener("click", openFullScreen);
  el.fsCloseBtn?.addEventListener("click", closeFullScreen);
  el.audio.addEventListener("play", () => { try { initAudioContext(); setGain(); schedule(); } catch(error) { console.warn("Visualizer unavailable",error); } });
  el.audio.addEventListener("pause", schedule);
  document.addEventListener("visibilitychange", () => { if(document.hidden) {cancelAnimationFrame(frame);running=false;} else schedule(); });
  reducedMotion.addEventListener("change",()=>{cancelAnimationFrame(frame);running=false;schedule();});
  window.addEventListener("resize", resizeBackground);
  resizeBackground();
  schedule();
}

function initAudioContext() {
  if (audioContext) {
    if (audioContext.state === "suspended") audioContext.resume();
    return;
  }
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  frequencies = new Uint8Array(analyser.frequencyBinCount);
  source = audioContext.createMediaElementSource(el.audio);
  gainNode=audioContext.createGain();
  source.connect(gainNode);gainNode.connect(analyser);analyser.connect(audioContext.destination);
}

export function updateVinylArt(url) {
  const request=++artRequest;
  if (!url) {
    artwork = null;
    return;
  }
  const image = new Image();
  image.decoding = "async";
  image.onload = () => { if(request===artRequest) {artwork=image;schedule();} };
  image.onerror = () => { if(request===artRequest) artwork=null; };
  image.src = url;
}

function resizeBackground() {
  const canvas = el.bgCanvas;
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1,2);
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
}

function energy() {
  if (!analyser || !frequencies) return 0;
  analyser.getByteFrequencyData(frequencies);
  let total = 0;
  for (let index = 0; index < 12; index += 1) total += frequencies[index];
  return total / (12 * 255);
}

function drawBackground(pulse) {
  const canvas = el.bgCanvas;
  if (!canvas) return;
  const context = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1,2);
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);

  const gradient = context.createRadialGradient(width * .5, height * .42, Math.min(width, height) * .04, width * .5, height * .42, Math.max(width, height) * (.66 + pulse * .08));
  gradient.addColorStop(0, THEME_COLOR);
  gradient.addColorStop(.32, "#171717");
  gradient.addColorStop(1, "#050508");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  const radius = Math.min(width, height) * (.22 + pulse * .035);
  context.save();
  context.translate(width / 2, height * .42);
  context.rotate(rotation);
  context.fillStyle = "#09090b";
  context.beginPath();
  context.arc(0, 0, radius, 0, Math.PI * 2);
  context.fill();
  context.strokeStyle = "rgba(255,255,255,.16)";
  context.lineWidth = 1;
  for (let ratio = .2; ratio < .95; ratio += .13) {
    context.beginPath();
    context.arc(0, 0, radius * ratio, 0, Math.PI * 2);
    context.stroke();
  }
  context.save();
  context.beginPath();
  context.arc(0, 0, radius * .52, 0, Math.PI * 2);
  context.clip();
  if (artwork) {
    const size = radius * 1.04;
    context.drawImage(artwork, -size / 2, -size / 2, size, size);
  } else {
    context.fillStyle = THEME_COLOR;
    context.fill();
  }
  context.restore();
  context.fillStyle = "#e9e9e9";
  context.beginPath();
  context.arc(0, 0, radius * .06, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawWaveform(canvas, color) {
  if (!canvas || !frequencies) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.min(window.devicePixelRatio || 1,2);
  if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) {
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
  }
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  const barWidth = rect.width / frequencies.length;
  context.fillStyle = color;
  for (let index = 0; index < frequencies.length; index += 1) {
    const barHeight = Math.max(2, (frequencies[index] / 255) * rect.height);
    context.fillRect(index * barWidth, rect.height - barHeight, Math.max(1, barWidth - 1), barHeight);
  }
}

function renderLoop() {
  running=false;
  if(document.hidden || el.fullScreenPlayer?.classList.contains("is-hidden")) return;
  const pulse = energy();
  if (!el.audio.paused && !reducedMotion.matches) rotation += .01 + pulse * .02;
  drawBackground(pulse);
  if (!el.audio.paused) {
    drawWaveform(el.fsWaveformCanvas, "#ffffff");
  }
  if(!el.audio.paused && !reducedMotion.matches) schedule();
}

function openFullScreen() {
  el.fullScreenPlayer?.classList.remove("is-hidden");
  el.fullScreenPlayer?.setAttribute("aria-hidden", "false");
  resizeBackground();
  releaseFocus=trapModalFocus(el.fullScreenPlayer,{onClose:closeFullScreen,initialFocus:el.fsCloseBtn});
  schedule();
}

function closeFullScreen() {
  releaseFocus?.();releaseFocus=null;cancelAnimationFrame(frame);running=false;
  el.fullScreenPlayer?.classList.add("is-hidden");
  el.fullScreenPlayer?.setAttribute("aria-hidden", "true");
}
