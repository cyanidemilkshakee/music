const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { probeTrackMetadata } = require('./ffmpeg');
const { AsyncQueue, positiveIntegerEnv } = require('./queue');
const db = require('./db');
const { httpError } = require('../utils/http');

const AUDIO_EXTENSIONS = new Set([
  '.aac', '.aif', '.aiff', '.alac', '.flac',
  '.m4a', '.mp3', '.ogg', '.opus', '.wav', '.wma'
]);

const SCAN_CONCURRENCY = positiveIntegerEnv('SCAN_CONCURRENCY', 8, { min: 1, max: 32 });
const MAX_SCAN_FILES = positiveIntegerEnv('MAX_SCAN_FILES', 100_000, { min: 1, max: 1_000_000 });
const MAX_SCAN_FAILURES = positiveIntegerEnv('MAX_SCAN_FAILURES', 1000, { min: 1, max: 100_000 });

let scanInFlight = false;

function hash(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function normalizeTags(tags = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(tags || {})) {
    normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return normalized;
}

function firstTag(tags, keys, fallback = '') {
  for (const key of keys) {
    if (tags[key] && String(tags[key]).trim()) {
      return String(tags[key]).trim();
    }
  }
  return fallback;
}

function titleFromFilename(filePath) {
  return path.basename(filePath, path.extname(filePath)).replace(/[_-]+/g, ' ').trim();
}

function parseNumber(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const number = Number(String(value).split('/')[0]);
  return Number.isFinite(number) ? number : null;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseTrack(filePath, stat, probe) {
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const audio = streams.find(stream => stream.codec_type === 'audio') || {};
  const format = probe.format || {};
  const tags = normalizeTags({ ...(format.tags || {}), ...(audio.tags || {}) });
  const videoStreams = streams.filter(stream => stream.codec_type === 'video');
  const hasArtwork = videoStreams.some(stream => stream.disposition && stream.disposition.attached_pic) || videoStreams.length > 0;

  return {
    id: hash(filePath.toLowerCase()).slice(0, 20),
    path: filePath,
    fileName: path.basename(filePath),
    directory: path.dirname(filePath),
    title: firstTag(tags, ['title'], titleFromFilename(filePath)),
    artist: firstTag(tags, ['artist', 'album_artist', 'albumartist'], 'Unknown Artist'),
    album: firstTag(tags, ['album'], 'Unknown Album'),
    albumArtist: firstTag(tags, ['album_artist', 'albumartist'], ''),
    genre: firstTag(tags, ['genre'], ''),
    year: firstTag(tags, ['date', 'year'], ''),
    trackNumber: parseNumber(firstTag(tags, ['track', 'tracknumber'], '')),
    discNumber: parseNumber(firstTag(tags, ['disc', 'discnumber'], '')),
    duration: finiteNumber(format.duration || audio.duration),
    bitRate: finiteNumber(audio.bit_rate || format.bit_rate),
    sampleRate: audio.sample_rate ? finiteNumber(audio.sample_rate, null) : null,
    bitDepth: parseNumber(audio.bits_per_raw_sample || audio.bits_per_sample || tags.bits_per_raw_sample || tags.bits_per_sample),
    channels: audio.channels || null,
    codec: audio.codec_name || '',
    format: format.format_name || '',
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    importedAt: new Date().toISOString(),
    metadataExtractedAt: new Date().toISOString(),
    hasArtwork,
    tags
  };
}

function failure(pathValue, message) {
  return {
    path: pathValue,
    message: String(message || 'Skipped.')
  };
}

function pushFailure(failures, pathValue, message) {
  if (failures.length < MAX_SCAN_FAILURES) {
    failures.push(failure(pathValue, message));
    return;
  }
  const last = failures[failures.length - 1];
  if (!last || last.path !== '[scan]') {
    failures.push(failure('[scan]', `Additional failures omitted after ${MAX_SCAN_FAILURES} entries.`));
  }
}

async function walkAudioFiles(directory, failures) {
  const files = [];
  const visitedDirectories = new Set();
  let stoppedAtLimit = false;

  async function walk(current) {
    if (files.length >= MAX_SCAN_FILES) {
      stoppedAtLimit = true;
      return;
    }

    let realPath;
    try {
      realPath = await fs.promises.realpath(current);
    } catch (error) {
      pushFailure(failures, current, error.message);
      return;
    }

    const normalizedRealPath = process.platform === 'win32' ? realPath.toLowerCase() : realPath;
    if (visitedDirectories.has(normalizedRealPath)) return;
    visitedDirectories.add(normalizedRealPath);

    let entries;
    try {
      entries = await fs.promises.readdir(realPath, { withFileTypes: true });
    } catch (error) {
      pushFailure(failures, realPath, error.message);
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_SCAN_FILES) {
        stoppedAtLimit = true;
        return;
      }
      if (entry.isSymbolicLink()) continue;

      const fullPath = path.join(realPath, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(fullPath);
      }
    }
  }

  await walk(directory);
  if (stoppedAtLimit) {
    pushFailure(failures, directory, `Scan stopped after ${MAX_SCAN_FILES} audio files. Set MAX_SCAN_FILES to raise the limit.`);
  }
  return files;
}

async function scanDirectoryImpl(directory) {
  const resolved = path.resolve(directory);
  const stat = await fs.promises.stat(resolved).catch(error => {
    throw httpError(400, 'Music folder could not be opened.', { detail: error.message });
  });

  if (!stat.isDirectory()) {
    throw httpError(400, 'Path is not a directory.');
  }

  const failures = [];
  const files = await walkAudioFiles(resolved, failures);
  const tracks = [];
  const probeQueue = new AsyncQueue(SCAN_CONCURRENCY);

  await Promise.all(files.map(file => probeQueue.run(async () => {
    try {
      const fileStat = await fs.promises.stat(file);
      const probe = await probeTrackMetadata(file);
      const track = parseTrack(file, fileStat, probe);
      db.upsertTrack(track);
      tracks.push(track);
    } catch (error) {
      pushFailure(failures, file, error.message);
    }
  })));

  return {
    tracks: db.getAllTracks(),
    imported: tracks.length,
    failures
  };
}

async function scanDirectory(directory) {
  if (scanInFlight) {
    throw httpError(409, 'A library scan is already running.');
  }

  scanInFlight = true;
  try {
    return await scanDirectoryImpl(directory);
  } finally {
    scanInFlight = false;
  }
}

async function extractSingleTrackMetadata(trackId) {
  const track = db.getTrackById(trackId);
  if (!track) throw httpError(404, 'Track not found.');

  const fileStat = await fs.promises.stat(track.path).catch(error => {
    throw httpError(404, 'Track file could not be opened.', { detail: error.message });
  });
  const probe = await probeTrackMetadata(track.path);
  const nextTrack = parseTrack(track.path, fileStat, probe);

  nextTrack.id = track.id;
  db.upsertTrack(nextTrack);
  return db.getTrackById(nextTrack.id);
}

module.exports = {
  scanDirectory,
  extractSingleTrackMetadata
};
