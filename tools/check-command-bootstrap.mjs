#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { processOutput } from './command-tower-process.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const assert = (ok, message) => { if (!ok) throw Error(message); };
export function validateBootstrap(manifest, vectors, witnesses) {
  assert(manifest?.format === 'rhizomatic-bootstrap/1', 'invalid bootstrap manifest');
  assert(Object.keys(witnesses).sort().join(',') === 'rust,ts', 'bootstrap needs both native witnesses');
  const expected = {
    HyperSchemaSchema: vectors.bootstrap,
    // SPEC3's SchemaSchema uses the same generic gather body. Its own name and
    // pin remain separately asserted; sharing a hash alone is not sufficient.
    SchemaSchema: { ...vectors.schemaSchema, canonicalCborHex: vectors.bootstrap.canonicalCborHex },
  };
  for (const [name, vector] of Object.entries(expected)) {
    assert(manifest.canonical_pins?.[name] === vector.termHash, `bootstrap pin disagrees with shared vector: ${name}`);
    for (const [witness, native] of Object.entries(witnesses)) {
      assert(native?.[name], `missing native bootstrap: ${witness}/${name}`);
      for (const field of ['name', 'alg', 'canonicalCborHex', 'termHash']) assert(native[name][field] === vector[field], `native bootstrap mismatch: ${witness}/${name}/${field}`);
    }
  }
}
export async function nativeBootstrap(repository = root) {
  const rustVersion = await processOutput('rustc', ['--version', '--verbose']);
  const target = /^host: (.+)$/m.exec(rustVersion)?.[1];
  assert(target, 'rustc did not report host target');
  const output = await processOutput('cargo', ['build', '--locked', '--quiet', '--manifest-path', join(repository, 'implementations/rust/Cargo.toml'), '--target', target, '--example', 'command_bootstrap', '--message-format=json'], { cwd: repository, timeout: 600000 });
  const artifacts = output.trim().split('\n').filter(Boolean).map(JSON.parse).filter(m => m.reason === 'compiler-artifact' && m.target?.name === 'command_bootstrap' && m.target.kind?.includes('example') && m.executable);
  assert(artifacts.length === 1, 'Cargo must report one bootstrap executable');
  const tsDirectory = join(repository, 'implementations/ts');
  const schema = pathToFileURL(join(tsDirectory, 'src/schema-load/schema-deltas.ts')).href;
  const syntax = pathToFileURL(join(tsDirectory, 'src/syntax/term-io.ts')).href;
  // This invokes the actual exported constants and canonicalizers, without
  // requiring a generated inventory or parsing source text with regexes.
  const program = `import {HYPER_SCHEMA_SCHEMA,SCHEMA_SCHEMA} from ${JSON.stringify(schema)}; import {termHash,termCanonicalHex} from ${JSON.stringify(syntax)}; console.log(JSON.stringify(Object.fromEntries(Object.entries({HyperSchemaSchema:HYPER_SCHEMA_SCHEMA,SchemaSchema:SCHEMA_SCHEMA}).map(([name,value])=>[name,{name:value.name,alg:value.alg,termHash:termHash(value.body),canonicalCborHex:termCanonicalHex(value.body)}]))));`;
  const results = await Promise.allSettled([
    processOutput(process.execPath, ['--import', join(tsDirectory, 'node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e', program], { cwd: repository }),
    processOutput(artifacts[0].executable, [], { cwd: repository }),
  ]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  return { ts: JSON.parse(results[0].value), rust: JSON.parse(results[1].value) };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  validateBootstrap(read(join(root, 'contracts/command/bootstrap.json')), read(join(root, 'vectors/l1-eval/schema-deltas.json')), await nativeBootstrap());
  console.log('Bootstrap: both actual native bodies and pins match shared vectors and declared command bootstrap pins.');
}
