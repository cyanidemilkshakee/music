import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const path = process.argv[2] || fileURLToPath(new URL('../backend/target/x86_64-pc-windows-msvc/release/backend.exe', import.meta.url));
const data = readFileSync(path);
const pe = data.readUInt32LE(0x3c), count = data.readUInt16LE(pe + 6), optional = pe + 24;
if (data.toString('ascii', pe, pe + 2) !== 'PE') throw new Error('Not a Windows PE executable.');
const optionalSize = data.readUInt16LE(pe + 20);
const directory = optional + (data.readUInt16LE(optional) === 0x20b ? 112 : 96);
const sections = Array.from({ length: count }, (_, index) => {
  const offset = optional + optionalSize + index * 40;
  return { virtual: data.readUInt32LE(offset + 12), size: Math.max(data.readUInt32LE(offset + 8), data.readUInt32LE(offset + 16)), raw: data.readUInt32LE(offset + 20) };
});
const fileOffset = rva => { const section = sections.find(section => rva >= section.virtual && rva < section.virtual + section.size); return section ? section.raw + rva - section.virtual : rva; };
let offset = fileOffset(data.readUInt32LE(directory + 8));
const imports = [];
while (data.subarray(offset, offset + 20).some(byte => byte !== 0)) {
  const name = fileOffset(data.readUInt32LE(offset + 12));
  imports.push(data.toString('ascii', name, data.indexOf(0, name)));
  offset += 20;
}
const externalRuntime = imports.filter(name => /^(vcruntime|msvcp|msvcr)/i.test(name));
if (externalRuntime.length) throw new Error('Windows release requires external C runtime: ' + externalRuntime.join(', '));
console.log('Windows runtime check passed: ' + imports.join(', '));
