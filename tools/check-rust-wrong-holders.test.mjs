// The Rust wrong holders of the views rails (`ViewQuirk`, `StoreViews::with_quirk`,
// `StoreViewsReader::quirk`) are public only with the feature `wrong-holders`. Without it,
// `ViewQuirk` is `pub(crate)`, so `cargo clippy --lib -- -D warnings` fails (`private_interfaces`)
// on any public item that accepts one. This guard keeps the parts that make that true: the feature
// is off by default, only the dev-dependency turns it on, `ViewQuirk` is `pub` only under the
// feature, and CI and precheck run the feature-off clippy.
//   node --test tools/check-rust-wrong-holders.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FEATURE_OFF = 'cargo clippy --lib -- -D warnings';
const GATED_PUBLIC = '#[cfg(feature = "wrong-holders")]\n#[derive(Debug, Clone, Copy, PartialEq, Eq)]\npub enum ViewQuirk {';
const PRIVATE = '#[cfg(not(feature = "wrong-holders"))]\n#[derive(Debug, Clone, Copy, PartialEq, Eq)]\n#[allow(dead_code)]\npub(crate) enum ViewQuirk {';

// Every feature the default set turns on, through other features too. A `[features]` entry is
// `name = [ "a", "b" ]`, on one line or several. `dep:x` names a dependency, and `x/y` turns on
// feature y of dependency x; only `rhizomatic/y` is a feature of this crate.
export function defaultFeatures(table) {
  const features = new Map();
  for (const m of table.matchAll(/^\s*"?([\w-]+)"?\s*=\s*\[([^\]]*)\]/gm))
    features.set(m[1], [...m[2].matchAll(/"([^"]*)"/g)].map(([, v]) => v));
  const on = new Set();
  const visit = (name) => {
    if (on.has(name)) return;
    on.add(name);
    for (const value of features.get(name) ?? []) {
      if (value.startsWith('dep:')) continue;
      const [crate, feature] = value.includes('/') ? value.split('/') : ['rhizomatic', value];
      if (crate.replace(/\?$/, '') === 'rhizomatic') visit(feature);
    }
  };
  visit('default');
  return on;
}

export function checkWrongHolders({ cargo, ci, precheck, views }) {
  const problems = [];
  const sections = Object.fromEntries(cargo.split(/^(?=\[)/m).map(s => [s.split('\n')[0].trim(), s]));
  if (!/^wrong-holders = \[\]$/m.test(sections['[features]'] ?? '')) problems.push('Cargo.toml must declare the feature `wrong-holders = []`');
  if (defaultFeatures(sections['[features]'] ?? '').has('wrong-holders')) problems.push('the feature wrong-holders must not be a default feature');
  for (const [name, body] of Object.entries(sections))
    if (name !== '[features]' && name !== '[dev-dependencies]' && body.includes('"wrong-holders"')) problems.push(`${name} turns on wrong-holders; only [dev-dependencies] may`);
  if (!/^rhizomatic = \{ path = "\.", features = \["wrong-holders"\] \}$/m.test(sections['[dev-dependencies]'] ?? '')) problems.push('the tests must turn wrong-holders on through a dev-dependency on the crate');
  if (!ci.includes(`run: ${FEATURE_OFF}`)) problems.push(`CI must run \`${FEATURE_OFF}\` with the feature off`);
  if (!precheck.includes('cargo clippy -q --lib -- -D warnings')) problems.push('precheck must run the feature-off clippy');
  if (!views.includes(GATED_PUBLIC) || !views.includes(PRIVATE) || views.match(/enum ViewQuirk\b|use [\w:]*ViewQuirk\b/g).length !== 2) problems.push('ViewQuirk must be pub only under the feature and pub(crate) without it');
  return problems;
}

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const live = {
  cargo: read('../implementations/rust/Cargo.toml'),
  ci: read('../.github/workflows/ci.yml'),
  precheck: read('./precheck.mjs'),
  views: read('../implementations/rust/src/store_views.rs'),
};

test('the Rust wrong holders are public only with the feature wrong-holders, which only the tests turn on', () => {
  assert.deepEqual(checkWrongHolders(live), []);
});

test('a default feature, a non-test dependency on it, an ungated ViewQuirk or a missing feature-off clippy is refused', () => {
  const broken = (key, from, to) => {
    assert.ok(live[key].includes(from), `the mutation of ${key} applies`);
    return checkWrongHolders({ ...live, [key]: live[key].replace(from, to) }).join('\n');
  };
  assert.match(broken('cargo', 'wrong-holders = []', 'wrong-holders = []\ndefault = ["wrong-holders"]'), /not be a default feature/);
  assert.match(broken('cargo', 'wrong-holders = []', 'wrong-holders = []\nrails = ["wrong-holders"]\ndefault = ["rails"]'), /not be a default feature/);
  assert.match(broken('cargo', 'wrong-holders = []', 'wrong-holders = []\ndefault = [\n  "wrong-holders",\n]'), /not be a default feature/);
  assert.match(broken('cargo', 'tempfile = "3"', 'tempfile = "3"\nrhizomatic = { path = ".", features = ["wrong-holders"] }'), /only \[dev-dependencies\] may/);
  assert.match(broken('cargo', 'features = ["wrong-holders"] }', '}'), /through a dev-dependency/);
  assert.match(broken('views', PRIVATE, PRIVATE.replace('pub(crate) enum', 'pub enum')), /pub only under the feature/);
  assert.match(broken('views', GATED_PUBLIC, GATED_PUBLIC.replace('#[cfg(feature = "wrong-holders")]\n', '')), /pub only under the feature/);
  assert.match(broken('views', '/// The sizes of', 'pub use self::ViewQuirk as Quirk;\n/// The sizes of'), /pub only under the feature/);
  assert.match(broken('ci', `run: ${FEATURE_OFF}`, 'run: true'), /CI must run/);
  assert.match(broken('precheck', 'cargo clippy -q --lib -- -D warnings', 'true'), /precheck must run/);
});
