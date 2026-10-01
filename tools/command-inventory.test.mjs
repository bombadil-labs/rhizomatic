import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('public type aliases expose base and every variant member to inventory freshness', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'command-alias-inventory-'));
  try {
    mkdirSync(join(scratch, 'tools'));
    cpSync(join(root, 'tools/command-inventory.mjs'), join(scratch, 'tools/command-inventory.mjs'));
    cpSync(join(root, 'contracts/command'), join(scratch, 'contracts/command'), { recursive: true });
    cpSync(join(root, 'implementations/ts/src'), join(scratch, 'implementations/ts/src'), { recursive: true });
    cpSync(join(root, 'implementations/ts/package.json'), join(scratch, 'implementations/ts/package.json'));
    symlinkSync(join(root, 'implementations/ts/node_modules'), join(scratch, 'implementations/ts/node_modules'), 'dir');
    const run = () => spawnSync(process.execPath, [join(scratch, 'tools/command-inventory.mjs')], { encoding: 'utf8' });
    assert.equal(run().status, 0, 'unchanged disposable checkout must pass');
    const path = join(scratch, 'implementations/ts/src/command/endpoint.ts');
    const original = readFileSync(path, 'utf8');
    for (const mutated of [
      original.replace('interface CommandBootInputs {', 'interface CommandBootInputs { readonly undeclaredHost?: () => void;'),
      original.replace('{ readonly seed: string; readonly signer?: never }', '{ readonly undeclaredHost?: () => void; readonly seed: string; readonly signer?: never }'),
    ]) {
      assert.notEqual(mutated, original, 'source mutation must apply');
      writeFileSync(path, mutated);
      const result = run();
      assert.notEqual(result.status, 0, 'new public alias member must fail unchanged inventory');
      assert.match(result.stderr, /unclassified public export: ts:command\/endpoint.ts:CommandBoot#undeclaredHost/);
    }
    writeFileSync(path, original);
    assert.equal(run().status, 0, 'restored disposable checkout must pass');
    const inventory = JSON.parse(readFileSync(join(root, 'contracts/command/ts-exports.json'), 'utf8')).exports;
    for (const member of ['configuration', 'declarations', 'store', 'clock', 'diagnostic', 'seed', 'signer']) {
      assert.ok(inventory.some(e => e.id === `ts:command/endpoint.ts:CommandBoot#${member}`));
      assert.ok(inventory.some(e => e.id === `ts:index.ts:CommandBoot#${member}`));
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
