import { renderFilters } from "./filters.js";
import { renderGrid, renderPlaylistsSidebar, renderViewTitle, toggleEmptyState } from "./library-render.js";
import { renderLayoutToggle, renderNowPlaying, renderTransport, updateProgress } from "./playback-render.js";
import { renderQueue } from "./queue-render.js";

export { renderGrid, renderNowPlaying, renderPlaylistsSidebar, renderQueue, renderTransport, toggleEmptyState, updateProgress };

export function render() {
  toggleEmptyState();
  renderViewTitle();
  renderFilters();
  renderGrid();
  renderNowPlaying();
  renderTransport();
  renderLayoutToggle();
  renderQueue();
  updateProgress();
}
