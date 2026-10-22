import { lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendRoot = path.join(repoRoot, 'backend');
const targetRoot = path.join(backendRoot, 'target');

if (path.dirname(targetRoot) !== backendRoot || path.basename(targetRoot) !== 'target') {
  throw new Error('Refusing to clean an unexpected Rust build path.');
}

try {
  const targetInfo = await lstat(targetRoot);
  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
    throw new Error(`Refusing to remove non-directory build path: ${targetRoot}`);
  }
  await rm(targetRoot, { recursive: true, force: true });
  console.log('Removed Rust build artifacts from backend/target.');
} catch (error) {
  if (error.code === 'ENOENT') {
    console.log('No Rust build artifacts found in backend/target.');
  } else {
    throw error;
  }
}
