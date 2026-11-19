// Every CI job that installs Rust asks for one exact version. A moving name such as `stable`
// resolves when each job starts. The M4 job compares the hash of a Rust binary with the hash an
// earlier job of the same run made, so a Rust release between two jobs fails M4 with no source
// change (issue #122). To move to a new Rust, change every job in one commit.
//   node --test tools/check-ci-rust-toolchain.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const HOW = 'Write `uses: dtolnay/rust-toolchain@<major>.<minor>.<patch>` with the same version in every job. See issue #122.';

export function checkRustToolchain(workflow) {
  const problems = [];
  const lines = workflow.split('\n');
  const versions = new Set();
  lines.forEach((line, i) => {
    const at = `line ${i + 1}`;
    const use = line.match(/^\s*(?:-\s+)?uses:\s*dtolnay\/rust-toolchain@(\S+)/);
    if (use) {
      if (/^\d+\.\d+\.\d+$/.test(use[1])) versions.add(use[1]);
      else problems.push(`${at} installs Rust \`${use[1]}\`, which is not an exact version`);
      // An input of the action replaces the version in its name.
      const inputs = [];
      for (let j = i + 1; j < lines.length && !/^\s*-\s/.test(lines[j]) && /^\s+\S/.test(lines[j]); j++) inputs.push(lines[j]);
      if (inputs.some(l => /^\s*toolchain:/.test(l))) problems.push(`${at} passes a \`toolchain\` input, which replaces the version in the action name`);
    }
    if (/\brustup\s+(update|default|toolchain\s+install|install)\b/.test(line)) problems.push(`${at} changes the Rust toolchain with rustup`);
  });
  if (versions.size > 1) problems.push(`the jobs install different Rust versions: ${[...versions].sort().join(', ')}`);
  return { versions: [...versions], problems: problems.map(p => p + '. ' + HOW) };
}

const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');

test('every CI job that installs Rust asks for the same exact version', () => {
  const { versions, problems } = checkRustToolchain(ci);
  assert.deepEqual(problems, []);
  assert.equal(versions.length, 1, 'the scan reads the real installs');
  assert.ok(ci.match(/dtolnay\/rust-toolchain@/g).length >= 7, 'the scan reads the real installs');
});

test('a moving name, a second version, a toolchain input or a rustup install is refused with the reason', () => {
  const [pin] = checkRustToolchain(ci).versions;
  const use = `uses: dtolnay/rust-toolchain@${pin}`;
  assert.match(checkRustToolchain(ci.replace(use, 'uses: dtolnay/rust-toolchain@stable')).problems.join('\n'), /installs Rust `stable`.*issue #122/);
  assert.match(checkRustToolchain(ci.replace(use, 'uses: dtolnay/rust-toolchain@1.0.0')).problems.join('\n'), /different Rust versions: 1\.0\.0, /);
  assert.match(checkRustToolchain(ci.replace(use, use + '\n        with:\n          toolchain: stable')).problems.join('\n'), /passes a `toolchain` input/);
  assert.match(checkRustToolchain(ci.replace('rustup target add', 'rustup update stable && rustup target add')).problems.join('\n'), /changes the Rust toolchain with rustup/);
});
