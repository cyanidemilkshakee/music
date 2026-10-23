import { Linter } from 'eslint';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const publicRoot = join(root, 'public');
const linter = new Linter();
function parse(path) {
  let ast;
  const errors = linter.verify(readFileSync(path, 'utf8'), [{
    plugins: { links: { rules: { capture: {
      meta: { schema: [] }, create: () => ({ Program(node) { ast = node; } }),
    } } } }, rules: { 'links/capture': 'error' },
  }]);
  if (!ast || errors.length) throw new Error(`Cannot parse ${relative(root, path)}: ${errors[0]?.message}`);
  return ast;
}
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.name.endsWith('.js') ? [path] : [];
  });
}
const modules = new Map(files(publicRoot).map(path => [path, { ast: parse(path), exports: new Set(), imports: [] }]));
const name = node => node.name ?? node.value;
for (const [path, module] of modules) {
  for (const statement of module.ast.body) {
    if (statement.type === 'ImportDeclaration') {
      module.imports.push({ path: resolve(dirname(path), statement.source.value), names: statement.specifiers.map(specifier =>
        specifier.type === 'ImportSpecifier' ? name(specifier.imported) : specifier.type === 'ImportDefaultSpecifier' ? 'default' : '*') });
    } else if (statement.type === 'ExportNamedDeclaration') {
      if (statement.declaration?.id) module.exports.add(statement.declaration.id.name);
      for (const declaration of statement.declaration?.declarations || []) module.exports.add(declaration.id.name);
      for (const specifier of statement.specifiers) module.exports.add(name(specifier.exported));
      if (statement.source) module.imports.push({ path: resolve(dirname(path), statement.source.value), names: statement.specifiers.map(specifier => name(specifier.local)) });
    } else if (statement.type === 'ExportDefaultDeclaration') module.exports.add('default');
    else if (statement.type === 'ExportAllDeclaration') throw new Error(`Use explicit re-exports in ${relative(root, path)} so unused exports can be checked.`);
  }
}
const reachable = new Set(), used = new Map(), errors = [];
function visit(path) {
  if (reachable.has(path)) return;
  const module = modules.get(path);
  if (!module) { errors.push(`Missing frontend module: ${relative(root, path)}`); return; }
  reachable.add(path);
  for (const dependency of module.imports) {
    const target = modules.get(dependency.path);
    if (!target) { errors.push(`${relative(root, path)} imports missing ${relative(root, dependency.path)}`); continue; }
    const names = used.get(dependency.path) || new Set();
    for (const imported of dependency.names) {
      if (imported === '*') target.exports.forEach(value => names.add(value));
      else { names.add(imported); if (!target.exports.has(imported)) errors.push(`${relative(root, path)} imports missing export ${imported}`); }
    }
    used.set(dependency.path, names);
    visit(dependency.path);
  }
}
const html = readFileSync(join(publicRoot, 'index.html'), 'utf8');
for (const match of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)) visit(resolve(publicRoot, match[1].replace(/^\//, '')));
for (const [path, module] of modules) {
  if (!reachable.has(path)) errors.push(`Unreachable frontend file: ${relative(root, path)}`);
  for (const exported of module.exports) if (!used.get(path)?.has(exported)) errors.push(`Unused export: ${relative(root, path)} -> ${exported}`);
}
const sources = html + readFileSync(join(publicRoot, 'styles.css'), 'utf8')
  + [...modules.keys()].map(path => readFileSync(path, 'utf8')).join('\n');
function checkAssets(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) checkAssets(path);
    else {
      const url = '/' + relative(publicRoot, path).replaceAll('\\', '/');
      if (!sources.includes(url)) errors.push(`Unreferenced frontend asset: ${url}`);
    }
  }
}
checkAssets(join(publicRoot, 'assets'));
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log(`Frontend links passed: ${reachable.size} reachable modules; no missing imports or unused exports.`);
