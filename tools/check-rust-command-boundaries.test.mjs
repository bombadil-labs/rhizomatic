import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRustBoundaries, buildRustInventoryGenerator, generateRustInventory } from './check-rust-command-boundaries.mjs';
const boundaries = JSON.parse(readFileSync(new URL('../contracts/command/BOUNDARIES.json', import.meta.url)));
let binary;
const fixture = async files => {
  binary ??= await buildRustInventoryGenerator();
  const root = mkdtempSync(join(tmpdir(), 'rhz-rust-boundary-'));
  mkdirSync(join(root, 'implementations/rust/src'), { recursive: true });
  writeFileSync(join(root, 'implementations/rust/Cargo.toml'), '[package]\nname="rhizomatic"\nversion="0.0.0"\nedition="2021"\n[dependencies]\nblake3="1"\n');
  writeFileSync(join(root, 'implementations/rust/src/lib.rs'), '');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, 'implementations/rust/src', name + '.rs'), content);
  try { return await generateRustInventory(binary, root); } finally { rmSync(root, { recursive: true, force: true }); }
};
const check = actual => validateRustBoundaries(actual, null, boundaries, { compareInventory: false });
const negatives = [
  ["custom derive expansion", {"delta": "#[derive(hidden::Injected)] pub struct Example;"}, /unsupported.*(attribute|derive|cfg|allow)/],
  ["custom attribute expansion", {"delta": "#[hidden::inject] pub fn ordinary() {}"}, /unsupported.*(attribute|derive|cfg|allow)/],
  ["conditional attribute expansion", {"delta": "#[cfg_attr(any(), hidden::inject)] pub fn ordinary() {}"}, /unsupported.*(attribute|derive|cfg|allow)/],
  ["conditional derive expansion", {"delta": "#[cfg_attr(any(), derive(hidden::Injected))] pub struct Example;"}, /unsupported.*(attribute|derive|cfg|allow)/],
  ["nonliteral documentation expansion", {"delta": "#[doc = include_str!(\"unread\")] pub fn ordinary() {}"}, /unsupported.*(attribute|derive|cfg|allow)/],
  ["inner attribute expansion", {"delta": "#![hidden::inject]\npub fn ordinary() {}"}, /unsupported.*(attribute|derive|cfg|allow)/],
  ["nonliteral cfg expansion", {"delta": "#[cfg(target_arch = concat!(\"wasm\", \"32\"))] pub fn ordinary() {}"}, /unsupported.*(attribute|derive|cfg|allow)/],
  ["nonliteral allow expansion", {"delta": "#[allow(dead_code, reason = concat!(\"a\", \"b\"))] pub fn ordinary() {}"}, /unsupported.*(attribute|derive|cfg|allow)/],
  ['extern crate alias', { delta: 'extern crate std as ambient; pub fn bad() { let _ = ambient::env::var("x"); }' }, /ambient capability|unsupported.*extern/],
  ['matches pattern upward dependency', { delta: 'pub fn bad() { let value = None; let _ = matches!(value, Some(crate::command::Kind::A)); }', command: 'pub enum Kind { A }' }, /forbidden Rust dependency/],
  ['redirected production module', { lib: '#[path="../../../external.rs"] pub mod command;', '../../../external': 'pub fn hidden() { let _ = std::env::var("x"); }' }, /unsupported.*path|module.*path|redirect/],
  ['conditional redirected production module', { lib: '#[cfg_attr(not(target_arch="wasm32"), path="../../../external.rs")] pub mod command;', '../../../external': 'pub fn hidden() { let _ = std::env::var("x"); }', command: 'pub fn ordinary() {}' }, /unsupported.*path|module.*path|redirect/],
  ['foreign host interface', { delta: 'extern "C" { pub fn hidden_host_read() -> u32; }' }, /unsupported.*foreign|unsupported.*extern|host/],
  ['upward function', { delta: 'pub fn bad() { crate::command::call(); }' }, /forbidden Rust dependency/],
  ['local upward alias', { delta: 'fn bad() { use crate::command::call as hidden; hidden(); }' }, /forbidden Rust dependency/],
  ['relative upward path', { delta: 'fn bad() { super::command::call(); }' }, /forbidden Rust dependency|unsupported/],
  ['upward type', { delta: 'pub struct Bad { pub command: crate::command::Command }' }, /forbidden Rust dependency/],
  ['path observation', { delta: 'fn bad() { std::path::Path::exists(std::path::Path::new("x")); }' }, /ambient capability/],
  ['qualified environment', { delta: 'fn bad() { std::env::var("SECRET"); }' }, /ambient capability/],
  ['local filesystem alias', { delta: 'fn bad() { use std::fs as hidden; hidden::read("x"); }' }, /ambient capability/],
  ['local clock alias', { delta: 'fn bad() { use std::time::SystemTime as Hidden; Hidden::now(); }' }, /ambient capability/],
  ['macro hidden environment', { delta: 'fn bad() { let _ = format!("{:?}", std::env::vars()); }' }, /ambient capability/],
  ['cfg hidden host', { delta: '#[cfg(target_arch="wasm32")] fn bad() { std::fs::read("x"); }' }, /ambient capability/],
  ['pure federation filesystem', { peer_state: 'fn validate() { std::fs::read("x"); }' }, /ambient capability/],
  ['pure call to host adapter', { peer_state: 'fn validate() { crate::durable_state::write_durable_peer_state(); }' }, /reaches host adapter/],
  ['aggregate host alias', { lib: 'pub mod durable_state; pub mod peer_state; pub use durable_state::write_durable_peer_state;', durable_state: 'pub fn write_durable_peer_state() {}', peer_state: 'fn validate() { use crate::write_durable_peer_state as write; write(); }' }, /reaches host adapter/],
  ['unknown external import', { delta: 'use mystery::compute; fn bad() { compute(); }' }, /unsupported unresolved import/],
  ['crypto outside intrinsic', { command: 'use blake3::hash; fn bad() { hash(b"x"); }' }, /ambient capability/],
  ['glob import', { delta: 'use std::fs::*;' }, /glob import/],
  ['unknown macro', { delta: 'fn bad() { mystery!(); }' }, /macro/],
  ['unmapped source', { mystery: 'pub fn mystery() {}' }, /unclassified|unknown|unsupported/],
];
for (const [name, files, error] of negatives) test(`real Rust source rejects ${name}`, async () => {
  await assert.rejects(async () => check(await fixture(files)), error);
});
for (const [name, files] of [
  ["builtin derives", {"delta": "#[derive(Debug,Clone,Copy,Default,PartialEq,Eq,PartialOrd,Ord,Hash)] pub struct Example { pub value: u32 }"}],
  ["nested builtin attributes", {"delta": "#[cfg_attr(not(target_arch=\"wasm32\"), allow(dead_code, reason=\"fixture\"))] #[doc=\"fixture\"] pub fn ordinary() {}"}],
  ["builtin inner attribute", {"delta": "#![allow(dead_code)]\npub fn ordinary() {}"}],
  ['ordinary intrinsic', { delta: 'pub fn pure() { let _ = std::collections::BTreeSet::<u8>::new(); }' }],
  ['declared file function', { durable_state: 'pub fn write_durable_peer_state() { use std::fs; let _ = fs::read("explicit"); }' }],
  ['local downward alias', { command_data: 'fn pure() { use crate::delta::canonical_bytes as bytes; bytes(); }' }],
  ['root compatibility reexport', { lib: 'pub mod command; pub use command::Command;', command: 'pub struct Command;' }],
]) test(`real Rust source permits ${name}`, async () => check(await fixture(files)));
test('live structural inventory detects missing, stale, duplicate, invalid and removed classifications', async () => {
  const actual = await fixture({ delta: 'pub fn pure() {}' });
  validateRustBoundaries(actual, actual, boundaries);
  for (const mutate of [
    j => j.exports.pop(), j => j.exports.push(j.exports[0]),
    j => { j.exports[0].owner = 'command'; }, j => { j.exports[0].classification = 'unknown'; },
    j => { j.exports[0].contract = 'unknown'; }, j => { j.exports[0].semantics = ''; },
    j => j.exports.push({ ...j.exports[0], id: 'rust:delta:removed' }),
    j => j.dependencies.push({ form: 'stale' }),
  ]) { const changed = structuredClone(actual); mutate(changed); assert.throws(() => validateRustBoundaries(actual, changed, boundaries)); }
});

