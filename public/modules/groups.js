import { state } from './state.js';
export function groupKindForView(view = state.activeView) {
  return ({ albums: 'album', artists: 'artist' })[view] || null;
}
export function groupSummary(group) {
  return group.type === 'album' ? group.artists.slice(0, 2).join(', ')
    : `${group.albumCount} ${group.albumCount === 1 ? 'album' : 'albums'}`;
}
