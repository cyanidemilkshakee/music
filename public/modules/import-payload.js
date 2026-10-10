const encoder = new TextEncoder();

export function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} bytes`;
}

export function importLimits(health) {
  const limits = health?.limits;
  if (!Number.isSafeInteger(limits?.jsonLimitBytes) || limits.jsonLimitBytes <= 0
      || !Number.isSafeInteger(limits?.m3uTextBytes) || limits.m3uTextBytes <= 0) {
    throw new Error('Could not retrieve the server import limits. Refresh diagnostics or restart Local Amp before importing.');
  }
  return { jsonLimitBytes: limits.jsonLimitBytes, m3uTextBytes: limits.m3uTextBytes };
}

function checkBytes(text, limit, label) {
  const bytes = encoder.encode(text).byteLength;
  if (bytes > limit) {
    throw new Error(`${label} is ${formatBytes(bytes)} (${bytes.toLocaleString()} bytes); the server limit is ${formatBytes(limit)} (${limit.toLocaleString()} bytes). Use a smaller import or increase JSON_LIMIT and restart Local Amp.`);
  }
  return text;
}

export function backupBody(text, limits) {
  let parsed;
  try { parsed = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('This backup is not valid JSON. Choose a Local Amp library backup.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Choose a Local Amp library backup containing a JSON object.');
  }
  return checkBytes(JSON.stringify(parsed), limits.jsonLimitBytes, 'Backup request');
}

export function m3uBody(fileName, text, limits) {
  const name = Array.from(fileName.replace(/\.m3u8?$/i, '').trim()).slice(0, 120).join('') || 'Imported playlist';
  const textBytes = encoder.encode(text).byteLength;
  if (textBytes > limits.m3uTextBytes) {
    throw new Error(`Playlist text is ${formatBytes(textBytes)} (${textBytes.toLocaleString()} bytes); the server limit is ${formatBytes(limits.m3uTextBytes)} (${limits.m3uTextBytes.toLocaleString()} bytes). Split the playlist into smaller files.`);
  }
  return checkBytes(JSON.stringify({ name, text }), limits.jsonLimitBytes, 'Playlist request including escaped paths');
}
