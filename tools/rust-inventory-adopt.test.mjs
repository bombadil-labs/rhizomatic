import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptRustInventory, adoptInventoryFile, validateRustBoundaries, buildRustInventoryGenerator, generateRustInventory } from './check-rust-command-boundaries.mjs';
const boundaries = JSON.parse(readFileSync(new URL('../contracts/command/BOUNDARIES.json', import.meta.url)));
const top = { format: 'rhizomatic-semantic-api-inventory/1', witness: 'rust', analysis: 'fixture' };
const generated = (owner, module, symbol, extra = {}) => ({ id: `rust:${module}:${symbol}`, owner, symbol, source: `implementations/rust/src/${module}.rs`, definition: 'function', contract: `rhizomatic.${owner}/native-api/1`, classification: 'native_extension', semantics: `${owner} owns the existing ${module}::${symbol} function.`, cfg: [], ...extra });
const written = (row, semantics) => ({ ...row, classification: 'implementation_helper', semantics });
const dep = (module, symbol, target, owner = 'delta', targetOwner = owner) => ({ form: 'syn-resolved-path', owner, rawTarget: target, resolvedTarget: target, source: `implementations/rust/src/${module}.rs`, sourceRegion: 'semantic-owner', symbol, target, targetOwner });
const inventory = (exports, dependencies) => ({ ...top, exports, dependencies });
const adopt = (recorded, live) => adoptRustInventory(JSON.parse(JSON.stringify(recorded)), JSON.parse(JSON.stringify(live)));
const accepts = (live, recorded) => validateRustBoundaries(live, recorded, boundaries);
const ids = rows => rows.map(e => e.id);

test('a dependency row that the generator emits twice stays twice, and the checker counts the repeat', () => {
  const twice = dep('cbor', 'encode', 'crate::cbor::CborValue');
  const live = inventory([generated('delta', 'cbor', 'encode')], [twice, twice, dep('cbor', 'encode', 'crate::types::Delta')]);
  assert.throws(() => accepts(live, inventory(live.exports, [twice, live.dependencies[2]])), /stale Rust dependency inventory/);
  const once = adopt(inventory(live.exports, [twice, live.dependencies[2]]), live);
  assert.deepEqual(once.inventory.dependencies.filter(d => d.target === twice.target).length, 2);
  assert.deepEqual(once.summary.dependencies, { added: 1, removed: 0, updated: 0, kept: 2 });
  accepts(live, once.inventory);
  const kept = adopt(live, live);
  assert.equal(kept.inventory.dependencies.length, 3);
  assert.deepEqual(kept.summary.dependencies, { added: 0, removed: 0, updated: 0, kept: 3 });
});

test('a dependency row whose owner or target moved is updated in its place', () => {
  const old = [dep('cbor', 'encode', 'crate::cbor::A'), dep('cbor', 'encode', 'crate::cbor::B'), dep('cbor', 'encode', 'crate::cbor::C')];
  const moved = { ...dep('cbor', 'encode', 'crate::cbor::B'), resolvedTarget: 'crate::types::B', target: 'crate::types::B' };
  const owner = dep('cbor', 'encode', 'crate::cbor::C', 'syntax', 'delta');
  const live = inventory([generated('delta', 'cbor', 'encode')], [old[0], moved, owner]);
  const { inventory: out, summary } = adopt(inventory(live.exports, old), live);
  assert.deepEqual(out.dependencies.map(d => [d.owner, d.target]), [['delta', 'crate::cbor::A'], ['delta', 'crate::types::B'], ['syntax', 'crate::cbor::C']]);
  assert.deepEqual(summary.dependencies, { added: 0, removed: 0, updated: 2, kept: 1 });
  accepts(live, out);
  const same = dep('cbor', 'encode', 'crate::cbor::T'), was = dep('cbor', 'encode', 'crate::cbor::T', 'syntax', 'delta'), now = dep('cbor', 'encode', 'crate::cbor::T', 'schema', 'delta');
  const shared = adopt(inventory(live.exports, [same, was]), inventory(live.exports, [now, same]));
  assert.deepEqual(shared.inventory.dependencies.map(d => d.owner), ['delta', 'schema'], 'an unchanged row keeps its place when a moved row shares its source and target');
  assert.deepEqual(shared.summary.dependencies, { added: 0, removed: 0, updated: 1, kept: 1 });
});

test('a row whose symbol is gone is dropped, for an export and for a dependency', () => {
  const gone = generated('delta', 'cbor', 'gone');
  const live = inventory([generated('delta', 'cbor', 'encode')], [dep('cbor', 'encode', 'crate::cbor::A')]);
  const recorded = inventory([written(gone, 'Hand text.'), ...live.exports], [dep('cbor', 'gone', 'crate::cbor::A'), ...live.dependencies]);
  assert.throws(() => accepts(live, recorded), /removed Rust exports remain classified: rust:cbor:gone/);
  const { inventory: out, summary } = adopt(recorded, live);
  assert.deepEqual(ids(out.exports), ['rust:cbor:encode']);
  assert.deepEqual(out.dependencies.map(d => d.symbol), ['encode']);
  assert.deepEqual(summary.exports, { added: 0, removed: 1, updated: 0, kept: 1 });
  assert.deepEqual(summary.dependencies, { added: 0, removed: 1, updated: 0, kept: 1 });
  accepts(live, out);
});

