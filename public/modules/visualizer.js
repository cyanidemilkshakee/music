import { el } from "./dom.js";
import { state } from "./state.js";
import * as THREE from 'https://esm.sh/three@0.160.0';

// Web Audio API globals
let audioCtx;
let analyser;
let source;
let dataArray;
let bufferLength;

// Theming globals
let currentThemeColor = '#ffa551';
let currentColorVec3 = new THREE.Vector3(1.0, 0.65, 0.32);

// Three.js globals
let scene, camera, renderer;
let shaderMaterial, vinylMesh, vinylMaterial;

// Render loop flags
let isVisualizerRunning = false;

export function initVisualizer() {
  // Bind Full Screen Events
  if (el.fsExpandBtn) {
    el.fsExpandBtn.addEventListener('click', openFullScreen);
  }
  if (el.fsCloseBtn) {
    el.fsCloseBtn.addEventListener('click', closeFullScreen);
  }

  // Setup Web Audio on first play
  el.audio.addEventListener('play', () => {
    initAudioContext();
  });

  // Init Three.js
  initThreeJS();

  // Start Animation Loop
  if (!isVisualizerRunning) {
    isVisualizerRunning = true;
    requestAnimationFrame(renderLoop);
  }
}

function initAudioContext() {
  if (audioCtx) {
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return;
  }
  
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  analyser = audioCtx.createAnalyser();
  
  // Connect audio element
  source = audioCtx.createMediaElementSource(el.audio);
  source.connect(analyser);
  analyser.connect(audioCtx.destination);
  
  analyser.fftSize = 256;
  bufferLength = analyser.frequencyBinCount;
  dataArray = new Uint8Array(bufferLength);
}

export function updateThemeColor(hex) {
  currentThemeColor = hex;
  const color = new THREE.Color(hex);
  currentColorVec3.set(color.r, color.g, color.b);
  if (shaderMaterial) {
    shaderMaterial.uniforms.u_color.value = currentColorVec3;
  }
  document.documentElement.style.setProperty('--theme-accent', hex);
  document.documentElement.style.setProperty('--theme-bg-1', hex);
}

export function updateVinylArt(url) {
  if (vinylMaterial && url) {
    new THREE.TextureLoader().load(url, (texture) => {
      vinylMaterial.map = texture;
      vinylMaterial.needsUpdate = true;
    });
  }
}

function initThreeJS() {
  if (!el.bgCanvas) return;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.z = 5;

  renderer = new THREE.WebGLRenderer({ canvas: el.bgCanvas, alpha: true, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(window.devicePixelRatio);

  // 1. Liquid Shader Background (FullScreen)
  const planeGeo = new THREE.PlaneGeometry(20, 20, 32, 32);
  
  const vertexShader = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `;
  
  const fragmentShader = `
    uniform float u_time;
    uniform vec3 u_color;
    varying vec2 vUv;

    vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }

    float snoise(vec2 v) {
      const vec4 C = vec4(0.211324865405187,  0.366025403784439, -0.577350269189626,  0.024390243902439);
      vec2 i  = floor(v + dot(v, C.yy) );
      vec2 x0 = v -   i + dot(i, C.xx);
      vec2 i1;
      i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
      vec4 x12 = x0.xyxy + C.xxzz;
      x12.xy -= i1;
      i = mod289(i);
      vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 )) + i.x + vec3(0.0, i1.x, 1.0 ));
      vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
      m = m*m ; m = m*m ;
      vec3 x = 2.0 * fract(p * C.www) - 1.0;
      vec3 h = abs(x) - 0.5;
      vec3 ox = floor(x + 0.5);
      vec3 a0 = x - ox;
      m *= 1.79284291400159 - 0.85373472095314 * ( a0*a0 + h*h );
      vec3 g;
      g.x  = a0.x  * x0.x  + h.x  * x0.y;
      g.yz = a0.yz * x12.xz + h.yz * x12.yw;
      return 130.0 * dot(m, g);
    }

    void main() {
      vec2 uv = vUv;
      float noise = snoise(uv * 3.0 + u_time * 0.2);
      float noise2 = snoise(uv * 2.0 - u_time * 0.1);
      
      vec3 baseColor = vec3(0.05, 0.05, 0.08);
      vec3 highlight = u_color;
      
      float mixFactor = (noise + noise2) * 0.5 + 0.5;
      vec3 finalColor = mix(baseColor, highlight * 0.8, mixFactor);
      
      gl_FragColor = vec4(finalColor, 1.0);
    }
  `;

  shaderMaterial = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      u_time: { value: 0 },
      u_color: { value: currentColorVec3 }
    }
  });

  const bgMesh = new THREE.Mesh(planeGeo, shaderMaterial);
  bgMesh.position.z = -5;
  scene.add(bgMesh);

  // 2. The 3D Vinyl Record
  const vinylGeo = new THREE.CylinderGeometry(2, 2, 0.05, 64);
  
  vinylMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5 });
  const blackVinylMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.3 });
  
  const materials = [
    blackVinylMat, 
    vinylMaterial, 
    blackVinylMat  
  ];

  vinylMesh = new THREE.Mesh(vinylGeo, materials);
  vinylMesh.rotation.x = Math.PI / 2.5; // Tilt it forward
  scene.add(vinylMesh);

  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambientLight);
  const pointLight = new THREE.PointLight(0xffffff, 2, 100);
  pointLight.position.set(2, 3, 4);
  scene.add(pointLight);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

function drawWaveform(canvas, color) {
  if (!canvas || !analyser) return;
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  
  // Skip if hidden
  if (rect.width === 0 || rect.height === 0) return;

  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
  }

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, rect.width, rect.height);
  
  const barWidth = (rect.width / bufferLength) * 2.5;
  let barHeight;
  let x = 0;

  for (let i = 0; i < bufferLength; i++) {
    barHeight = (dataArray[i] / 255) * rect.height;
    ctx.fillStyle = color;
    ctx.fillRect(x, rect.height - barHeight, barWidth, barHeight);
    x += barWidth + 1;
  }
  ctx.restore();
}

function renderLoop(time) {
  requestAnimationFrame(renderLoop);
  
  if (shaderMaterial) {
    shaderMaterial.uniforms.u_time.value = time * 0.001;
  }

  let bassPulse = 0;
  if (analyser) {
    analyser.getByteFrequencyData(dataArray);
    let sum = 0;
    for(let i=0; i<10; i++) sum += dataArray[i];
    bassPulse = sum / 10 / 255; 
  }

  if (vinylMesh) {
    if (!el.audio.paused) {
      vinylMesh.rotation.y -= 0.01 + (bassPulse * 0.02);
    }
    vinylMesh.scale.set(1 + bassPulse * 0.05, 1, 1 + bassPulse * 0.05);
  }

  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }

  if (!el.audio.paused) {
    drawWaveform(el.waveformCanvas, currentThemeColor);
    drawWaveform(el.fsWaveformCanvas, '#ffffff');
  }
}

function openFullScreen() {
  if (el.fullScreenPlayer) {
    el.fullScreenPlayer.classList.remove('is-hidden');
    window.dispatchEvent(new Event('resize'));
  }
}

function closeFullScreen() {
  if (el.fullScreenPlayer) {
    el.fullScreenPlayer.classList.add('is-hidden');
  }
}
