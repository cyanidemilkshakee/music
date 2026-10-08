import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const run = process.argv.includes('--run');
const args = [run ? 'run' : 'build', '--release', '--locked'];
const env = { ...process.env };
if (process.platform === 'win32') {
  args.push('--target', 'x86_64-pc-windows-msvc');
  env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS = ((env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS || '') + ' -C target-feature=+crt-static').trim();
}
const result = spawnSync('cargo', args, { cwd: fileURLToPath(new URL('../backend', import.meta.url)), env, stdio: 'inherit', windowsHide: true });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
