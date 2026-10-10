import { state } from './state.js';
import { api } from './api.js';
import { esc, trackTitle } from './utils.js';
import { getStorage, setStorage } from './storage.js';
import { trapModalFocus } from './modal-focus.js';
import { refreshLibrary as reloadLibrary } from './library-data.js';
import { importLimits, backupBody, m3uBody, formatBytes } from './import-payload.js';
import { playTrack } from './player.js';
function dialog(title, body) {
  const overlay = document.createElement('div'); overlay.className='glass-dialog-layer is-open';
  overlay.innerHTML=`<section class="glass-dialog" role="dialog" aria-modal="true" aria-label="${esc(title)}"><h2>${esc(title)}</h2>${body}<button class="glass-btn" data-close>Close</button></section>`;
  document.body.append(overlay);
  const release=trapModalFocus(overlay,{onClose:close});
  function close() { release(); overlay.remove(); }
  overlay.querySelector('[data-close]').onclick=close;
  overlay.addEventListener('click',event=>{if(event.target===overlay)close();});
  return {overlay,close};
}
export async function showTrackDetails(id) {
  const {track}=await api('/api/tracks/'+encodeURIComponent(id));
  const fields=[['Artist',track.artist],['Album',track.album],['Album artist',track.albumArtist],['Codec',track.codec],['Sample rate',track.sampleRate ? track.sampleRate+' Hz' : 'Unknown'],['Bit depth',track.bitDepth ? track.bitDepth+' bit' : 'Unknown'],['Bit rate',Math.round(track.bitRate/1000)+' kbps'],['Channels',track.channels],['Size',(track.size/1024/1024).toFixed(1)+' MB'],['Path',track.path],['Imported',track.importedAt]];
  const {overlay,close}=dialog(trackTitle(track),`<dl class="track-details">${fields.map(([label,value])=>`<dt>${esc(label)}</dt><dd>${esc(value || 'Unknown')}</dd>`).join('')}</dl><div class="settings-actions"><button class="glass-btn" data-refresh>Refresh metadata</button><button class="glass-btn danger" data-remove>Remove from library</button></div><p class="dialog-status" role="status"></p>`);
  const status=overlay.querySelector('[role=status]');
  overlay.querySelector('[data-refresh]').onclick=async event=>{
    event.target.disabled=true;
    try {await api('/api/metadata/'+encodeURIComponent(id),{method:'POST',timeoutMs:60000});await reloadLibrary();close();await showTrackDetails(id);}
    catch(error){status.textContent=error.message;event.target.disabled=false;}
  };
  overlay.querySelector('[data-remove]').onclick=async event=>{
    if(event.target.dataset.confirm!=='yes') {event.target.dataset.confirm='yes';event.target.textContent='Confirm removal';status.textContent='This removes the library entry and playlist references. Your music file stays on disk.';return;}
    event.target.disabled=true;
    try {await api('/api/tracks/'+encodeURIComponent(id),{method:'DELETE'});await reloadLibrary();close();}
    catch(error){status.textContent=error.message;event.target.disabled=false;}
  };
}
export async function reorderPlaylist(id, direction) {
  const playlist=state.playlists.find(p=>p.id===state.activePlaylistId);
  if(!playlist) return;
  const from=playlist.trackIds.indexOf(id),to=from+direction;
  if(from<0 || to<0 || to>=playlist.trackIds.length) return;
  const ids=[...playlist.trackIds];[ids[from],ids[to]]=[ids[to],ids[from]];
  await api('/api/playlists/'+encodeURIComponent(playlist.id)+'/tracks',{method:'PUT',body:JSON.stringify({trackIds:ids})});
  state.sortField='none';await reloadLibrary();
}
export function exportPlaylist(id) {
  const anchor=document.createElement('a');anchor.href='/api/playlists/'+encodeURIComponent(id)+'/m3u';anchor.download='playlist.m3u';anchor.click();
}
function download(data, name) {
  const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
  const anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function serverHealth() {
  try { return await api('/api/health', { timeoutMs: 60000, cache: 'no-store' }); }
  catch (error) {
    // A degraded server still advertises its configured limits and tool checks.
    if (error.status === 503 && error.data?.limits) return error.data;
    throw error;
  }
}

function elapsedTime(seconds) {
  const minutes = Math.floor(Number(seconds || 0) / 60);
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)} d ${hours % 24} h`;
  if (hours) return `${hours} h ${minutes % 60} min`;
  return `${minutes} min`;
}

function statsMarkup(stats) {
  const fields = [
    ['Tracks', Number(stats.totalTracks).toLocaleString()],
    ['Tagged albums', Number(stats.totalAlbums).toLocaleString()],
    ['Tagged artists', Number(stats.totalArtists).toLocaleString()],
    ['Listening time', elapsedTime(stats.totalDuration)],
    ['Music files', formatBytes(stats.totalSize)]
  ];
  const missing = Number(stats.missingTracks || 0);
  const genres = stats.genres?.length ? stats.genres.map(esc).join(' · ') : 'No genre tags yet';
  return `<dl class="settings-stat-grid">${fields.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join('')}</dl><p>Top genres: ${genres}</p>${missing ? `<p class="is-error">${missing.toLocaleString()} music ${missing === 1 ? 'file is' : 'files are'} missing. Rescan your folders after reconnecting drives.</p>` : ''}`;
}

function healthMarkup(health) {
  const tool = (label, value) => `<dt>${label}</dt><dd class="${value?.ok ? 'is-success' : 'is-error'}">${esc(value?.ok ? value.version || 'Available' : value?.error || 'Unavailable')}</dd>`;
  return `<p class="${health.ok ? 'is-success' : 'is-error'}">${health.ok ? 'Server ready' : 'Server needs attention'}</p><dl class="settings-diagnostics-list"><dt>Database</dt><dd class="${health.database?.ok ? 'is-success' : 'is-error'}">${health.database?.ok ? `Connected (${esc(health.database.journalMode || 'unknown')} journal)` : 'Unavailable'}</dd>${tool('FFmpeg', health.ffmpeg)}${tool('FFprobe', health.ffprobe)}<dt>Server uptime</dt><dd>${esc(elapsedTime(health.uptime))}</dd></dl>`;
}

function openSettings() {
  const {overlay,close}=dialog('Library & Playback',`
    <section class="settings-section" aria-label="Library summary"><h3>Your library</h3><div data-library-stats aria-live="polite"><p>Loading library summary…</p></div><h4>Recently played</h4><div data-recent-playback aria-live="polite"><p>Loading recent playback…</p></div></section>
    <section class="settings-section" aria-label="Playback settings"><h3>Playback</h3><label for="qualitySelect">Playback quality</label><select id="qualitySelect"><option value="lossless">Original / lossless fallback</option><option value="compatibility">MP3 compatibility</option></select><label for="gainSelect">ReplayGain</label><select id="gainSelect"><option value="off">Off</option><option value="track">Track tags (safe attenuation)</option></select><p>Playback resumes when you press Play after reopening. MP3 compatibility converts audio and reduces quality. ReplayGain reduces tagged track levels to prevent clipping; untagged tracks keep their original level.</p></section>
    <section class="settings-section" aria-label="Library backup and import"><h3>Backup & import</h3><div class="settings-actions"><button class="glass-btn" data-backup>Download library backup</button><label class="glass-btn">Restore backup<input type="file" data-restore accept=".json,application/json"></label><label class="glass-btn">Import M3U<input type="file" data-m3u accept=".m3u,.m3u8"></label></div><p>Backups include metadata, local paths, playlists, favorites, and recent tracks. Music files are separate. Restore merges entries and preserves existing playlists. M3U imports match absolute paths already in this library.</p><p data-import-limits aria-live="polite">Checking server import limits…</p></section>
    <details class="settings-section settings-diagnostics" open><summary>Server & diagnostics</summary><div data-server-health aria-live="polite"><p>Checking database and audio tools…</p></div><p id="cacheUsage" aria-live="polite">Checking cache usage…</p><div class="settings-actions"><button class="glass-btn" data-diagnostics-refresh>Refresh diagnostics</button><button class="glass-btn" data-clear-cache>Clear audio cache</button><a class="glass-btn" href="/metrics" target="_blank" rel="noopener">Open server metrics</a></div><p>Metrics report server requests and performance for troubleshooting. Clearing the cache keeps your music files and library entries.</p><button class="glass-btn danger" data-stop>Stop Local Amp server</button></details>
    <p class="dialog-status" role="status"></p>`);
  const statsPanel = overlay.querySelector('[data-library-stats]');
  const recentPanel = overlay.querySelector('[data-recent-playback]');
  const healthPanel = overlay.querySelector('[data-server-health]');
  const limitPanel = overlay.querySelector('[data-import-limits]');
  const cachePanel = overlay.querySelector('#cacheUsage');
  const refreshButton = overlay.querySelector('[data-diagnostics-refresh]');
  let recentIds = [];
  recentPanel.addEventListener('click', async event => {
    const button = event.target.closest('[data-recent-play]');
    if (!button) return;
    button.disabled = true;
    try { await playTrack(button.dataset.recentPlay, recentIds, recentIds.indexOf(button.dataset.recentPlay)); close(); }
    catch (error) { status.textContent = error.message; button.disabled = false; }
  });
  function displayLimits(health) {
    const limits = importLimits(health);
    limitPanel.classList.remove('is-error');
    limitPanel.textContent = `Server limits: ${formatBytes(limits.jsonLimitBytes)} per JSON request; ${formatBytes(limits.m3uTextBytes)} of M3U text. Imports are checked after JSON encoding.`;
    return limits;
  }
  async function refreshCache() {
    try {
      const cache = await api('/api/cache');
      cachePanel.classList.remove('is-error');
      cachePanel.textContent = `Audio cache: ${formatBytes(cache.bytes)} of ${formatBytes(cache.maxBytes)} (${cache.files} files).`;
    } catch (error) { cachePanel.classList.add('is-error'); cachePanel.textContent = `Cache usage unavailable: ${error.message}`; }
  }
  async function refreshDiagnostics() {
    refreshButton.disabled = true;
    await Promise.allSettled([
      api('/api/stats').then(stats => { statsPanel.innerHTML = statsMarkup(stats); }).catch(error => { statsPanel.innerHTML = `<p class="is-error">Library summary unavailable: ${esc(error.message)}</p>`; }),
      api('/api/recent').then(data => {
        recentIds = data.recentTracks.map(track => track.id);
        recentPanel.innerHTML = data.recentTracks.length ? `<ol class="settings-recent-list">${data.recentTracks.slice(0, 5).map(track => `<li><button type="button" data-recent-play="${esc(track.id)}" aria-label="Play ${esc(trackTitle(track))}" ${track.available === false ? 'disabled' : ''}><strong>${esc(trackTitle(track))}</strong><span>${esc(track.artist || 'Unknown Artist')}${track.available === false ? ' · File missing' : ''}</span></button></li>`).join('')}</ol>` : '<p>No tracks played yet.</p>';
      }).catch(error => { recentPanel.innerHTML = `<p class="is-error">Recent playback unavailable: ${esc(error.message)}</p>`; }),
      serverHealth().then(health => { healthPanel.innerHTML = healthMarkup(health); displayLimits(health); }).catch(error => {
        healthPanel.innerHTML = `<p class="is-error">Diagnostics unavailable: ${esc(error.message)}</p>`;
        limitPanel.classList.add('is-error'); limitPanel.textContent = 'Import limits unavailable. Refresh diagnostics before importing.';
      }),
      refreshCache()
    ]);
    refreshButton.disabled = false;
  }
  async function verifiedLimits() {
    try { return displayLimits(await serverHealth()); }
    catch (error) { throw new Error(`Cannot verify server import limits: ${error.message}`); }
  }
  refreshButton.onclick = refreshDiagnostics;
  void refreshDiagnostics();
  overlay.querySelector('[data-clear-cache]').onclick = async event => {
    event.target.disabled = true;
    try {
      const result = await api('/api/cache/clear', { method: 'POST', timeoutMs: 60000 });
      status.textContent = `Removed ${result.removed} cached files (${formatBytes(result.bytes)}).`;
      await refreshCache();
    } catch (error) { status.textContent = error.message; }
    finally { event.target.disabled = false; }
  };
  overlay.querySelector('[data-stop]').onclick=async event=>{
    event.target.disabled=true;
    try{await api('/api/shutdown',{method:'POST'});document.getElementById('audio').pause();status.textContent='Server stopped. Open Local Amp from the Start menu to restart.';}
    catch(error){status.textContent=error.message;event.target.disabled=false;}
  };
  const quality=overlay.querySelector('#qualitySelect'),gain=overlay.querySelector('#gainSelect'),status=overlay.querySelector('[role=status]');
  quality.value=getStorage('amp-quality','lossless');gain.value=getStorage('amp-replaygain','off');
  quality.onchange=()=>setStorage('amp-quality',quality.value);
  gain.onchange=()=>{setStorage('amp-replaygain',gain.value);document.dispatchEvent(new Event('playback-preferences-changed'));};
  overlay.querySelector('[data-backup]').onclick=async event=>{
    event.target.disabled=true;
    try{download(await api('/api/backup',{timeoutMs:120000}),'local-amp-backup.json');status.textContent='Backup downloaded.';}catch(error){status.textContent=error.message;}finally{event.target.disabled=false;}
  };
  overlay.querySelector('[data-restore]').onchange=async event=>{
    const file=event.target.files[0];if(!file)return;
    event.target.disabled=true;
    status.textContent='Checking backup and server limits…';
    try{const limits=await verifiedLimits();const body=backupBody(await file.text(),limits);const data=await api('/api/backup/restore',{method:'POST',body,timeoutMs:120000});await reloadLibrary();status.textContent=`Restored ${data.imported} playlists. ${data.skipped} existing or unavailable entries skipped.`;await refreshDiagnostics();}
    catch(error){status.textContent=error.message;}finally{event.target.disabled=false;event.target.value='';}
  };
  overlay.querySelector('[data-m3u]').onchange=async event=>{
    const file=event.target.files[0];if(!file)return;
    event.target.disabled=true;
    status.textContent='Checking playlist and server limits…';
    try{const limits=await verifiedLimits();const body=m3uBody(file.name,await file.text(),limits);const data=await api('/api/playlists/import',{method:'POST',body});await reloadLibrary();status.textContent=`Imported playlist. ${data.skipped} paths absent from this library were skipped.`;}
    catch(error){status.textContent=error.message;}finally{event.target.disabled=false;event.target.value='';}
  };
}
document.getElementById('settingsButton')?.addEventListener('click',openSettings);
document.getElementById('mobileSettingsButton')?.addEventListener('click',openSettings);
