import { getStorage, setStorage } from "./storage.js";

const STORAGE_KEY = "amp-favorite-tracks";

function loadFavorites() {
  try {
    const value = JSON.parse(getStorage(STORAGE_KEY, "[]"));
    return new Set(Array.isArray(value) ? value.filter(id => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

const favorites = loadFavorites();

function persist() {
  setStorage(STORAGE_KEY, JSON.stringify([...favorites]));
}

export function isFavorite(trackId) {
  return favorites.has(trackId);
}

export function toggleFavorite(trackId) {
  if (!trackId) return false;
  const added = !favorites.has(trackId);
  if (added) favorites.add(trackId);
  else favorites.delete(trackId);
  persist();
  return added;
}
