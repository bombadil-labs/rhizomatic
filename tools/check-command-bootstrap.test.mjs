import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nativeBootstrap, validateBootstrap } from './check-command-bootstrap.mjs';
const read = file => JSON.parse(readFileSync(new URL(file, import.meta.url)));
const manifest = read('../contracts/command/bootstrap.json');
const vectors = read('../vectors/l1-eval/schema-deltas.json');
test('actual exported bootstrap programs match declared and shared byte/pin contracts', async () => {
  const native = await nativeBootstrap();
  validateBootstrap(manifest, vectors, native);
  for (const name of ['HyperSchemaSchema', 'SchemaSchema']) {
    const wrongPin = structuredClone(manifest);
    wrongPin.canonical_pins[name] = '1e20' + '00'.repeat(32);
    assert.throws(() => validateBootstrap(wrongPin, vectors, native), /pin disagrees/);
    for (const witness of ['ts', 'rust']) for (const field of ['name', 'alg', 'canonicalCborHex', 'termHash']) {
      const wrongNative = structuredClone(native);
      wrongNative[witness][name][field] = field === 'alg' ? 2 : 'changed';
      assert.throws(() => validateBootstrap(manifest, vectors, wrongNative), /native bootstrap mismatch/);
    }
  }
  assert.throws(() => validateBootstrap(manifest, vectors, { ts: native.ts }), /both native witnesses/);
});
