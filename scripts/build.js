import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const run = process.argv.includes('--run');
const debug = process.argv.includes('--debug');
const args = ['build', ...(debug ? [] : ['--release']), '--locked'];
const root = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env };
if (process.platform === 'win32') {
  args.push('--target', 'x86_64-pc-windows-msvc');
  env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS = ((env.CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS || '') + ' -C target-feature=+crt-static').trim();
}
const result = spawnSync('cargo', args, { cwd: path.join(root,'backend'), env, stdio: 'inherit', windowsHide: true });
if (result.error) console.error(result.error.message);
if (result.status !== 0 || !run) process.exit(result.status ?? 1);
const targetRoot = env.CARGO_TARGET_DIR ? path.resolve(root,'backend',env.CARGO_TARGET_DIR) : path.join(root,'backend','target');
const binary = path.join(targetRoot,...(process.platform === 'win32' ? ['x86_64-pc-windows-msvc'] : []),debug ? 'debug' : 'release',process.platform === 'win32' ? 'backend.exe' : 'backend');
const data = path.resolve(root,env.DATA_DIR || 'data');
if (process.platform === 'win32') {
  const launched=spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'), ['-NoProfile','-File',path.join(root,'scripts','Launch-LocalAmp.ps1'),'-Executable',binary,'-DataDirectory',data,'-Port',env.PORT || '1111'],{env,stdio:'inherit',windowsHide:true});
  process.exit(launched.status ?? 1);
}
const server=spawn(binary,[],{env:{...env,DATA_DIR:data},cwd:root,stdio:'inherit'});
server.on('error',error=>{console.error(error.message);process.exitCode=1;});
server.on('exit',code=>{process.exitCode=code ?? 1;});
process.on('SIGINT',()=>server.kill('SIGINT'));
process.on('SIGTERM',()=>server.kill('SIGTERM'));
for(let attempt=0;attempt<100 && server.exitCode===null;attempt++) {
  try {
    const credential=JSON.parse(await readFile(path.join(data,'launch.json'),'utf8'));
    if(credential.processId === server.pid) {
      const opener=process.platform === 'darwin' ? 'open' : 'xdg-open';
      const browser=spawn(opener,[path.join(data,'launch.html')],{stdio:'ignore'});
      browser.on('error',()=>console.error('Open the private launch.html file in your DATA_DIR using your browser.'));
      break;
    }
  } catch { /* Startup has not written the private launch file yet. */ }
  await new Promise(resolve=>setTimeout(resolve,100));
}
