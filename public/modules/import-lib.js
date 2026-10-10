import { state } from './state.js';
import { el } from './dom.js';
import { api } from './api.js';
import { refreshLibrary } from './library-data.js';
import { esc } from './utils.js';
import { trapModalFocus } from './modal-focus.js';
import { getStorage, setStorage } from './storage.js';
let releaseImportFocus = null, jobId = null, observer = null;
function status(message, className = '') { el.importStatusSheet.textContent = message; el.importStatusSheet.className = 'import-status ' + className; }
function busy(value) {
  state.busy = value; el.importButtonSheet.disabled = value; el.pickFolderButton.disabled = value;
  el.importSheet.setAttribute('aria-busy', String(value));
  document.getElementById('cancelScanButton').hidden = !value;
}
export function openImportSheet() {
  if (!state.busy) status('');
  el.importSheet.classList.remove('is-hidden');
  releaseImportFocus?.();
  releaseImportFocus = trapModalFocus(el.importSheet, {onClose:closeImportSheet, initialFocus:el.folderInputSheet});
  refreshLibrarySources().catch(() => {});
}
export function closeImportSheet() { el.importSheet.classList.add('is-hidden'); releaseImportFocus?.(); releaseImportFocus = null; }
export async function refreshLibrarySources() {
  const data = await api('/api/library/sources');
  state.librarySources = data.sources || [];
  el.librarySourceList.innerHTML = state.librarySources.map(source => `<div class="library-source"><button class="library-source-path" data-library-source="${esc(source.path)}" title="Rescan folder">${esc(source.path)}<small>${source.lastScannedAt ? 'Last scanned ' + esc(new Date(source.lastScannedAt).toLocaleString()) : 'Not yet scanned'}</small></button><button class="library-source-remove" data-library-source-remove="${esc(source.id)}" aria-label="Forget saved folder (keep tracks)">×</button></div>`).join('') || '<p>No saved folders yet.</p>';
}
export async function chooseLibraryFolder() {
  if (state.busy) return;
  el.pickFolderButton.disabled = true;
  try {
    const data = await api('/api/library/pick-folder', {method:'POST',timeoutMs:125000});
    if (data.directory) { el.folderInputSheet.value = data.directory; el.folderInputSheet.focus(); }
  } catch (error) { status(error.message + ' You can enter an absolute folder path instead.', 'is-error'); }
  finally { el.pickFolderButton.disabled = false; }
}
export async function forgetLibrarySource(id) { await api('/api/library/sources/' + encodeURIComponent(id), {method:'DELETE'}); await refreshLibrarySources(); }
export function directoryFromDrop(event) {
  const uri = (event.dataTransfer?.getData('text/uri-list') || '').split(/\r?\n/).find(line => line && !line.startsWith('#'));
  try {
    const url = new URL(uri);
    if (url.protocol !== 'file:') return '';
    const path = decodeURIComponent(url.pathname);
    if (url.hostname && url.hostname !== 'localhost') return '\\\\' + url.hostname + path.replaceAll('/', '\\');
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1).replaceAll('/', '\\') : path;
  } catch { return ''; }
}
async function finish(event) {
  observer?.close(); observer = null;
  busy(false); setStorage('amp-scan-job', '');
  try { await refreshLibrary(); await refreshLibrarySources(); }
  catch (error) { status('Scan finished. Library refresh failed: ' + error.message, 'is-error'); return; }
  if (event.phase === 'failed') { status(event.message, 'is-error'); return; }
  status(`${event.imported} imported or updated · ${event.unchanged} unchanged · ${event.missing} missing · ${event.failureCount} failures`, event.failureCount ? 'is-error' : 'is-success');
  const details = document.getElementById('scanFailures');
  details.replaceChildren();
  if (event.failures?.length) {
    const pre = document.createElement('pre'); pre.textContent = event.failures.map(f => f.path + ': ' + f.message).join('\n');
    details.append(pre);
    const download = document.createElement('button'); download.textContent = 'Download failure report';
    download.onclick = () => { const url = URL.createObjectURL(new Blob([pre.textContent], {type:'text/plain'})); const anchor = document.createElement('a'); anchor.href=url; anchor.download='scan-failures.txt'; anchor.click(); setTimeout(()=>URL.revokeObjectURL(url),1000); };
    details.append(download);
  }
}
function observe(id) {
  observer?.close(); jobId = id; setStorage('amp-scan-job', id); busy(true);
  observer = new EventSource('/api/scan/' + encodeURIComponent(id) + '/stream');
  observer.onmessage = event => {
    const data = JSON.parse(event.data);
    if (data.phase === 'walk') status(`Found ${data.found} audio files…`);
    else if (data.phase === 'probe') status(`Processing ${data.done}/${data.total} files · ${data.errors} errors`);
    else if (['complete','failed'].includes(data.phase)) finish(data).catch(error=>status(error.message,'is-error'));
  };
  observer.onerror = async () => {
    status('Connection interrupted. Reconnecting to the scan…');
    try {
      const snapshot = await api('/api/scan/' + encodeURIComponent(id));
      if (snapshot.finished) await finish(snapshot.event);
    } catch (error) {
      if (error.status === 404) { observer?.close(); observer=null; busy(false); status('This scan is no longer available. Rescan the folder.', 'is-error'); }
    }
  };
}
export async function recoverScan() {
  const {scan} = await api('/api/scan/status');
  if (scan && !scan.finished) { observe(scan.jobId); return; }
  const saved = getStorage('amp-scan-job', '');
  if (saved) {
    try { const job = await api('/api/scan/' + encodeURIComponent(saved)); if(job.finished) await finish(job.event); else observe(saved); }
    catch { setStorage('amp-scan-job',''); }
  }
}
export async function doImport(directory) {
  if (state.busy) { status('A scan is already running. You can cancel it below.'); return; }
  if (!directory) { status('Choose or enter an absolute folder path.', 'is-error'); return; }
  document.getElementById('scanFailures').replaceChildren(); busy(true); status('Starting scan…');
  try { const data = await api('/api/scan', {method:'POST',body:JSON.stringify({directory})}); observe(data.jobId); }
  catch (error) { busy(false); status(error.message, 'is-error'); }
}
document.getElementById('cancelScanButton').addEventListener('click', async () => {
  if (jobId) { try { await api('/api/scan/' + encodeURIComponent(jobId) + '/cancel', {method:'POST'}); status('Canceling scan…'); } catch(error) { status(error.message,'is-error'); } }
});
window.addEventListener('pagehide', () => observer?.close());
