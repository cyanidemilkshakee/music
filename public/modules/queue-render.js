import { state } from './state.js';
import { icons } from './icons.js';
import { el } from './dom.js';
import { coverUrl, esc, fmt, trackTitle } from './utils.js';
import { ensureTracks } from './library-data.js';
let metadataKey = '', metadataError = '';
export function renderQueue() {
  el.queuePanel.classList.toggle('is-open', state.queueOpen);
  el.queuePanel.setAttribute('aria-hidden', String(!state.queueOpen));
  el.queuePanel.inert = !state.queueOpen;
  el.queueButton.setAttribute('aria-expanded', String(state.queueOpen));
  el.queueButton.classList.toggle('is-active', state.queueOpen);
  if (!state.queueOpen) { metadataKey = ''; metadataError = ''; el.queueList.replaceChildren(); return; }
  const byId = new Map(state.tracks.map(track => [track.id, track]));
  const size = 100, pages = Math.max(1, Math.ceil(state.queue.length / size));
  state.queuePage = Math.min(state.queuePage || 0, pages - 1);
  const start = state.queuePage * size;
  const ids = state.queue.slice(start, start + size);
  const key = JSON.stringify([ids, state.libraryRevision]);
  if (metadataKey !== key) {
    metadataKey = key; metadataError = '';
    ensureTracks(ids).catch(error => { if (metadataKey === key) { metadataError = error.message; renderQueue(); } });
  }
  el.queueCount.textContent = `${state.queue.length} songs${state.shuffle ? ' · shuffled' : ''} · repeat ${state.repeat}`;
  el.queueClearButton.disabled = !state.queue.length;
  el.queueList.innerHTML = ids.map((id, offset) => {
    const track = byId.get(id), index = start + offset;
    if (!track) return `<div class="queue-item"><span role="status">${esc(metadataError || 'Loading track…')}</span>${metadataError ? '<button type="button" data-queue-retry>Retry</button>' : ''}</div>`;
    const current = index === state.queueIndex;
    return `<div class="queue-item ${current ? 'is-current' : ''}" data-queue-drag-index="${index}" draggable="true"><button class="queue-play" data-queue-index="${index}" aria-label="Play ${esc(trackTitle(track))}"><img class="queue-art" src="${coverUrl(track)}" alt="" loading="lazy"><span class="queue-copy"><span class="queue-title">${esc(trackTitle(track))}</span><span class="queue-artist">${esc(track.artist || 'Unknown Artist')}${current ? ' · Current' : ''}</span></span><span class="queue-duration">${fmt(track.duration)}</span></button><button class="queue-move" data-queue-move="${index}" data-direction="-1" aria-label="Move up" ${index === 0 ? 'disabled' : ''}>↑</button><button class="queue-move" data-queue-move="${index}" data-direction="1" aria-label="Move down" ${index === state.queue.length - 1 ? 'disabled' : ''}>↓</button><button class="queue-remove" data-queue-remove="${index}" aria-label="Remove ${esc(trackTitle(track))}">${icons.x}</button></div>`;
  }).join('') || '<div class="queue-empty">Queue is empty.</div>';
  if (pages > 1) el.queueList.insertAdjacentHTML('beforeend', `<div class="page-controls"><button data-queue-page="-1" ${state.queuePage === 0 ? 'disabled' : ''}>Previous</button><span>${state.queuePage + 1}/${pages}</span><button data-queue-page="1" ${state.queuePage === pages - 1 ? 'disabled' : ''}>Next</button><button data-queue-current>Current</button></div>`);
}
document.addEventListener('click', event => {
  if (event.target.closest('[data-queue-retry]')) { metadataKey = ''; renderQueue(); }
});
