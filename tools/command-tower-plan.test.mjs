import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJson, fingerprint, planTowers, validateReplayPlan } from './command-tower-plan.mjs';

const stages = [
  { id: 'construct', contract: 'fixture/construct/1' },
  { id: 'validate', contract: 'fixture/validate/1', input_from: 'construct' },
  { id: 'execute', contract: 'fixture/execute/1', input_from: 'validate', unsplit_internal_region: true },
  { id: 'read-result', contract: 'fixture/read/1', input_from: 'execute' },
];
function witness(id, contracts = stages.map(s => s.contract)) {
  return { id, conformance_level: 4, state: 'supported', profiles: [], stages: contracts,
    buildId: `test-build-${id}`, stage_evidence: Object.fromEntries(contracts.map(c => [c, ['fixture-case']])) };
}
const caps = witnesses => ({ format: 'rhizomatic-command-capabilities/1', witnesses });
const capabilities = caps([witness('ts'), witness('rust'),
  { id: 'elixir', conformance_level: 0, state: 'not_implemented', profiles: [], stages: [] },
  { id: 'haskell', conformance_level: 0, state: 'not_implemented', profiles: [], stages: [] }]);
const input = { stages, capabilities, scenario: 'query_ephemeral', seed: 'fixed-seed' };
const builds = { ts: 'test-build-ts', rust: 'test-build-rust' };
const replay = (bundle, overrides = {}) => validateReplayPlan(bundle, { stages, capabilities, availableBuilds: builds, ...overrides });
const reseal = bundle => { const { planFingerprint, ...body } = bundle; return { ...body, planFingerprint: fingerprint(body) }; };

test('three deterministic, distinct mixed assignments, preserving the unsplit region', () => {
  const a = planTowers(input), b = planTowers(structuredClone(input));
  assert.deepEqual(a, b);
  assert.equal(a.plans.length, 3);
  assert.equal(a.distinctAssignments, 3);
  assert.ok(a.graph.find(n => n.id === 'execute').unsplit);
  for (const p of a.plans) {
    assert.ok(new Set(p.assignments.map(x => x.witness)).size > 1);
    assert.equal(p.repeatedFrom, null);
    assert.ok(p.assignments.every(x => ['ts', 'rust'].includes(x.witness)));
  }
  assert.deepEqual(replay(a), a);
});

test('seed fixture pins the versioned ranking rule independently of locale ordering', () => {
  // Expected assignment table is checked independently by the Python SHA-256
  // oracle recorded in the supervisor review; it is not obtained by calling the
  // planner a second time inside this assertion.
  const plan = planTowers(input);
  assert.deepEqual(plan.plans.map(p => p.assignments.map(a => a.witness)), [
    ['ts', 'ts', 'rust', 'ts'],
    ['ts', 'rust', 'rust', 'ts'],
    ['ts', 'rust', 'rust', 'rust'],
  ]);
});

test('canonical object ordering and SHA-256 tuple encoding have a literal oracle', () => {
  assert.equal(canonicalJson({ z: 1, a: ['x', true, null] }), '{"a":["x",true,null],"z":1}');
  assert.equal(fingerprint({ z: 1, a: ['x', true, null] }), createHash('sha256').update('{"a":["x",true,null],"z":1}').digest('hex'));
  assert.equal(fingerprint({ z: 1, a: ['x', true, null] }), fingerprint({ a: ['x', true, null], z: 1 }));
  for (const value of [NaN, Infinity, undefined, new Map(), new Date(), new Uint8Array([1])]) {
    assert.throws(() => canonicalJson(value));
  }
});

test('one eligible mixed assignment is explicitly repeated, with no invented capability', () => {
  const graph = [{ id: 'a', contract: 'a/1' }, { id: 'b', contract: 'b/1', input_from: 'a' }];
  const manifest = caps([witness('ts', ['a/1']), witness('rust', ['b/1'])]);
  const p = planTowers({ stages: graph, capabilities: manifest, scenario: 'only', seed: 'one' });
  assert.equal(p.distinctAssignments, 1);
  assert.deepEqual(p.plans.map(x => x.repeatedFrom), [null, 0, 0]);
  assert.deepEqual(validateReplayPlan(p, { stages: graph, capabilities: manifest, availableBuilds: builds }), p);
});

test('two eligible mixed assignments are both found, then repetition is explicit', () => {
  const graph = [{ id: 'a', contract: 'a/1' }, { id: 'b', contract: 'b/1', input_from: 'a' }];
  const p = planTowers({ stages: graph, capabilities: caps([witness('ts', ['a/1', 'b/1']), witness('rust', ['a/1', 'b/1'])]), scenario: 'two', seed: 'two' });
  assert.equal(p.distinctAssignments, 2);
  assert.deepEqual(p.plans.map(x => x.repeatedFrom), [null, null, 0]);
  assert.notDeepEqual(p.plans[0].assignments, p.plans[1].assignments);
});

test('branched graph remains a graph and every declared input port is assigned', () => {
  const graph = [{ id: 'a', contract: 'a/1' }, { id: 'b', contract: 'b/1' }, { id: 'c', contract: 'c/1', depends_on: ['b', 'a'] }];
  const p = planTowers({ stages: graph, capabilities: caps([witness('ts', ['a/1', 'b/1', 'c/1']), witness('rust', ['a/1', 'b/1', 'c/1'])]), scenario: 'dag', seed: 'dag' });
  assert.deepEqual(p.graph.find(n => n.id === 'c').dependencies, ['a', 'b']);
  assert.equal(p.distinctAssignments, 3);
});

