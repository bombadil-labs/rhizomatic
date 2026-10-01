import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { runTowerSuite, validateRunBundle } from './command-towers.mjs';
import { fingerprint } from './command-tower-plan.mjs';

// Deliberately tiny fake semantic records test the harness, never the profile.
const artifact = { format: 'test-artifact', entryId: 'request', deltas: ['signed input'] };
const outcome = { id: 'signed-output', claims: { value: 42 }, sig: 'signature' };
const result = { status: 'completed', bodyHex: 'test-body', valueHex: 'test-value' };
const observed = { head: 'fixed-head', ids: ['payload'], arrivals: [10], quotaUsed: 1 };
const spec = { required_scenarios: ['query_ephemeral'], stages: [
  { id: 'construct', contract: 'test/construct', owners: ['command-data'] },
  { id: 'validate', contract: 'test/validate', input_from: 'construct', owners: ['command-data'] },
  { id: 'execute', contract: 'test/execute', input_from: 'validate', owners: ['command'], unsplit_internal_region: true },
  { id: 'read-result', contract: 'test/read', input_from: 'execute', owners: ['command'] },
] };
const builds = { ts: 'build-ts', rust: 'build-rust' };
const capabilities = { format: 'rhizomatic-command-capabilities/1', witnesses: ['ts', 'rust'].map(id => ({
  id, buildId: builds[id], state: 'supported', profiles: [], stages: spec.stages.map(s => s.contract),
  stage_evidence: Object.fromEntries(spec.stages.map(s => [s.contract, ['test-only-evidence']])),
})) };
const expected = { oracle: 'Tiny fixed harness-only oracle: 42 and one retained payload.', artifact, result, observed, outcome };
const context = { initialDeltas: [], receivedAt: 10, construction: { request: { claims: { pointers: [] } }, support: [] } };
const fixtures = { format: 'rhizomatic-command-execution-vectors/1', cases: [{
  id: 'fixture-one', scenario: 'query_ephemeral', tower: true, context, expected,
}] };
function environment(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rhizomatic-harness-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { fixtures: structuredClone(fixtures), spec: structuredClone(spec), capabilities: structuredClone(capabilities),
    builds: structuredClone(builds), buildMetadata: { purpose: 'harness test, no conformance claim' }, seed: 'test-seed', outDir: join(dir, 'first'), adapter: fakeAdapter };
}
function fakeAdapter(witness, input) {
  switch (input.mode) {
    case 'construct': return { artifact: structuredClone(artifact) };
    case 'validate': return { artifact: input.artifact, verdict: { valid: true } };
    case 'execute': return { outcome: structuredClone(outcome), observed: structuredClone(observed) };
    case 'read-result': return structuredClone(result);
    default: throw Error('unknown stage');
  }
}
const load = options => JSON.parse(readFileSync(join(options.outDir, 'run.json'), 'utf8'));

test('executes two fixed routes and three planned routes against fixed oracles', async t => {
  const options = environment(t), seen = [];
  options.adapter = (w, input, position) => { seen.push({ w, input, position }); return fakeAdapter(w, input); };
  const bundle = await runTowerSuite(options);
  assert.equal(bundle.status, 'passed');
  assert.equal(seen.length, 20);
  assert.deepEqual(seen.slice(0, 4).map(x => x.w), ['ts', 'rust', 'rust', 'ts']);
  assert.deepEqual(seen.slice(4, 8).map(x => x.w), ['rust', 'ts', 'ts', 'rust']);
  assert.equal(bundle.scenarios[0].runs.length, 5);
  assert.equal(bundle.scenarios[0].edges.length, 15);
  assert.ok(bundle.scenarios[0].plan.graph.find(n => n.id === 'execute').unsplit);
  assert.deepEqual(validateRunBundle(bundle, builds).fixtures, fixtures);
});

test('same wrong answer from both witnesses fails before parity can pass', async t => {
  const options = environment(t);
  options.adapter = (w, input) => input.mode === 'read-result' ? { ...result, valueHex: 'shared-wrong-answer' } : fakeAdapter(w, input);
  await assert.rejects(runTowerSuite(options), /complete readback oracle/);
  const bundle = load(options);
  assert.equal(bundle.status, 'failed');
  assert.equal(bundle.failure.stage, 'read-result');
  assert.equal(bundle.failure.witness, 'ts');
  assert.deepEqual(bundle.failure.owners, ['command']);
  assert.equal(bundle.scenarios[0].runs[0].stages.at(-1).output.value.valueHex, 'shared-wrong-answer');
});

