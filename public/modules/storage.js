const memoryStore = new Map();

function storageAvailable() {
  try {
    const key = "__local_amp_storage_test__";
    window.localStorage.setItem(key, key);
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

const canUseLocalStorage = storageAvailable();

export function getStorage(key, fallback = "") {
  try {
    if (canUseLocalStorage) {
      const value = window.localStorage.getItem(key);
      return value === null ? fallback : value;
    }
  } catch {
    // Fall through to in-memory storage.
  }
  return memoryStore.has(key) ? memoryStore.get(key) : fallback;
}

export function setStorage(key, value) {
  const nextValue = String(value);
  memoryStore.set(key, nextValue);
  try {
    if (canUseLocalStorage) window.localStorage.setItem(key, nextValue);
  } catch {
    // Private browsing or quota errors should not break playback.
  }
}

export function removeStorage(key) {
  memoryStore.delete(key);
  try {
    if (canUseLocalStorage) window.localStorage.removeItem(key);
  } catch {
    // Ignore storage failures.
  }
}
