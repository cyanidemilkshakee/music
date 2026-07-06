const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const db = require('../services/db');
const { ensureDecoded, cachePathForTrack, FFMPEG_PATH, commandFailureMessage, trimOutput } = require('../services/ffmpeg');
const { asyncHandler, httpError, routeId } = require('../utils/http');

function hash(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function trackVersion(track) {
  return encodeURIComponent(`${track.modifiedAt || ''}-${track.size || ''}`);
}

function getTrackOrThrow(id) {
  const track = db.getTrackById(id);
  if (!track) throw httpError(404, 'Track not found.');
  return track;
}

function destroyOnClose(res, stream) {
  res.on('close', () => {
    if (!res.writableEnded) stream.destroy();
  });
}

function pipeFileToResponse(filePath, res, options = {}) {
  const stream = fs.createReadStream(filePath, options);
  destroyOnClose(res, stream);
  stream.on('error', error => {
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
      return;
    }
    res.destroy(error);
  });
  stream.pipe(res);
}

function parseRangeHeader(rangeHeader, size) {
  if (!rangeHeader) return null;
  if (!Number.isSafeInteger(size) || size <= 0) throw httpError(416, 'Range not satisfiable.');

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) throw httpError(416, 'Invalid range.');

  let start;
  let end;

  if (match[1] === '' && match[2] !== '') {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      throw httpError(416, 'Invalid range.');
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = match[1] ? Number(match[1]) : 0;
    end = match[2] ? Number(match[2]) : size - 1;
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || start > end) {
    throw httpError(416, 'Range not satisfiable.');
  }

  return {
    start,
    end: Math.min(end, size - 1)
  };
}

router.post('/decode/:id', asyncHandler(async (req, res) => {
  const id = routeId(req.params.id, 'Track id');
  const track = getTrackOrThrow(id);

  const decodedPath = await ensureDecoded(track);
  res.json({
    id: track.id,
    audioUrl: `/api/audio/${encodeURIComponent(track.id)}?v=${encodeURIComponent(path.basename(decodedPath))}`,
    streaming: false
  });
}));

router.get('/stream/:id', asyncHandler(async (req, res) => {
  const id = routeId(req.params.id, 'Track id');
  const track = getTrackOrThrow(id);

  await fs.promises.access(track.path, fs.constants.R_OK).catch(error => {
    throw httpError(404, 'Track file could not be opened.', { detail: error.message });
  });

  const child = spawn(FFMPEG_PATH, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', track.path,
    '-map', '0:a:0', '-vn', '-map_metadata', '0',
    '-codec:a', 'libmp3lame', '-q:a', '3', '-f', 'mp3', 'pipe:1'
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  let childClosed = false;

  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no'
  });

  child.stdout.on('error', error => {
    if (!res.destroyed) res.destroy(error);
  });
  child.stdout.pipe(res);
  child.stderr.on('data', chunk => {
    stderr = trimOutput(stderr + chunk.toString(), 4000);
  });

  child.on('error', error => {
    childClosed = true;
    if (!res.destroyed) res.destroy(new Error(commandFailureMessage(FFMPEG_PATH, error)));
  });

  child.on('close', code => {
    childClosed = true;
    if (code !== 0 && !res.destroyed) {
      res.destroy(new Error(stderr || `FFmpeg stream exited with ${code}.`));
      return;
    }
    if (!res.writableEnded) res.end();
  });

  res.on('close', () => {
    if (!childClosed) child.kill('SIGKILL');
  });
}));

router.get('/audio/:id', asyncHandler(async (req, res) => {
  const id = routeId(req.params.id, 'Track id');
  const track = getTrackOrThrow(id);
  const decodedPath = cachePathForTrack(track);
  const stat = await fs.promises.stat(decodedPath).catch(error => {
    throw httpError(404, 'Audio cache not found.', { detail: error.message });
  });
  if (!stat.isFile() || stat.size <= 0) {
    throw httpError(404, 'Audio cache is not ready.');
  }

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('ETag', `"${trackVersion(track)}"`);

  let range;
  try {
    range = parseRangeHeader(req.headers.range, stat.size);
  } catch (error) {
    res.writeHead(416, {
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes */${stat.size}`,
      'Content-Length': '0'
    });
    res.end();
    return;
  }

  if (!range) {
    res.writeHead(200);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    pipeFileToResponse(decodedPath, res);
    return;
  }

  res.writeHead(206, {
    'Content-Range': `bytes ${range.start}-${range.end}/${stat.size}`,
    'Content-Length': range.end - range.start + 1
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  pipeFileToResponse(decodedPath, res, range);
}));

router.get('/artwork/:id', asyncHandler(async (req, res) => {
  const id = routeId(req.params.id, 'Track id');
  const track = getTrackOrThrow(id);
  if (!track.hasArtwork) throw httpError(404, 'Artwork not found.');

  await fs.promises.access(track.path, fs.constants.R_OK).catch(error => {
    throw httpError(404, 'Track file could not be opened.', { detail: error.message });
  });

  const etag = `"${track.id}-${hash(String(track.modifiedAt || track.size || '')).slice(0, 12)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
    ETag: etag
  });

  const child = spawn(FFMPEG_PATH, [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-i', track.path,
    '-an', '-map', '0:v:0', '-frames:v', '1', '-vcodec', 'mjpeg',
    '-f', 'image2pipe', 'pipe:1'
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  let childClosed = false;

  child.stdout.on('error', error => {
    if (!res.destroyed) res.destroy(error);
  });
  child.stdout.pipe(res);
  child.stderr.on('data', chunk => {
    stderr = trimOutput(stderr + chunk.toString(), 4000);
  });

  child.on('error', error => {
    childClosed = true;
    if (!res.destroyed) res.destroy(new Error(commandFailureMessage(FFMPEG_PATH, error)));
  });

  child.on('close', code => {
    childClosed = true;
    if (code !== 0 && !res.destroyed) {
      res.destroy(new Error(stderr || `FFmpeg artwork extraction exited with ${code}.`));
      return;
    }
    if (!res.writableEnded) res.end();
  });

  res.on('close', () => {
    if (!childClosed) child.kill('SIGKILL');
  });
}));

module.exports = router;