test('stage crash retains its input and identifies the exact owner and port', async t => {
  const options = environment(t);
  options.adapter = (w, input) => { if (input.mode === 'execute') throw Error('injected adapter crash'); return fakeAdapter(w, input); };
  await assert.rejects(runTowerSuite(options), /injected adapter crash[\s\S]*Replay:/);
  const bundle = load(options), record = bundle.scenarios[0].runs[0].stages.at(-1);
  assert.equal(record.input.value.mode, 'execute');
  assert.equal(record.output, undefined);
  assert.equal(bundle.failure.contract, 'test/execute');
  assert.equal(bundle.failure.witness, 'rust');
  validateRunBundle(bundle, builds);
});

test('each route gets a fresh durable directory, preserved only across its own steps', async t => {
  const options = environment(t), directories = [];
  options.adapter = (w, input) => {
    if (input.mode === 'execute') {
      const marker = join(dirname(input.context.storePath), 'written');
      assert.equal(existsSync(input.context.storePath), false, 'adapter receives a fresh journal file path');
      assert.equal(existsSync(marker), false);
      writeFileSync(marker, w); directories.push(input.context.storePath);
    }
    return fakeAdapter(w, input);
  };
  await runTowerSuite(options);
  assert.equal(new Set(directories).size, 5);
  await assert.rejects(runTowerSuite(options), /output directory already exists/);
});

test('recorded replay uses exact plans and retained inputs in fresh state', async t => {
  const options = environment(t), first = await runTowerSuite(options);
  const next = { ...options, seed: 'must not reroll', outDir: options.outDir + '-replay', replayBundle: first };
  const second = await runTowerSuite(next);
  assert.deepEqual(second.scenarios[0].plan, first.scenarios[0].plan);
  assert.notEqual(second.scenarios[0].runs[0].stages[0].input.value.context.storePath, first.scenarios[0].runs[0].stages[0].input.value.context.storePath);
  assert.deepEqual(second.scenarios[0].runs[0].stages.at(-1).output, first.scenarios[0].runs[0].stages.at(-1).output);
});

test('replay refuses unavailable builds, changed fixtures and corrupted artifacts', async t => {
  const options = environment(t), bundle = await runTowerSuite(options);
  assert.throws(() => validateRunBundle(bundle, { ...builds, rust: 'new-rust' }), /pinned replay build unavailable/);
  const changed = structuredClone(options.fixtures); changed.cases[0].context.receivedAt++;
  await assert.rejects(runTowerSuite({ ...options, fixtures: changed, replayBundle: bundle, outDir: options.outDir + '-changed' }), /replay retained inputs/);
  bundle.scenarios[0].runs[0].stages[0].input.value.context.receivedAt++;
  assert.throws(() => validateRunBundle(bundle, builds), /run bundle hash mismatch/);
  const { bundleHash, ...body } = bundle; bundle.bundleHash = fingerprint(body);
  assert.throws(() => validateRunBundle(bundle, builds), /retained stage input hash mismatch/);
});

test('validator cannot alter the serialized request or silently skip execution', async t => {
  const options = environment(t);
  options.adapter = (w, input) => input.mode === 'validate' ? { artifact: { ...artifact, entryId: 'changed' }, verdict: { valid: true } } : fakeAdapter(w, input);
  await assert.rejects(runTowerSuite(options), /validator changed serialized artifact/);
  const refused = { ...options, outDir: options.outDir + '-refused', adapter: (w, input) => input.mode === 'validate' ? { artifact, verdict: { valid: false } } : fakeAdapter(w, input) };
  await assert.rejects(runTowerSuite(refused), /validator refused/);
});

test('durable state is checked even when the semantic result matches', async t => {
  const options = environment(t);
  options.adapter = (w, input) => input.mode === 'execute' ? { outcome, observed: { ...observed, ids: [] } } : fakeAdapter(w, input);
  await assert.rejects(runTowerSuite(options), /durable state oracle/);
});

test('requires exactly one declared fixture and complete independent oracle per scenario', async t => {
  const options = environment(t); options.fixtures.cases[0].tower = false;
  await assert.rejects(runTowerSuite(options), /expected one explicit tower fixture/);
  options.fixtures.cases[0].tower = true; delete options.fixtures.cases[0].expected.result;
  await assert.rejects(runTowerSuite(options), /incomplete artifact\/result\/state\/outcome oracle/);
});

test('shared executor/reader error cannot hide incorrect signed outcome bytes', async t => {
  const options = environment(t);
  options.adapter = (w, input) => input.mode === 'execute' ? { outcome: { arbitrary: 'unsigned wrong bytes' }, observed } : fakeAdapter(w, input);
  await assert.rejects(runTowerSuite(options), /signed outcome oracle/);
  const missing = environment(t); delete missing.fixtures.cases[0].expected.outcome;
  await assert.rejects(runTowerSuite(missing), /incomplete.*outcome oracle/);
});

