import { el } from "./dom.js";

let audioContext;
let analyser;
let source;
let frequencies;
let currentThemeColor = "#ffa551";
let artwork = null;
let rotation = 0;
let running = false;

export function initVisualizer() {
  el.fsExpandBtn?.addEventListener("click", openFullScreen);
  el.fsCloseBtn?.addEventListener("click", closeFullScreen);
  el.audio.addEventListener("play", initAudioContext, { once: true });
  window.addEventListener("resize", resizeBackground);
  resizeBackground();
  if (!running) {
    running = true;
    requestAnimationFrame(renderLoop);
  }
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
  source.connect(analyser);
  analyser.connect(audioContext.destination);
}

export function updateThemeColor(hex) {
  currentThemeColor = hex;
  document.documentElement.style.setProperty("--theme-accent", hex);
  document.documentElement.style.setProperty("--theme-bg-1", hex);
}

export function updateVinylArt(url) {
  if (!url) {
    artwork = null;
    return;
  }
  const image = new Image();
  image.decoding = "async";
  image.onload = () => { artwork = image; };
  image.onerror = () => { artwork = null; };
  image.src = url;
}

function resizeBackground() {
  const canvas = el.bgCanvas;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
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
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);

  const gradient = context.createRadialGradient(width * .5, height * .42, Math.min(width, height) * .04, width * .5, height * .42, Math.max(width, height) * (.66 + pulse * .08));
  gradient.addColorStop(0, currentThemeColor);
  gradient.addColorStop(.32, "#171724");
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
    context.fillStyle = currentThemeColor;
    context.fill();
  }
  context.restore();
  context.fillStyle = "#e9e9ef";
  context.beginPath();
  context.arc(0, 0, radius * .06, 0, Math.PI * 2);
  context.fill();
  context.restore();
}

function drawWaveform(canvas, color) {
  if (!canvas || !frequencies) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = window.devicePixelRatio || 1;
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
  requestAnimationFrame(renderLoop);
  const pulse = energy();
  if (!el.audio.paused) rotation += .01 + pulse * .02;
  drawBackground(pulse);
  if (!el.audio.paused) {
    drawWaveform(el.waveformCanvas, currentThemeColor);
    drawWaveform(el.fsWaveformCanvas, "#ffffff");
  }
}

function openFullScreen() {
  el.fullScreenPlayer?.classList.remove("is-hidden");
  el.fullScreenPlayer?.setAttribute("aria-hidden", "false");
  resizeBackground();
}

function closeFullScreen() {
  el.fullScreenPlayer?.classList.add("is-hidden");
  el.fullScreenPlayer?.setAttribute("aria-hidden", "true");
}
