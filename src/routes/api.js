const crypto = require('crypto');
const express = require('express');
const router = express.Router();

const db = require('../services/db');
const { scanDirectory, extractSingleTrackMetadata } = require('../services/scanner');
const { runFile, FFMPEG_PATH, FFPROBE_PATH } = require('../services/ffmpeg');
const { asyncHandler, optionalString, requireString, routeId } = require('../utils/http');

function playlistName(value) {
  return optionalString(value, 'Untitled Playlist', 'Playlist name', { maxLength: 120 })
    .replace(/\s+/g, ' ')
    .trim();
}

router.get('/health', asyncHandler(async (req, res) => {
  const [ffmpeg, ffprobe] = await Promise.all([
    runFile(FFMPEG_PATH, ['-version'])
      .then(result => ({ ok: true, version: result.stdout.split(/\r?\n/)[0] }))
      .catch(error => ({ ok: false, version: error.message })),
    runFile(FFPROBE_PATH, ['-version'])
      .then(result => ({ ok: true, version: result.stdout.split(/\r?\n/)[0] }))
      .catch(error => ({ ok: false, version: error.message }))
  ]);

  res.json({
    ok: ffmpeg.ok && ffprobe.ok,
    ffmpeg: ffmpeg.version,
    ffprobe: ffprobe.version
  });
}));

router.get('/state', asyncHandler((req, res) => {
  res.json({
    tracks: db.getAllTracks(),
    playlists: db.getAllPlaylists()
  });
}));

router.get('/stats', asyncHandler((req, res) => {
  res.json(db.getStats());
}));

router.get('/recent', asyncHandler((req, res) => {
  const recentIds = db.getRecentIds();
  const recentTracks = recentIds.map(id => db.getTrackById(id)).filter(Boolean).slice(0, 20);
  res.json({ recentTracks });
}));

router.post('/recent/:id', asyncHandler((req, res) => {
  const id = routeId(req.params.id, 'Track id');
  db.addRecent(id);
  res.json({ recentIds: db.getRecentIds() });
}));

router.post('/scan', asyncHandler(async (req, res) => {
  const directory = requireString(req.body?.directory, 'Directory', { maxLength: 4096 });
  const result = await scanDirectory(directory);
  res.json(result);
}));

router.post('/metadata/:id', asyncHandler(async (req, res) => {
  const id = routeId(req.params.id, 'Track id');
  const track = await extractSingleTrackMetadata(id);
  res.json({ track });
}));

router.post('/playlists', asyncHandler((req, res) => {
  const now = new Date().toISOString();
  const playlist = db.createPlaylist({
    id: crypto.randomUUID(),
    name: playlistName(req.body?.name),
    createdAt: now,
    updatedAt: now,
    trackIds: Array.isArray(req.body?.trackIds) ? req.body.trackIds.slice(0, 1000) : []
  });

  res.status(201).json({ playlist, playlists: db.getAllPlaylists() });
}));

router.patch('/playlists/:id', asyncHandler((req, res) => {
  const playlistId = routeId(req.params.id, 'Playlist id');
  const playlist = db.updatePlaylistName(playlistId, playlistName(req.body?.name));
  res.json({ playlist, playlists: db.getAllPlaylists() });
}));

router.delete('/playlists/:id', asyncHandler((req, res) => {
  const playlistId = routeId(req.params.id, 'Playlist id');
  db.deletePlaylist(playlistId);
  res.json({ playlists: db.getAllPlaylists() });
}));

router.post('/playlists/:id/tracks', asyncHandler((req, res) => {
  const playlistId = routeId(req.params.id, 'Playlist id');
  const trackId = routeId(req.body?.trackId, 'Track id');
  const playlist = db.addTrackToPlaylist(playlistId, trackId);
  res.json({ playlist, playlists: db.getAllPlaylists() });
}));

router.delete('/playlists/:id/tracks/:trackId', asyncHandler((req, res) => {
  const playlistId = routeId(req.params.id, 'Playlist id');
  const trackId = routeId(req.params.trackId, 'Track id');
  const playlist = db.removeTrackFromPlaylist(playlistId, trackId);
  res.json({ playlist, playlists: db.getAllPlaylists() });
}));

module.exports = router;
