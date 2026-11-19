import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adoptRustInventory, validateRustBoundaries } from './check-rust-command-boundaries.mjs';
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
  assert.deepEqual(notes, ['regenerated rust:cbor:encode: owner changed; write its semantics again if they were hand-written']);
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
