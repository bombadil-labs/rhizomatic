// The Rust witness builds a fixed, small number of integration test programs. Cargo links every
// test target as its own program, with its own copy of the crate, every dependency and their
// debug info: 74 targets once filled about 10 GB per build directory. A new test is a module of
// tests/witness.rs (a `mod` line there), never a new target. See AGENTS.md, "Build size".
//   node --test tools/check-rust-test-programs.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_TEST_PROGRAMS = 2;
const HOW = 'Each test target is a full link of the crate and its dependencies. ' +
  'Add a test as a module of the one program: put the file in implementations/rust/tests/ and add ' +
  '`mod <file>;` to tests/witness.rs. See AGENTS.md, "Build size".';

export function checkTestPrograms(cargoToml, files) {
  const problems = [];
  if (!/^autotests\s*=\s*false\s*$/m.test(cargoToml)) problems.push('Cargo.toml must set `autotests = false`, or every tests/*.rs becomes its own program');
  const roots = [...cargoToml.matchAll(/^\[\[test\]\]\s*\n((?:(?!\[).*\n?)*)/gm)].map(m => (m[1].match(/^path\s*=\s*"([^"]+)"/m) ?? [])[1]);
  if (roots.length > MAX_TEST_PROGRAMS) problems.push(`Cargo.toml declares ${roots.length} test programs; the limit is ${MAX_TEST_PROGRAMS}`);
  if (roots.some(r => r === undefined)) problems.push('every [[test]] needs an explicit path');
  const declared = new Map();
  for (const root of roots.filter(Boolean)) {
    const source = files[root];
    if (source === undefined) { problems.push(`test program ${root} does not exist`); continue; }
    for (const m of source.matchAll(/^(#\[path = "([^"]+)"\]\s*\n)?mod (\w+);/gm)) {
      const file = 'tests/' + (m[2] ?? m[3] + '.rs');
      if (declared.has(file)) problems.push(`${file} is a module of both ${declared.get(file)} and ${root}`);
      declared.set(file, root);
    }
  }
  const allSources = Object.entries(files).map(([, s]) => s).join('\n');
  for (const file of Object.keys(files)) {
    if (!/^tests\/[^/]+\.rs$/.test(file)) {
      const name = file.replace(/^tests\//, '');
      if (file.startsWith('tests/support/') && allSources.includes(`"${name}"`)) continue;
      problems.push(`${file} is not compiled: only tests/*.rs modules and referenced tests/support/*.rs helpers run`);
      continue;
    }
    if (!roots.includes(file) && !declared.has(file)) problems.push(`${file} is in no test program, so its tests never run`);
  }
  return problems.map(p => p + '. ' + HOW);
}

function rustTestFiles(dir) {
  const out = {};
  const walk = (rel) => {
    for (const name of readdirSync(join(dir, rel))) {
      const path = rel ? rel + '/' + name : name;
      if (statSync(join(dir, path)).isDirectory()) walk(path);
      else out[path] = readFileSync(join(dir, path), 'utf8');
    }
  };
  walk('tests');
  return out;
}

const crate = new URL('../implementations/rust/', import.meta.url).pathname;
const cargo = readFileSync(join(crate, 'Cargo.toml'), 'utf8');
const files = rustTestFiles(crate);

test('the Rust witness builds at most two integration test programs, and every test file is in one', () => {
  assert.deepEqual(checkTestPrograms(cargo, files), []);
  assert.ok(Object.keys(files).filter(f => /^tests\/[^/]+\.rs$/.test(f)).length > 70, 'the scan reads the real test files');
});

test('a new test target, an orphan test file or autotests left on is refused with the reason', () => {
  const extra = cargo + '\n[[test]]\nname = "store_vectors"\npath = "tests/store_vectors.rs"\n';
  assert.match(checkTestPrograms(extra, files).join('\n'), /declares 3 test programs.*full link/);
  assert.match(checkTestPrograms(cargo, { ...files, 'tests/forgotten.rs': '#[test] fn t() {}' }).join('\n'), /tests\/forgotten\.rs is in no test program/);
  assert.match(checkTestPrograms(cargo.replace(/^autotests = false\n/m, ''), files).join('\n'), /autotests = false/);
  assert.match(checkTestPrograms(cargo, { ...files, 'tests/nested/main.rs': 'fn main() {}' }).join('\n'), /tests\/nested\/main\.rs is not compiled/);
  const twice = { ...files, 'tests/private_source.rs': files['tests/private_source.rs'] + '\nmod store_vectors;\n' };
  assert.match(checkTestPrograms(cargo, twice).join('\n'), /store_vectors\.rs is a module of both/);
});
