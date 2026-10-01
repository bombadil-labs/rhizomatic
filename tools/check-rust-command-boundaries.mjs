#!/usr/bin/env node
// Source-level enforcement, not compiler trait resolution or a transitive purity proof.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { processOutput } from './command-tower-process.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const assert = (ok, message) => { if (!ok) throw Error(message); };
const stable = value => JSON.stringify(Array.isArray(value) ? value.map(v => JSON.parse(stable(v))) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(stable(value[k]))])) : value);
const under = (path, prefix) => path === prefix || path.startsWith(prefix + '::');
const sourceName = d => basename(d.source, '.rs');
const location = d => `${sourceName(d)}::${d.symbol}`;
const fileHosts = new Set(['durable_state::write_durable_peer_state', 'durable_state::read_durable_peer_state', 'peer_state::write_peer_state', 'peer_state::read_peer_state', 'single_peer::FileDurablePeerStore', 'single_peer::FileDurablePeerStore::new', 'single_peer::FileDurablePeerStore::read_image', 'single_peer::FileDurablePeerStore::compare_and_set']);
const httpHosts = new Set(['http::serve_peer', 'http::ServerHandle', 'http::ServerHandle::drop', 'http::pull_from_url']);
const host = d => fileHosts.has(location(d)) || httpHosts.has(location(d)) || location(d) === 'signed_loose_admission::admit_signed_loose_ordinary_transfer';
const pureStd = ['std::primitive', 'std::collections', 'std::cmp', 'std::fmt', 'std::error', 'std::iter', 'std::mem', 'std::slice', 'std::str', 'std::option', 'std::result', 'std::convert', 'std::borrow', 'std::marker', 'std::ops', 'std::num', 'std::boxed', 'std::vec', 'std::string', 'std::clone', 'std::default', 'std::sync::Arc', 'std::io::ErrorKind'];
const crypto = { blake3: ['hash'], curve25519_dalek: ['sign'], ed25519_dalek: ['sign'], sha2: ['sign'] };
function externalAllowed(d) {
  const path = d.target, module = sourceName(d), external = path.split('::')[0];
  if (external === 'std' || external === 'core' || external === 'alloc') {
    const normalized = path.replace(/^(core|alloc)::/, 'std::');
    if (pureStd.some(p => under(normalized, p))) return true;
    if (['std::path::Path', 'std::path::Path::new', 'std::path::PathBuf', 'std::path::PathBuf::from'].includes(normalized)) return true;
    if (fileHosts.has(location(d)) && ['std::fs', 'std::io::Write'].some(p => under(normalized, p))) return true;
    if (httpHosts.has(location(d)) && ['std::thread', 'std::sync::Mutex'].some(p => under(normalized, p))) return true;
    if (module === 'http' && d.symbol === '<import>' && path === 'std::sync::Mutex') return true;
    return module === 'wasm' && d.symbol === 'rhz_call' && path === 'std::ptr::copy_nonoverlapping';
  }
  if (external === 'hex') return ['hex::encode', 'hex::decode'].includes(path);
  if (external === 'serde_json') return ['serde_json::Value', 'serde_json::Map', 'serde_json::Number', 'serde_json::Error'].some(p => under(path, p)) || ['serde_json::json', 'serde_json::from_str', 'serde_json::from_slice', 'serde_json::to_string', 'serde_json::to_vec', 'serde_json::to_value', 'serde_json::from_value'].includes(path);
  if (crypto[external]?.includes(module)) return true;
  if (external === 'tempfile') return fileHosts.has(location(d));
  if (external === 'tiny_http') return ['http::serve_peer', 'http::ServerHandle'].includes(location(d));
  if (external === 'ureq') return location(d) === 'http::pull_from_url';
  return false;
}
function hostTarget(path) {
  const parts = path.replace(/^crate::/, '').split('::');
  const key = parts.slice(0, 2).join('::');
  return key === 'signed_loose_admission::admit_signed_loose_ordinary_transfer' || key === 'single_peer::FileDurablePeerStore' || fileHosts.has(key) || httpHosts.has(key);
}
export function validateRustBoundaries(actual, inventory, boundaries, { compareInventory = true, api = [] } = {}) {
  assert(actual?.format === 'rhizomatic-semantic-api-inventory/1' && actual.witness === 'rust', 'invalid live Rust inventory');
  const cards = new Map(boundaries.cards.map(c => [c.id, c]));
  assert(cards.size === boundaries.cards.length, 'duplicate boundary card');
  for (const c of cards.values()) assert(Array.isArray(c.allowed_dependencies) && c.allowed_dependencies.every(id => cards.has(id)), `invalid dependencies: ${c.id}`);
  for (const e of actual.exports) assert(cards.has(e.owner), `unclassified Rust export owner: ${e.id}`);
  const edges = new Map([...cards.keys()].map(id => [id, new Set()]));
  for (const d of actual.dependencies) {
    assert(cards.has(d.owner), `unknown Rust owner: ${d.source} ${d.owner}`);
    if (d.form === 'macro-region') { assert(d.status === 'parsed-known-macro-arguments', 'unparsed macro region'); continue; }
    assert(['syn-import', 'syn-resolved-path', 'syn-external-import', 'syn-external-path'].includes(d.form), `unknown Rust dependency form: ${d.form}`);
    assert(['semantic-owner', 'compatibility-aggregate', 'host-adapter'].includes(d.sourceRegion), `unknown Rust source region: ${d.sourceRegion}`);
    const module = sourceName(d);
    assert(d.sourceRegion !== 'compatibility-aggregate' || module === 'lib', 'forged aggregate region');
    assert(d.sourceRegion !== 'host-adapter' || module === 'wasm', 'forged host region');
    if (d.targetOwner) {
      assert(cards.has(d.targetOwner), `unknown Rust target owner: ${d.target}`);
      // The root exports bindings. Only its import/reexport rows may cross owners.
      const aggregate = module === 'lib' && d.form === 'syn-import';
      const wasm = module === 'wasm' && ['delta', 'syntax', 'schema', 'resolve', 'federation'].includes(d.targetOwner);
      assert(aggregate || wasm || d.owner === d.targetOwner || cards.get(d.owner).allowed_dependencies.includes(d.targetOwner), `forbidden Rust dependency: ${location(d)} ${d.owner} -> ${d.targetOwner} (${d.target})`);
      assert(aggregate || host(d) || !hostTarget(d.resolvedTarget ?? d.target), `semantic Rust code reaches host adapter: ${location(d)} -> ${d.target}`);
      if (!aggregate && !wasm && d.owner !== d.targetOwner) edges.get(d.owner).add(d.targetOwner);
    } else assert(externalAllowed(d), `undeclared Rust external/ambient capability: ${location(d)} -> ${d.target}`);
  }
  const visited = new Set(), active = new Set();
  function visit(id) { assert(!active.has(id), `Rust owner dependency cycle: ${id}`); if (visited.has(id)) return; active.add(id); for (const next of edges.get(id)) visit(next); active.delete(id); visited.add(id); }
  for (const id of cards.keys()) visit(id);
  if (!compareInventory) return;
  assert(inventory?.format === actual.format && inventory.witness === 'rust', 'invalid recorded Rust inventory');
  const contracts = new Map([...cards.keys()].map(owner => [`rhizomatic.${owner}/native-api/1`, [owner]]));
  for (const contract of api) {
    assert(typeof contract.id === 'string' && !contracts.has(contract.id) && Array.isArray(contract.owners) && contract.owners.length > 0 && contract.owners.every(owner => cards.has(owner)) && typeof contract.semantics === 'string' && contract.semantics.trim(), `invalid named Rust API contract: ${contract.id}`);
    contracts.set(contract.id, contract.owners);
  }
  const recorded = new Map(inventory.exports.map(e => [e.id, e]));
  assert(recorded.size === inventory.exports.length, 'duplicate Rust export classification');
  for (const e of actual.exports) {
    const known = recorded.get(e.id);
    assert(known, `unclassified public Rust export: ${e.id}`);
    for (const key of ['id', 'source', 'symbol', 'owner', 'definition', 'target', 'cfg']) assert(stable(known[key] ?? null) === stable(e[key] ?? null), `stale Rust export ${e.id}: ${key}`);
    assert(contracts.get(known.contract)?.includes(known.owner) && boundaries.export_classifications.includes(known.classification) && typeof known.semantics === 'string' && known.semantics.trim(), `invalid Rust export contract/classification: ${e.id}`);
    recorded.delete(e.id);
  }
  assert(recorded.size === 0, `removed Rust exports remain classified: ${[...recorded.keys()].join(', ')}`);
  const canonicalRows = rows => rows.map(stable).sort();
  assert(stable(canonicalRows(inventory.dependencies)) === stable(canonicalRows(actual.dependencies)), 'stale Rust dependency inventory; regenerate and review ownership');
}
export async function buildRustInventoryGenerator(repository = root) {
  const rust = await processOutput('rustc', ['--version', '--verbose']);
  const target = /^host: (.+)$/m.exec(rust)?.[1];
  assert(target, 'rustc did not report host target');
  const output = await processOutput('cargo', ['build', '--locked', '--quiet', '--manifest-path', join(repository, 'implementations/rust/Cargo.toml'), '--target', target, '--example', 'command_inventory', '--message-format=json'], { cwd: repository, timeout: 600000 });
  const artifacts = output.trim().split('\n').filter(Boolean).map(JSON.parse).filter(m => m.reason === 'compiler-artifact' && m.target?.name === 'command_inventory' && m.target.kind?.includes('example') && m.executable);
  assert(artifacts.length === 1, 'Cargo must report one inventory executable');
  return artifacts[0].executable;
}
export async function generateRustInventory(binary, repository = root) { return JSON.parse(await processOutput(binary, [repository], { cwd: repository })); }
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const binary = await buildRustInventoryGenerator();
  const actual = await generateRustInventory(binary);
  validateRustBoundaries(actual, read(join(root, 'contracts/command/rust-exports.json')), read(join(root, 'contracts/command/BOUNDARIES.json')), { api: existsSync(join(root, 'contracts/command/API.json')) ? read(join(root, 'contracts/command/API.json')).contracts : [] });
  console.log(`Rust boundaries: ${actual.exports.length} classified exports and ${actual.dependencies.length} AST dependency records checked against live source.`);
}
