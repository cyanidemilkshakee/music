import { renderFilters } from "./filters.js";
import { renderGrid, renderPlaylistsSidebar, renderViewTitle, toggleEmptyState } from "./library-render.js";
import { renderLayoutToggle, renderNowPlaying, renderTransport, updateProgress } from "./playback-render.js";
import { renderQueue } from "./queue-render.js";

export { renderGrid, renderLayoutToggle, renderNowPlaying, renderPlaylistsSidebar, renderQueue, renderTransport, renderViewTitle, toggleEmptyState, updateProgress };

// Kept as a no-op compatibility export for browsers that still have an older
// navigation.js module cached while the split renderer is being refreshed.
export function renderGroupSidebar() {}

export function render() {
  renderViewTitle();
  renderFilters();
  renderGrid();
  renderNowPlaying();
  renderTransport();
  renderLayoutToggle();
  renderQueue();
  updateProgress();
}
