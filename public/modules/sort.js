import { state } from './state.js';
import { libraryPageKey } from './library-query.js';
export function getVisibleTracks() {
  return state.libraryPage.key === libraryPageKey(state) ? state.libraryPage.tracks : [];
}
