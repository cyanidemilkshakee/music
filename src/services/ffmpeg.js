const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { AsyncQueue, positiveIntegerEnv } = require('./queue');

function resolveMediaTool(envName, windowsName, fallbackName) {
  const explicit = process.env[envName]?.replace(/^"|"$/g, '').trim();
  if (explicit) return explicit;

  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin', windowsName),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'ffmpeg', 'bin', windowsName),
    path.join('C:\\', 'ffmpeg', 'bin', windowsName)
  ];
  return candidates.find(candidate => fs.existsSync(candidate)) || fallbackName;
}

const FFMPEG_PATH = resolveMediaTool('FFMPEG_PATH', 'ffmpeg.exe', 'ffmpeg');
const FFPROBE_PATH = resolveMediaTool('FFPROBE_PATH', 'ffprobe.exe', 'ffprobe');
const TRANSCODE_CONCURRENCY = positiveIntegerEnv('TRANSCODE_CONCURRENCY', 4, { min: 1, max: 8 });
const FFPROBE_TIMEOUT_MS = positiveIntegerEnv('FFPROBE_TIMEOUT_MS', 45_000, { min: 1000, max: 10 * 60_000 });
const FFMPEG_TIMEOUT_MS = positiveIntegerEnv('FFMPEG_TIMEOUT_MS', 15 * 60_000, { min: 1000, max: 60 * 60_000 });
const MAX_STDERR_CHARS = 16_000;

const transcodeQueue = new AsyncQueue(TRANSCODE_CONCURRENCY);

function hash(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function trimOutput(value, limit = MAX_STDERR_CHARS) {
  const text = String(value || '');
  return text.length > limit ? text.slice(-limit) : text;
}

function commandFailureMessage(command, error) {
  const stderr = String(error.stderr || '').trim();
  const base = stderr || error.message || `${command} failed.`;
  if (error.killed || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT') {
    return `${command} timed out.`;
  }
  if (error.code === 'EPERM') {
    return `${command} could not be launched by Node (EPERM). Restart the server or check paths.`;
  }
  if (error.code === 'ENOENT') {
    return `${command} was not found. Install FFmpeg or set FFMPEG_PATH/FFPROBE_PATH.`;
  }
  return base.split(/\r?\n/).slice(0, 3).join(' ');
}

function runFile(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      maxBuffer: 24 * 1024 * 1024,
      timeout: options.timeout ?? FFPROBE_TIMEOUT_MS,
      windowsHide: true,
      ...options
    }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = trimOutput(stderr);
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeout ?? FFMPEG_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref();

    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        error.stderr = trimOutput(error.stderr || stderr);
        reject(error);
        return;
      }
      resolve();
    }

    child.stderr.on('data', chunk => {
      stderr = trimOutput(stderr + chunk.toString());
    });
    child.on('error', finish);
    child.on('close', (code, signal) => {
      if (code === 0 && !timedOut) {
        finish();
        return;
      }
      const error = new Error(timedOut ? `${command} timed out.` : `${command} exited with ${code ?? signal}`);
      error.code = timedOut ? 'ETIMEDOUT' : code;
      error.signal = signal;
      finish(error);
    });
  });
}

const CACHE_DIR = path.join(__dirname, '..', '..', 'data', 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

function cachePathForTrack(track) {
  if (!track || !track.id || !track.path) {
    throw new Error('Track id and path are required for cache lookup.');
  }
  const basis = `${track.path}|${track.modifiedAt}|${track.size}`;
  const safeId = String(track.id).replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 120);
  return path.join(CACHE_DIR, `${safeId}-${hash(basis).slice(0, 16)}.mp3`);
}

async function removeIfExists(filePath) {
  await fs.promises.rm(filePath, { force: true }).catch(() => {});
}

async function isUsableCacheFile(filePath) {
  const stat = await fs.promises.stat(filePath).catch(() => null);
  return Boolean(stat && stat.isFile() && stat.size > 0);
}

async function clearAudioCache() {
  const entries = await fs.promises.readdir(CACHE_DIR, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  let removed = 0;
  let bytes = 0;

  for (const entry of entries) {
    if (!entry.isFile() || !/\.(mp3|tmp\.mp3)$/i.test(entry.name)) continue;
    const filePath = path.join(CACHE_DIR, entry.name);
    const resolved = path.resolve(filePath);
    if (path.dirname(resolved) !== path.resolve(CACHE_DIR)) continue;

    const stat = await fs.promises.stat(resolved).catch(() => null);
    await fs.promises.rm(resolved, { force: true }).catch(() => {});
    removed++;
    bytes += stat?.size || 0;
  }

  return { removed, bytes };
}

async function ensureDecoded(track) {
  const outputPath = cachePathForTrack(track);
  const outputDir = path.dirname(outputPath);
  if (path.resolve(outputDir) !== path.resolve(CACHE_DIR)) {
    throw new Error('Resolved cache path escaped cache directory.');
  }

  if (await isUsableCacheFile(outputPath)) {
    return outputPath;
  }
  await removeIfExists(outputPath);

  return transcodeQueue.run(async () => {
    if (await isUsableCacheFile(outputPath)) return outputPath;
    await removeIfExists(outputPath);

    await fs.promises.access(track.path, fs.constants.R_OK);
    const tempPath = path.join(CACHE_DIR, `${path.basename(outputPath, '.mp3')}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp.mp3`);

    try {
      await runProcess(FFMPEG_PATH, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', track.path,
        '-vn', '-map_metadata', '0', '-codec:a', 'libmp3lame', '-q:a', '2', tempPath
      ]).catch(error => {
        error.message = commandFailureMessage(FFMPEG_PATH, error);
        throw error;
      });
      if (!await isUsableCacheFile(tempPath)) {
        throw new Error('Transcoded audio cache was empty.');
      }
      await removeIfExists(outputPath);
      await fs.promises.rename(tempPath, outputPath);
      return outputPath;
    } catch (error) {
      await removeIfExists(tempPath);
      throw error;
    }
  });
}

async function probeTrackMetadata(filePath) {
  const { stdout } = await runFile(FFPROBE_PATH, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath
  ]).catch(error => {
    error.message = commandFailureMessage(FFPROBE_PATH, error);
    throw error;
  });

  try {
    return JSON.parse(stdout || '{}');
  } catch (error) {
    error.message = `ffprobe returned invalid JSON for ${path.basename(filePath)}.`;
    throw error;
  }
}

module.exports = {
  FFMPEG_PATH,
  FFPROBE_PATH,
  cachePathForTrack,
  commandFailureMessage,
  clearAudioCache,
  ensureDecoded,
  probeTrackMetadata,
  runFile,
  trimOutput
};
