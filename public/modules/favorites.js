import { getStorage, setStorage } from "./storage.js";
import { api } from "./api.js";
import { state } from "./state.js";

const STORAGE_KEY = "amp-favorite-tracks";

function loadFavorites() {
  try {
    const value = JSON.parse(getStorage(STORAGE_KEY, "[]"));
    return new Set(Array.isArray(value) ? value.filter(id => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

let favorites = loadFavorites();

function persist() {
  setStorage(STORAGE_KEY, JSON.stringify([...favorites]));
}

export function isFavorite(trackId) {
  return favorites.has(trackId);
}

export function syncFavorites(ids) {
  favorites = new Set(Array.isArray(ids) ? ids : []);
  state.favoriteRevision = (state.favoriteRevision || 0) + 1;
  persist();
}
export async function migrateFavorites(serverIds, isCurrent = () => true) {
  if (!isCurrent()) return;
  const local = [...favorites];
  syncFavorites(serverIds);
  if (getStorage("amp-favorites-migrated", "") === "yes") return;
  const valid = new Set(state.trackIds);
  for (const id of local.filter(id => valid.has(id) && !favorites.has(id))) {
    const data = await api(`/api/favorites/${encodeURIComponent(id)}`, { method: "PUT" });
    if (!isCurrent()) return;
    syncFavorites(data.favorites);
  }
  if (isCurrent()) setStorage("amp-favorites-migrated", "yes");
}
export async function toggleFavorite(trackId) {
  if (!trackId) return false;
  const added = !favorites.has(trackId);
  const data = await api(`/api/favorites/${encodeURIComponent(trackId)}`, { method: added ? "PUT" : "DELETE" });
  syncFavorites(data.favorites);
  return added;
}