test('higher conformance level and unverified declarations do not confer stage support', () => {
  const missing = caps([{ id: 'ts', conformance_level: 99, state: 'not_implemented', stages: [], profiles: [] }]);
  assert.throws(() => planTowers({ ...input, capabilities: missing }), /unsupported required stage/);
  const lying = structuredClone(capabilities); lying.witnesses[0].state = 'partial';
  assert.throws(() => planTowers({ ...input, capabilities: lying }), /unverified capability/);
  const absentEvidence = structuredClone(capabilities); absentEvidence.witnesses[0].stage_evidence['fixture/construct/1'] = [];
  assert.throws(() => planTowers({ ...input, capabilities: absentEvidence }), /missing executed stage cases/);
});

test('unknown version, missing required port, and homogeneous fallback are refused', () => {
  assert.throws(() => planTowers({ ...input, capabilities: caps([witness('ts')]) }), /no supported mixed-language/);
  const unknown = structuredClone(input); unknown.stages[2].contract = 'fixture/execute/2';
  assert.throws(() => planTowers(unknown), /unsupported required stage/);
  const noBuild = structuredClone(capabilities); delete noBuild.witnesses[0].buildId;
  assert.throws(() => planTowers({ ...input, capabilities: noBuild }), /missing pinned witness build/);
});

test('malformed graphs cannot silently omit stages or dependencies', () => {
  const cycle = structuredClone(stages); cycle[0].input_from = 'read-result';
  assert.throws(() => planTowers({ ...input, stages: cycle }), /cyclic/);
  const missing = structuredClone(stages); missing[2].input_from = 'absent';
  assert.throws(() => planTowers({ ...input, stages: missing }), /invalid stage dependency/);
  assert.throws(() => planTowers({ ...input, stages: [...stages, stages[0]] }), /duplicate stage/);
  assert.throws(() => planTowers({ ...input, stages: stages.map(({ input_from, ...rest }) => rest) }), /no portable edge/);
});

test('different seeds sample assignments without altering explicit input identity', () => {
  const plans = new Set();
  for (let n = 0; n < 12; n++) plans.add(canonicalJson(planTowers({ ...input, seed: `seed-${n}` }).plans));
  assert.ok(plans.size > 1);
});

test('replay requires retained capabilities and exact available builds', () => {
  const p = planTowers(input), changed = structuredClone(capabilities);
  changed.witnesses[0].buildId = 'new-build';
  assert.throws(() => replay(p, { capabilities: changed }), /capabilities changed/);
  assert.throws(() => replay(p, { availableBuilds: { ...builds, rust: 'new-build' } }), /pinned replay build unavailable/);
  assert.throws(() => replay(p, { availableBuilds: {} }), /pinned replay build unavailable/);
});

test('replay validates the recorded plan without reselecting from a seed', () => {
  const p = planTowers(input); p.seed = 'different seed, same retained concrete assignment';
  assert.deepEqual(replay(reseal(p)).plans, p.plans);
});

test('replay rejects tampering, missing stages and unknown fields even with a refreshed checksum', () => {
  const p = planTowers(input); p.plans[0].assignments.pop();
  assert.throws(() => replay(p), /fingerprint mismatch/);
  assert.throws(() => replay(reseal(p)), /missing replay stage/);
  const extra = planTowers(input); extra.hiddenNativeRegistry = {};
  assert.throws(() => replay(reseal(extra)), /invalid replay fields/);
  const unknown = planTowers(input); unknown.plans[0].assignments[0].witness = 'haskell';
  assert.throws(() => replay(reseal(unknown)), /ineligible replay capability/);
});

test('replay rejects an undeclared repeat and false distinct count', () => {
  const p = planTowers(input);
  p.plans[1].assignments = structuredClone(p.plans[0].assignments);
  assert.throws(() => replay(reseal(p)), /unreported repeated assignment/);
  const count = planTowers(input); count.distinctAssignments = 1;
  assert.throws(() => replay(reseal(count)), /incorrect distinct assignment count/);
});

test('small exhaustive oracle checks the planner finds up to three available mixed plans', () => {
  const graph = [{ id: 'a', contract: 'a/1' }, { id: 'b', contract: 'b/1', input_from: 'a' }, { id: 'c', contract: 'c/1', input_from: 'b' }];
  const ids = ['ts', 'rust'];
  for (let masks = 0; masks < 27; masks++) {
    let n = masks;
    const allowed = graph.map(() => { const m = n % 3 + 1; n = Math.floor(n / 3); return ids.filter((_, i) => m & (1 << i)); });
    const manifest = caps(ids.map(id => witness(id, graph.filter((_, i) => allowed[i].includes(id)).map(x => x.contract))));
    let mixed = 0;
    for (const a of allowed[0]) for (const b of allowed[1]) for (const c of allowed[2]) if (a !== b || b !== c) mixed++;
    const act = () => planTowers({ stages: graph, capabilities: manifest, scenario: 'small-oracle', seed: String(masks) });
    if (mixed === 0) assert.throws(act, /no supported mixed-language/);
    else assert.equal(act().distinctAssignments, Math.min(3, mixed));
  }
});
