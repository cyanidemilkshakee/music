import { state } from "./state.js";
import { el } from "./dom.js";

const any = "";

function values(field) { return state.facets[field] || []; }

function options(items, selected, emptyLabel) {
  return [`<option value="">${emptyLabel}</option>`, ...items.map(value =>
    `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(value)}</option>`
  )].join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'\"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

export function renderFilters() {
  if (!el.filterGenre) return;
  el.filterGenre.innerHTML = options(values("genre"), state.filters.genre, "All genres");
  el.filterYear.innerHTML = options(values("year"), state.filters.year, "All years");
  el.filterCodec.innerHTML = options(values("codec"), state.filters.codec, "All formats");
  el.filterFavorite.checked = state.filters.favorite;
  el.filterRecent.checked = state.filters.recentlyPlayed;
  el.filterDuration.value = state.filters.duration;
  const activeCount = [state.filters.genre, state.filters.year, state.filters.codec, state.filters.duration]
    .filter(Boolean).length + Number(state.filters.favorite) + Number(state.filters.recentlyPlayed);
  el.filterToggleButton?.classList.toggle("is-active", activeCount > 0);
  if (el.filterCount) el.filterCount.textContent = activeCount ? `${activeCount} active` : "Filters";
}

export function updateFiltersFromForm() {
  state.filters = {
    genre: el.filterGenre?.value || any,
    year: el.filterYear?.value || any,
    codec: el.filterCodec?.value || any,
    duration: el.filterDuration?.value || any,
    favorite: Boolean(el.filterFavorite?.checked),
    recentlyPlayed: Boolean(el.filterRecent?.checked),
  };
  state.gridOffset = 0;
}

export function clearFilters() {
  state.filters = { genre: any, year: any, codec: any, duration: any, favorite: false, recentlyPlayed: false };
  state.gridOffset = 0;
}
