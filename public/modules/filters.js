import { state } from "./state.js";
import { el } from "./dom.js";

const any = "";

function values(field) {
  return [...new Set(state.tracks.map(track => String(track[field] || "").trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

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
  state.gridLimit = state.gridPageSize;
}

export function clearFilters() {
  state.filters = { genre: any, year: any, codec: any, duration: any, favorite: false, recentlyPlayed: false };
  state.gridLimit = state.gridPageSize;
}

export function matchesTrackFilters(track, isFavorite) {
  const filter = state.filters;
  if (filter.genre && String(track.genre || "") !== filter.genre) return false;
  if (filter.year && String(track.year || "") !== filter.year) return false;
  if (filter.codec && String(track.codec || "") !== filter.codec) return false;
  if (filter.favorite && !isFavorite(track.id)) return false;
  if (filter.recentlyPlayed && !state.recentIds.includes(track.id)) return false;
  if (filter.duration === "short" && Number(track.duration) >= 180) return false;
  if (filter.duration === "medium" && (Number(track.duration) < 180 || Number(track.duration) > 360)) return false;
  if (filter.duration === "long" && Number(track.duration) <= 360) return false;
  return true;
}
