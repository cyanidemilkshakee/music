import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'dist');
const compilerLicense = process.argv[2];
if (!compilerLicense) throw new Error('Supply the Inno Setup compiler license.txt path.');
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: join(root, 'backend'), encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `${command} failed`);
  return result.stdout.trim();
}
const metadata = JSON.parse(run('cargo', ['metadata', '--locked', '--format-version', '1', '--filter-platform', 'x86_64-pc-windows-msvc']));
const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
const included = new Set();
function visit(id) {
  if (included.has(id)) return;
  included.add(id);
  for (const dependency of nodes.get(id).deps) {
    if (dependency.dep_kinds.some(kind => kind.kind !== 'dev')) visit(dependency.pkg);
  }
}
visit(metadata.resolve.root);
function licenseFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...licenseFiles(path));
    else if (entry.isFile() && /^(LICENSE|LICENCE|COPYING|NOTICE|COPYRIGHT)([._-].*)?$/i.test(entry.name)) files.push(path);
  }
  return files.sort();
}
const sections = [
  'Local Amp third-party license texts',
  'Generated from the locked Windows production/build dependency graph. Development-only packages are excluded.',
  'Crate authors retain their copyrights. Individual license expressions and complete supplied notices follow.',
  'The Rust standard-library notices are in RUST_STDLIB_LICENSES.html beside this file. SQLite is in the public domain.',
];
let packageCount = 0;
for (const pkg of metadata.packages.filter(pkg => included.has(pkg.id) && pkg.id !== metadata.resolve.root)
  .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'))) {
  const directory = dirname(pkg.manifest_path);
  let files = licenseFiles(directory);
  if (pkg.license_file && !files.includes(join(directory, pkg.license_file))) files.push(join(directory, pkg.license_file));
  if (pkg.name === 'alloc-stdlib' && pkg.version === '0.2.4' && pkg.license === 'BSD-3-Clause') {
    // Its crate archive omits the shared repository LICENSE. Retained from the
    // exact upstream revision in .cargo_vcs_info.json; see THIRD_PARTY_NOTICES.md.
    files = [join(root, 'docs/licenses/alloc-stdlib-0.2.4.txt')];
  }
  if (!files.length) throw new Error(`No license texts found for ${pkg.name}@${pkg.version}; add a reviewed upstream notice before packaging.`);
  sections.push('\n' + '='.repeat(72), `${pkg.name} ${pkg.version}`, `License: ${pkg.license || 'See supplied license file'}`,
    `Authors: ${pkg.authors.join(', ') || 'See notices and repository history'}`, `Repository: ${pkg.repository || pkg.homepage || 'See crates.io'}`);
  for (const file of files) {
    const text = readFileSync(file, 'utf8').trim();
    if (!text) throw new Error(`Empty license text for ${pkg.name}@${pkg.version}`);
    sections.push(`\n--- ${file.startsWith(directory) ? relative(directory, file).replaceAll('\\', '/') : 'Shared upstream LICENSE'} ---\n`, text);
  }
  packageCount++;
}
const sysroot = run('rustc', ['--print', 'sysroot']);
const rustDocs = join(sysroot, 'share/doc/rust');
sections.push('\n' + '='.repeat(72), 'Rust standard library', run('rustc', ['--version']));
for (const name of ['MIT.txt', 'Apache-2.0.txt']) sections.push(`\n--- ${name} ---\n`, readFileSync(join(rustDocs, 'licenses', name), 'utf8').trim());
sections.push('\n' + '='.repeat(72), 'Inno Setup installer engine', readFileSync(compilerLicense, 'utf8').trim());
mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'THIRD_PARTY_LICENSES.txt'), sections.join('\n') + '\n', 'utf8');
copyFileSync(join(rustDocs, 'COPYRIGHT-library.html'), join(output, 'RUST_STDLIB_LICENSES.html'));
console.log(`License bundle complete: ${packageCount} locked Windows crates, Rust standard library and Inno Setup.`);