test('runner refuses a changed DAG rather than misapplying topological assignments', async t => {
  const options = environment(t); options.spec.stages[2].input_from = 'construct';
  await assert.rejects(runTowerSuite(options), /explicit initial chain/);
});

test('signed head binding uses only a named earlier verified observation', async t => {
  const options = environment(t), first = structuredClone(context), second = structuredClone(context), seen = [];
  second.construction.request.claims.pointers = [{ role: 'rhizomatic.command.expected-head', target: 'placeholder' }];
  second.construction.bind = [{ role: 'rhizomatic.command.expected-head', observation: { step: 'retain', field: 'head' } }];
  options.fixtures.cases[0].steps = [{ id: 'retain', context: first, expected }, { id: 'query', context: second, expected }];
  options.adapter = (w, input, position) => {
    if (input.mode === 'construct' && position.step === 1) seen.push(input.context.construction.request.claims.pointers[0].target);
    return fakeAdapter(w, input);
  };
  await runTowerSuite(options);
  assert.deepEqual(seen, Array(5).fill('fixed-head'));
  second.construction.bind[0].observation.step = 'future';
  await assert.rejects(runTowerSuite({ ...options, outDir: options.outDir + '-future' }), /prior observed head/);
});

test('failure in first scenario retains plans for later scenarios for exact replay', async t => {
  const options = environment(t);
  options.spec.required_scenarios.push('later');
  options.fixtures.cases.push({ ...structuredClone(options.fixtures.cases[0]), id: 'fixture-two', scenario: 'later' });
  options.adapter = () => { throw Error('early'); };
  await assert.rejects(runTowerSuite(options), /early/);
  const bundle = load(options);
  assert.equal(bundle.scenarios.length, 2);
  validateRunBundle(bundle, builds);
  const replay = await runTowerSuite({ ...options, adapter: fakeAdapter, replayBundle: bundle, outDir: options.outDir + '-retry' });
  assert.equal(replay.status, 'passed');
  assert.deepEqual(replay.scenarios.map(s => s.plan), bundle.scenarios.map(s => s.plan));
});

function peerOptions(options) {
  options.spec.required_peer_comparisons = ['same-value-different-receiver'];
  for (const receiver of ['peer-a', 'peer-b']) {
    const fixture = structuredClone(fixtures.cases[0]);
    fixture.id = receiver; fixture.scenario = 'different_peer_signers'; fixture.tower = false;
    fixture.peerComparison = 'same-value-different-receiver';
    fixture.context.boot = { configuration: { claims: { author: receiver } } };
    fixture.expected.outcome.claims.author = receiver;
    fixture.expected.result.valueHex = '182a';
    options.fixtures.cases.push(fixture);
  }
  options.adapter = (w, input) => {
    const output = fakeAdapter(w, input);
    if (input.scenario === 'different_peer_signers') {
      if (input.mode === 'execute') output.outcome.claims.author = input.context.boot.configuration.claims.author;
      if (input.mode === 'read-result') output.valueHex = '182a';
    }
    return output;
  };
  return options;
}

test('different signing peers compare validated semantic values, preserving distinct outcome oracles', async t => {
  const options = peerOptions(environment(t));
  const bundle = await runTowerSuite(options);
  assert.equal(bundle.scenarios.length, 3);
  assert.equal(bundle.peerComparisons.length, 1);
  assert.deepEqual(bundle.peerComparisons[0].peers.map(p => p.receiver), ['peer-a', 'peer-b']);
  assert.ok(bundle.peerComparisons[0].peers.every(p => p.valueHex === '182a'));
  validateRunBundle(bundle, builds);
});

test('peer comparison refuses missing variants and falsely identical peer identity', async t => {
  const missing = peerOptions(environment(t)); missing.fixtures.cases.pop();
  await assert.rejects(runTowerSuite(missing), /expected two attributed peer fixtures/);
  const same = peerOptions(environment(t));
  const second = same.fixtures.cases.at(-1);
  second.context.boot.configuration.claims.author = 'peer-a'; second.expected.outcome.claims.author = 'peer-a';
  await assert.rejects(runTowerSuite(same), /requires distinct signing peers/);
});

test('different-peer semantic disagreement fails even when each separate oracle passes', async t => {
  const options = peerOptions(environment(t)), base = options.adapter;
  options.fixtures.cases.at(-1).expected.result.valueHex = '182b';
  options.adapter = (w, input) => {
    const output = base(w, input);
    if (input.mode === 'read-result' && input.context.boot?.configuration.claims.author === 'peer-b') output.valueHex = '182b';
    return output;
  };
  await assert.rejects(runTowerSuite(options), /different-peer semantic value/);
});
