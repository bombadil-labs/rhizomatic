import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requiredCheckerCases, requireCheckerCases, nativeScenarioEvidence, validateConformance, validateReview, passedTapNames, checkTowerEvidence, assembleAcceptance } from './check-command-acceptance.mjs';
import { fingerprint } from './command-tower-plan.mjs';
const commit = '1'.repeat(40), tree = '2'.repeat(40);
const conformance = { format: 'rhizomatic-existing-conformance/1', commit, runUrl: 'https://github.com/bombadil-labs/rhizomatic/actions/runs/123', witnesses: ['ts','rust','elixir','haskell'].map(id => ({ id, status: 'passed', job: id })) };
const review = { format: 'rhizomatic-command-independent-review/1', commit, status: 'accepted', reviewer: 'independent reviewer', report: 'review.md', scopes: ['M0','M1','M2','M3','M4'] };
const scenarios = JSON.parse(readFileSync(new URL('../contracts/command/ACCEPTANCE.json', import.meta.url))).scenarios;
const descriptions = JSON.parse(readFileSync(new URL('../vectors/command/descriptions.json', import.meta.url)));
function nativeInput() {
  const titles = descriptions.cases.map(c => `${c.scenario}:${c.id}`).concat(scenarios.filter(s => ['M2','M3'].includes(s.milestone)).map(s => `${s.milestone}:${s.id}`));
  return { scenarios, descriptions, ts: { success: true, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, testResults: [{ assertionResults: titles.map(title => ({ title, status: 'passed' })) }] }, rust: 'test result: ok. 1 passed; 0 failed; 0 ignored;\n' + descriptions.cases.map(c => `command-case:${c.scenario}:${c.id}\n`).join('') + scenarios.filter(s => ['M2','M3'].includes(s.milestone)).map(s => `command-case:${s.id}:group::${s.id}\n`).join('') };
}
test('native evidence requires every executed fixture and scenario in both witnesses', () => {
  const input = nativeInput(), evidence = nativeScenarioEvidence(input);
  assert.equal(evidence.ts.size, 58); assert.equal(evidence.rust.size, 58);
  for (const mutate of [
    v => { v.ts.testResults[0].assertionResults.pop(); },
    v => { v.ts.testResults[0].assertionResults[0].status = 'skipped'; },
    v => { v.ts.numTodoTests = 1; }, v => { v.ts.success = false; },
    v => { v.rust = v.rust.replace(/command-case:[^\n]+\n/, ''); },
    v => { v.rust += 'command-case:invented:proof\n'; },
    v => { v.rust = v.rust.replace(/command-case:definition_closure:[^\n]+/, 'command-case:definition_closure: '); },
    v => { v.rust = v.rust.replace('0 ignored', '1 ignored'); },
  ]) { const altered = structuredClone(input); mutate(altered); assert.throws(() => nativeScenarioEvidence(altered)); }
});
test('existing CI and independent review must cover exact source and complete scope', () => {
  validateConformance(conformance, commit, tree); validateReview(review, commit);
  for (const mutate of [v => { v.commit = 'stale'; }, v => v.witnesses.pop(), v => { v.witnesses[1] = v.witnesses[0]; }, v => { v.witnesses[0].status = 'skipped'; }, v => { v.runUrl = 'invented'; }, v => { v.testedCommit = 'merge'; v.tree = tree; v.testedTree = 'other'; }]) {
    const v = structuredClone(conformance); mutate(v); assert.throws(() => validateConformance(v, commit, tree));
  }
  validateConformance({ ...conformance, testedCommit: 'merge', tree, testedTree: tree }, commit, tree);
  for (const mutate of [v => { v.commit = 'stale'; }, v => { v.status = 'pending'; }, v => v.scopes.pop(), v => { v.report = ''; }]) {
    const v = structuredClone(review); mutate(v); assert.throws(() => validateReview(v, commit));
  }
});
test('Node evidence refuses empty, skipped, cancelled and failed test runs', () => {
  const tap = 'ok 1 - actual check\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  assert(passedTapNames(tap).has('actual check'));
  for (const bad of [tap.replace('ok 1 - actual check', ''), tap.replace('# skipped 0', '# skipped 1'), tap.replace('# cancelled 0', '# cancelled 1'), tap.replace('# fail 0', '# fail 1')]) assert.throws(() => passedTapNames(bad));
});
function tower(prefix) {
  const bundle = { status: 'passed', buildMetadata: { commit }, builds: { ts: 'a', rust: 'b' }, seed: 'seed', peerComparisons: [{ status: 'passed' }], scenarios: Array.from({ length: 8 }, (_, i) => ({ plan: { plans: [1,2,3] }, fixedRoutes: [1,2], runs: Array.from({ length: 5 }, (_, r) => ({ status: 'passed', stages: [{ status: 'passed', input: { value: { context: { storePath: `${prefix}/${i}/${r}` } } }, output: { value: i } }] })) })) };
  return { ...bundle, bundleHash: fingerprint(bundle) };
}
const rehash = bundle => { const { bundleHash, ...value } = bundle; bundle.bundleHash = fingerprint(value); return bundle; };
test('actual tower evidence requires complete routes, isolated state and identical exact replay outputs', () => {
  const first = tower('first'), replay = tower('replay'); checkTowerEvidence(first, replay, commit);
  for (const mutate of [
    v => v.scenarios.pop(), v => v.scenarios[0].runs.pop(),
    v => { v.scenarios[0].runs[0].stages[0].status = 'failed'; },
    v => { v.scenarios[0].runs[0].stages[0].input.value.context.storePath = 'replay/1/0'; },
    v => { v.scenarios[0].runs[0].stages[0].output.value = 'wrong'; },
    v => { v.scenarios[0].plan.plans = [3,2,1]; },
    v => { v.seed = 'rerolled'; }, v => { v.buildMetadata.commit = 'stale'; },
  ]) { const changed = structuredClone(replay); mutate(changed); assert.throws(() => checkTowerEvidence(first, rehash(changed), commit)); }
  assert.throws(() => checkTowerEvidence(first, first, commit));
});
function aggregateInput() {
  const gateIds = ['ts-inventory','bootstrap','contracts','rust-boundaries','ts-boundaries','execution','towers','ts-negatives','rust-negatives','tower-tests','transport','ts-native','rust-native','replay','oracle-sensitivity'];
  const gates = Object.fromEntries(gateIds.map(id => [id, { status: 'passed', artifact: `${id}.log`, sha256: 'proof' }]));
  const towerTests = new Set(['three deterministic, distinct mixed assignments, preserving the unsplit region','unknown version, missing required port, and homogeneous fallback are refused','each route gets a fresh durable directory, preserved only across its own steps','recorded replay uses exact plans and retained inputs in fresh state','same wrong answer from both witnesses fails before parity can pass','stage crash retains its input and identifies the exact owner and port']);
  return { scenarios, commit, tree, native: nativeScenarioEvidence(nativeInput()), gates, towerTests, conformance };
}
test('all 78 case identities are retained and manual review is never inferred from green tests', () => {
  const input = aggregateInput(), pending = assembleAcceptance(input);
  assert.equal(pending.status, 'pending_independent_review');
  assert.equal(pending.witnesses[0].scenarios.filter(s => s.status === 'passed').length, 77);
  assert.equal(assembleAcceptance({ ...input, review }).status, 'passed');
  assert.throws(() => assembleAcceptance({ ...input, scenarios: scenarios.slice(1) }));
  for (const gate of Object.keys(input.gates)) { const gates = structuredClone(input.gates); delete gates[gate]; assert.throws(() => assembleAcceptance({ ...input, gates }), gate); }
  assert.throws(() => assembleAcceptance({ ...input, towerTests: new Set() }));
});

test('each M0 checker requires its named executed regressions, not an unrelated passing TAP run', () => {
  for (const [gate, names] of Object.entries(requiredCheckerCases)) {
    requireCheckerCases(gate, new Set(names));
    assert.throws(() => requireCheckerCases(gate, new Set(['unrelated positive'])), /unexecuted/);
    for (const name of names) { const missing = new Set(names); missing.delete(name); assert.throws(() => requireCheckerCases(gate, missing), /unexecuted/); }
  }
});