test('a new export takes the generator classification and semantics, after its nearest earlier live neighbour', () => {
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(s => generated('delta', 'cbor', s));
  const recorded = inventory([written(c, 'C by hand.'), written(a, 'A by hand.'), written(d, 'D by hand.')], []);
  const live = inventory([a, b, c, d], []);
  assert.throws(() => accepts(live, recorded), /unclassified public Rust export: rust:cbor:b/);
  const { inventory: out, summary } = adopt(recorded, live);
  assert.deepEqual(ids(out.exports), ['rust:cbor:c', 'rust:cbor:a', 'rust:cbor:b', 'rust:cbor:d']);
  const added = out.exports[2];
  assert.equal(added.classification, b.classification);
  assert.equal(added.semantics, b.semantics);
  assert.deepEqual(summary.exports, { added: 1, removed: 0, updated: 0, kept: 3 });
  accepts(live, out);
});

test('an existing export keeps its hand-written text when only its source, target or cfg changed, and the tool names it', () => {
  const live = generated('delta', 'cbor', 'encode', { source: 'implementations/rust/src/lib.rs', cfg: ['test'] });
  const recorded = inventory([written(generated('delta', 'cbor', 'encode'), 'Encodes by hand.')], []);
  assert.throws(() => accepts(inventory([live], []), recorded), /stale Rust export rust:cbor:encode: source/);
  const { inventory: out, notes, summary } = adopt(recorded, inventory([live], []));
  assert.equal(out.exports[0].semantics, 'Encodes by hand.');
  assert.equal(out.exports[0].classification, 'implementation_helper');
  assert.equal(out.exports[0].source, 'implementations/rust/src/lib.rs');
  assert.deepEqual(out.exports[0].cfg, ['test']);
  assert.deepEqual(notes, ['kept the text of rust:cbor:encode: source, cfg changed; check that its semantics are still true']);
  assert.deepEqual(summary.exports, { added: 0, removed: 0, updated: 1, kept: 0 });
  accepts(inventory([live], []), out);
});

test('an export whose owner moved takes the generator text, because the kept contract and semantics name the old owner', () => {
  const live = generated('syntax', 'cbor', 'encode');
  const recorded = inventory([written(generated('delta', 'cbor', 'encode'), 'delta encodes by hand.')], []);
  const { inventory: out, notes, summary } = adopt(recorded, inventory([live], []));
  assert.deepEqual(out.exports[0], live);
  assert.deepEqual(notes, ["regenerated rust:cbor:encode: owner changed. The generator's text replaced its contract, classification and semantics. Write them again if they were hand-written. Old classification: implementation_helper. Old semantics: delta encodes by hand."]);
  assert.deepEqual(summary.exports, { added: 0, removed: 0, updated: 1, kept: 0 });
  accepts(inventory([live], []), out);
  const kept = { ...out, exports: [{ ...live, contract: 'rhizomatic.delta/native-api/1' }] };
  assert.throws(() => accepts(inventory([live], []), kept), /invalid Rust export contract\/classification/);
});

test('a fresh inventory is a no-op: the second run changes nothing and reports every row kept', () => {
  const live = inventory([generated('delta', 'cbor', 'b'), generated('delta', 'cbor', 'a')], [dep('cbor', 'a', 'crate::cbor::X'), dep('cbor', 'a', 'crate::cbor::X'), dep('cbor', 'b', 'crate::cbor::Y')]);
  const recorded = inventory([written(generated('delta', 'cbor', 'a'), 'A by hand.')], [dep('cbor', 'b', 'crate::cbor::Y'), dep('cbor', 'gone', 'crate::cbor::Z')]);
  const first = adopt(recorded, live);
  const second = adopt(first.inventory, live);
  assert.equal(JSON.stringify(second.inventory), JSON.stringify(first.inventory));
  assert.deepEqual(second.notes, []);
  assert.deepEqual(second.summary, { exports: { added: 0, removed: 0, updated: 0, kept: 2 }, dependencies: { added: 0, removed: 0, updated: 0, kept: 3 } });
  assert.equal(first.inventory.exports.find(e => e.id === 'rust:cbor:a').semantics, 'A by hand.');
});

const scratch = body => { const dir = mkdtempSync(join(tmpdir(), 'rhz-rust-adopt-')); try { return body(join(dir, 'rust-exports.json')); } finally { rmSync(dir, { recursive: true, force: true }); } };
const fileText = value => JSON.stringify(value, null, 2) + '\n';
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, sorted(value[k])])) : value;