test('named API contracts must declare the actual semantic owner', async () => {
  const actual = await fixture({ delta: 'pub fn pure() {}' });
  const inventory = structuredClone(actual);
  inventory.exports[0].contract = 'rhizomatic.test/1';
  const api = [{ id: 'rhizomatic.test/1', owners: ['delta'], semantics: 'Explicit input canonicalization.' }];
  validateRustBoundaries(actual, inventory, boundaries, { api });
  assert.throws(() => validateRustBoundaries(actual, inventory, boundaries, { api: [{ ...api[0], owners: ['command'] }] }), /invalid Rust export/);
  assert.throws(() => validateRustBoundaries(actual, inventory, boundaries, { api: [...api, ...api] }), /invalid named/);
});

test('new public associated constants cannot pass an unchanged export inventory', async () => {
  const before = await fixture({ delta: 'pub struct Example; impl Example {}' });
  const after = await fixture({ delta: 'pub struct Example; impl Example { pub const CALLBACK: fn() = || {}; }' });
  assert(after.exports.some(e => e.symbol === 'Example::CALLBACK'));
  assert.throws(() => validateRustBoundaries(after, before, boundaries), /unclassified public Rust export/);
});
test('a public union is inventoried or refused as unsupported syntax', async () => {
  let actual;
  try { actual = await fixture({ delta: 'pub union Example { pub value: u32, pub other: i32 }' }); }
  catch (error) { assert.match(String(error), /unsupported.*union/); return; }
  assert(actual.exports.some(e => e.symbol === 'Example' && e.definition === 'union'));
});
