let counter = 0;
export function createEntries(ids) { return ids.map(id => ({ id, key: `${Date.now()}-${counter++}` })); }
export function shuffled(entries, currentKey, random = Math.random) {
  const current = entries.find(entry => entry.key === currentKey);
  const rest = entries.filter(entry => entry.key !== currentKey);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return current ? [current, ...rest] : rest;
}
export function moveEntry(entries, from, to) {
  const next = [...entries];
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= next.length || to >= next.length) return next;
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}
export function nextIndex(index, length, repeat, ended = false) {
  if (!length) return -1;
  if (ended && repeat === "one" && index >= 0) return index;
  if (index + 1 < length) return index + 1;
  return repeat === "all" ? 0 : -1;
}