test('a dependency row repeated three or four times is kept in place: no row added or removed, and the file is not written', () => {
  const x = dep('cbor', 'encode', 'crate::cbor::X'), a = dep('cbor', 'encode', 'crate::cbor::A');
  for (const repeats of [3, 4]) {
    const live = inventory([generated('delta', 'cbor', 'encode')], [...Array(repeats).fill(x), a]);
    const { inventory: out, summary } = adopt(live, live);
    assert.deepEqual(summary.dependencies, { added: 0, removed: 0, updated: 0, kept: repeats + 1 });
    assert.equal(fileText(out), fileText(sorted(live)));
    scratch(path => {
      writeFileSync(path, fileText(sorted(live)));
      const bytes = readFileSync(path, 'utf8'), written = statSync(path).mtimeMs;
      const lines = adoptInventoryFile(path, live, boundaries);
      assert.deepEqual(lines.slice(-3), ['exports: 0 added, 0 removed, 0 updated, 1 kept', `dependencies: 0 added, 0 removed, 0 updated, ${repeats + 1} kept`, 'The Rust inventory was already fresh. Nothing changed.']);
      assert.equal(readFileSync(path, 'utf8'), bytes);
      assert.equal(statSync(path).mtimeMs, written);
    });
  }
  const moved = adopt(inventory([generated('delta', 'cbor', 'encode')], [x, x, a, x]), inventory([generated('delta', 'cbor', 'encode')], [x, x, x, a]));
  assert.deepEqual(moved.inventory.dependencies.map(d => d.target), ['crate::cbor::X', 'crate::cbor::X', 'crate::cbor::A', 'crate::cbor::X'], 'the recorded order stays');
  assert.deepEqual(moved.summary.dependencies, { added: 0, removed: 0, updated: 0, kept: 4 });
});

test('a removed export and an added export each get a line, so a rename shows its lost hand text', () => {
  const recorded = inventory([written(generated('delta', 'cbor', 'encode'), 'Encodes by hand.')], []);
  const live = inventory([generated('delta', 'cbor', 'encode_v2')], []);
  const { notes, summary } = adopt(recorded, live);
  assert.deepEqual(notes, [
    "added rust:cbor:encode_v2: its contract, classification and semantics are the generator's text. Write them by hand if they are not true.",
    'removed rust:cbor:encode: its hand-written contract, classification and semantics are lost unless you copy them to the row that replaces it. Old classification: implementation_helper. Old semantics: Encodes by hand.',
  ]);
  assert.deepEqual(summary.exports, { added: 1, removed: 1, updated: 0, kept: 0 });
});

test('an export whose definition alone changed is regenerated, and the tool names it with its old text', () => {
  const live = generated('delta', 'cbor', 'encode', { definition: 'struct' });
  const recorded = inventory([written(generated('delta', 'cbor', 'encode'), 'Encodes by hand.')], []);
  const { inventory: out, notes } = adopt(recorded, inventory([live], []));
  assert.deepEqual(out.exports[0], live);
  assert.deepEqual(notes, ["regenerated rust:cbor:encode: definition changed. The generator's text replaced its contract, classification and semantics. Write them again if they were hand-written. Old classification: implementation_helper. Old semantics: Encodes by hand."]);
});

test('the file is not written when the checker refuses the live source', () => {
  const live = inventory([generated('delta', 'cbor', 'encode')], [{ ...dep('cbor', 'encode', 'std::time::SystemTime::now'), form: 'syn-external-path', targetOwner: undefined }]);
  scratch(path => {
    const bytes = fileText(inventory([], []));
    writeFileSync(path, bytes);
    assert.throws(() => adoptInventoryFile(path, live, boundaries), /undeclared Rust external\/ambient capability/);
    assert.equal(readFileSync(path, 'utf8'), bytes);
  });
});

test('an empty or malformed inventory file is refused by name and not written; a missing file is created', () => {
  const live = inventory([generated('delta', 'cbor', 'encode')], [dep('cbor', 'encode', 'crate::cbor::X')]);
  scratch(path => {
    for (const [bytes, message] of [['', /rust-exports\.json is empty/], ['  \n', /rust-exports\.json is empty/], ['{"exports": [', /rust-exports\.json is not valid JSON/]]) {
      writeFileSync(path, bytes);
      assert.throws(() => adoptInventoryFile(path, live, boundaries), message);
      assert.equal(readFileSync(path, 'utf8'), bytes);
    }
    rmSync(path);
    assert.match(adoptInventoryFile(path, live, boundaries).at(-1), /^Wrote .*rust-exports\.json\. Review the diff\.$/);
    assert.ok(existsSync(path));
    accepts(live, JSON.parse(readFileSync(path, 'utf8')));
  });
});

test('--adopt on the committed inventory and the live source finds it already fresh and leaves the file unchanged', async () => {
  const actual = await generateRustInventory(await buildRustInventoryGenerator());
  const committed = readFileSync(new URL('../contracts/command/rust-exports.json', import.meta.url), 'utf8');
  scratch(path => {
    writeFileSync(path, committed);
    const lines = adoptInventoryFile(path, actual, boundaries);
    assert.equal(lines.at(-1), 'The Rust inventory was already fresh. Nothing changed.');
    assert.equal(lines.length, 3, lines.join('\n'));
    assert.equal(readFileSync(path, 'utf8'), committed);
  });
});
