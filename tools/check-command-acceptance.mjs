#!/usr/bin/env node
// Executed acceptance evidence. Independent review remains a separate explicit gate.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { processOutput } from './command-tower-process.mjs';
import { fingerprint } from './command-tower-plan.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => JSON.parse(readFileSync(file, 'utf8'));
const assert = (ok, message) => { if (!ok) throw Error(message); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

export function nativeScenarioEvidence({ scenarios, descriptions, ts, rust }) {
  assert(ts.success === true && ts.numFailedTests === 0 && ts.numPendingTests === 0 && ts.numTodoTests === 0, 'TS native run failed or skipped tests');
  const assertions = ts.testResults.flatMap(s => s.assertionResults);
  assert(assertions.length > 0 && assertions.every(t => t.status === 'passed'), 'TS native assertions not all passed');
  const titles = new Set(assertions.map(t => t.title));
  assert(/test result: ok\./.test(rust) && !/test result: FAILED/.test(rust) && !/\b[1-9]\d* ignored;/.test(rust), 'Rust native run failed or skipped tests');
  const markers = new Map();
  for (const match of rust.matchAll(/command-case:([^:\s]+):([^\r\n]+)/g)) {
    const [_, id, proof] = match;
    assert(scenarios.some(s => s.id === id), `unknown executed Rust scenario: ${id}`);
    if (!markers.has(id)) markers.set(id, new Set());
    markers.get(id).add(proof.trim());
  }
  const result = { ts: new Map(), rust: new Map() };
  for (const s of scenarios.filter(s => ['M1', 'M2', 'M3'].includes(s.milestone))) {
    if (s.milestone === 'M1') {
      const fixtures = descriptions.cases.filter(c => c.scenario === s.id);
      assert(fixtures.length > 0, `missing M1 fixture family: ${s.id}`);
      for (const c of fixtures) {
        assert(titles.has(`${s.id}:${c.id}`), `unexecuted TS fixture: ${c.id}`);
        assert(markers.get(s.id)?.has(c.id), `unexecuted Rust fixture: ${c.id}`);
      }
      result.ts.set(s.id, fixtures.map(c => `vitest:${s.id}:${c.id}`));
      result.rust.set(s.id, fixtures.map(c => `cargo:${s.id}:${c.id}`));
    } else {
      assert(titles.has(`${s.milestone}:${s.id}`), `unexecuted TS scenario: ${s.id}`);
      assert(markers.get(s.id)?.size > 0, `unexecuted Rust scenario: ${s.id}`);
      result.ts.set(s.id, [`vitest:${s.milestone}:${s.id}`]);
      result.rust.set(s.id, [...markers.get(s.id)].map(id => `cargo:${id}`));
    }
  }
  return result;
}
export function validateConformance(evidence, commit, tree) {
  assert(evidence?.format === 'rhizomatic-existing-conformance/1' && evidence.commit === commit, 'existing conformance needs exact source commit');
  assert(/^https:\/\/github\.com\/bombadil-labs\/rhizomatic\/actions\/runs\/\d+$/.test(evidence.runUrl), 'existing conformance needs actual CI run URL');
  assert(Array.isArray(evidence.witnesses) && evidence.witnesses.map(w => w.id).sort().join(',') === 'elixir,haskell,rust,ts', 'existing conformance needs all four unique witnesses');
  assert(evidence.witnesses.every(w => w.status === 'passed' && typeof w.job === 'string' && w.job.length), 'existing witness job not passed');
  // A PR merge-ref run may attest an identical source tree. The caller retains
  // the actual tested commit/tree alongside the exact source subject commit.
  if (evidence.testedCommit && evidence.testedCommit !== commit) assert(evidence.tree === tree && evidence.testedTree === tree, 'CI tested tree differs from source subject');
}
export function validateReview(review, commit) {
  assert(review?.format === 'rhizomatic-command-independent-review/1' && review.commit === commit && review.status === 'accepted', 'independent review does not accept exact source commit');
  assert(typeof review.reviewer === 'string' && review.reviewer.length && typeof review.report === 'string' && review.report.length, 'missing independent reviewer/report');
  assert(Array.isArray(review.scopes) && [...review.scopes].sort().join(',') === 'M0,M1,M2,M3,M4', 'independent review has incomplete or duplicated scope');
}
export function passedTapNames(output) {
  assert(/^# fail 0$/m.test(output) && /^# cancelled 0$/m.test(output) && /^# skipped 0$/m.test(output) && /^# todo 0$/m.test(output), 'Node gate failed or skipped tests');
  const names = [...output.matchAll(/^ok \d+ - (.+)$/gm)].map(m => m[1]);
  assert(names.length > 0 && names.every(n => !n.includes('# SKIP')), 'Node gate executed no complete tests');
  return new Set(names);
}
export function checkTowerEvidence(first, replay, commit) {
  for (const bundle of [first, replay]) {
    assert(bundle.status === 'passed' && bundle.buildMetadata?.commit === commit, 'tower run incomplete or stale');
    const { bundleHash, ...content } = bundle;
    assert(fingerprint(content) === bundleHash, 'tower evidence hash mismatch');
    assert(bundle.scenarios.length === 8 && bundle.peerComparisons.length === 1 && bundle.peerComparisons[0].status === 'passed', 'missing actual tower/peer scenarios');
    const paths = new Set();
    for (const scenario of bundle.scenarios) {
      assert(scenario.runs.length === 5 && scenario.plan.plans.length === 3 && scenario.fixedRoutes.length === 2, 'missing fixed or randomized route');
      for (const run of scenario.runs) {
        assert(run.status === 'passed' && run.stages.length > 0 && run.stages.every(s => s.status === 'passed'), 'unexecuted route/stage');
        const used = new Set(run.stages.map(s => s.input.value.context.storePath));
        assert(used.size === 1 && typeof [...used][0] === 'string' && !paths.has([...used][0]), 'tower durable state not isolated');
        paths.add([...used][0]);
      }
    }
  }
  assert(first.seed === replay.seed && fingerprint(first.builds) === fingerprint(replay.builds), 'replay changed seed or builds');
  assert(fingerprint(first.scenarios.map(s => s.plan)) === fingerprint(replay.scenarios.map(s => s.plan)), 'replay rerolled plans');
  const outputs = bundle => bundle.scenarios.map(s => s.runs.map(r => r.stages.map(p => p.output)));
  assert(fingerprint(outputs(first)) === fingerprint(outputs(replay)), 'actual replay changed output artifacts');
  const statePaths = bundle => new Set(bundle.scenarios.flatMap(s => s.runs.flatMap(r => r.stages.map(p => p.input.value.context.storePath))));
  const before = statePaths(first); assert([...statePaths(replay)].every(p => !before.has(p)), 'replay reused prior durable state');
}
export function assembleAcceptance({ scenarios, commit, tree, native, gates, towerTests, conformance, review }) {
  assert(scenarios.length === 78 && new Set(scenarios.map(s => s.id)).size === 78, 'acceptance requires exactly 78 unique frozen cases');
  validateConformance(conformance, commit, tree);
  if (review) validateReview(review, commit);
  const requirements = {
    bootstrap_inventory: ['bootstrap'], package_ownership: ['contracts', 'rust-boundaries', 'ts-boundaries'],
    profile_capabilities: ['contracts', 'execution', 'towers'], coverage_missing_case: ['contracts'],
    dependency_forbidden: ['ts-negatives', 'rust-negatives'], contract_missing_export: ['contracts', 'rust-negatives'],
    tower_port_inventory: ['contracts', 'tower-tests', 'execution'],
    mixed_ts_to_rust: ['transport', 'towers'], mixed_rust_to_ts: ['transport', 'towers'], different_peer_signers: ['towers'],
    existing_conformance: ['ts-native', 'rust-native'], ci_fault_execution: ['ts-native', 'rust-native'],
    tower_seeded_planning: ['tower-tests', 'towers'], tower_capability_refusal: ['tower-tests'], three_randomized_towers: ['towers'],
    tower_state_isolation: ['towers', 'replay', 'tower-tests'], tower_exact_replay: ['towers', 'replay', 'tower-tests'],
    tower_shared_wrong_answer: ['tower-tests'], tower_fault_localization: ['tower-tests'],
  };
  const names = {
    tower_seeded_planning: ['three deterministic, distinct mixed assignments, preserving the unsplit region'],
    tower_capability_refusal: ['unknown version, missing required port, and homogeneous fallback are refused'],
    tower_state_isolation: ['each route gets a fresh durable directory, preserved only across its own steps'],
    tower_exact_replay: ['recorded replay uses exact plans and retained inputs in fresh state'],
    tower_shared_wrong_answer: ['same wrong answer from both witnesses fails before parity can pass'],
    tower_fault_localization: ['stage crash retains its input and identifies the exact owner and port'],
  };
  const witnesses = ['ts', 'rust'].map(id => ({ id, scenarios: scenarios.map(s => {
    if (s.id === 'independent_boundary_review') return { id: s.id, status: review ? 'passed' : 'pending_review', evidence: review ? [review.report] : [] };
    const refs = native[id].get(s.id);
    if (refs) {
      assert(gates[`${id}-native`]?.status === 'passed', `missing native gate: ${id}`);
      const evidence = [{ gate: `${id}-native`, artifact: gates[`${id}-native`].artifact, tests: refs }];
      if (s.milestone === 'M1') for (const gate of ['oracle-sensitivity', 'transport']) { assert(gates[gate]?.status === 'passed', `missing M1 gate: ${gate}`); evidence.push({ gate, artifact: gates[gate].artifact, sha256: gates[gate].sha256 }); }
      return { id: s.id, status: 'passed', evidence };
    }
    assert(requirements[s.id], `unmapped acceptance case: ${s.id}`);
    for (const name of names[s.id] ?? []) assert(towerTests.has(name), `required boundary negative did not execute: ${name}`);
    const evidence = requirements[s.id].map(gate => { assert(gates[gate]?.status === 'passed', `missing executed gate: ${gate}`); return { gate, artifact: gates[gate].artifact, sha256: gates[gate].sha256 }; });
    if (s.id === 'existing_conformance' || s.id === 'ci_fault_execution') evidence.push({ conformance });
    return { id: s.id, status: 'passed', evidence };
  }) }));
  return { format: 'rhizomatic-command-acceptance-evidence/1', commit, tree, status: review ? 'passed' : 'pending_independent_review', witnesses, gates };
}

export async function runAcceptance({ out, conformanceFile, reviewFile, requireReview = false, seed = randomBytes(16).toString('hex'), repository = root }) {
  const git = async args => (await processOutput('git', args, { cwd: repository })).trim();
  assert(await git(['status', '--porcelain', '--untracked-files=normal']) === '', 'acceptance evidence requires clean committed source');
  const commit = await git(['rev-parse', 'HEAD']), tree = await git(['rev-parse', 'HEAD^{tree}']);
  const conformance = read(conformanceFile), review = reviewFile ? read(reviewFile) : undefined;
  validateConformance(conformance, commit, tree); if (review) validateReview(review, commit);
  assert(!requireReview || review, 'final acceptance requires independent review');
  assert(!resolve(out).startsWith(resolve(repository) + '/') && resolve(out) !== resolve(repository), 'acceptance artifacts must be outside source checkout');
  assert(!existsSync(out), 'acceptance output directory must be new'); mkdirSync(out, { recursive: true });
  const gates = {};
  async function gate(id, command, args, cwd = repository) {
    const artifact = join(out, id + '.log');
    try {
      const output = await processOutput(command, args, { cwd, timeout: 1200000 });
      writeFileSync(artifact, output); gates[id] = { status: 'passed', command, args, artifact, sha256: digest(output) }; json(join(out, 'gates.json'), gates); return output;
    } catch (error) { writeFileSync(artifact, String(error)); gates[id] = { status: 'failed', command, args, artifact }; json(join(out, 'gates.json'), gates); throw error; }
  }
  const node = (id, file, args = []) => gate(id, process.execPath, [join(repository, file), ...args]);
  const tsDir = join(repository, 'implementations/ts'), rustDir = join(repository, 'implementations/rust');
  const tsPath = join(out, 'vitest.json');
  await gate('ts-native', process.execPath, [join(tsDir, 'node_modules/vitest/vitest.mjs'), 'run', '--reporter=json', '--outputFile', tsPath], tsDir);
  const rust = await gate('rust-native', 'cargo', ['test', '--locked', '--all-targets', '--', '--nocapture', '--test-threads=1'], rustDir);
  const scenarios = read(join(repository, 'contracts/command/ACCEPTANCE.json')).scenarios;
  const native = nativeScenarioEvidence({ scenarios, descriptions: read(join(repository, 'vectors/command/descriptions.json')), ts: read(tsPath), rust });
  await node('contracts', 'tools/check-command-contracts.mjs', ['--self-test']);
  await node('ts-boundaries', 'tools/check-package-graph.mjs');
  await node('ts-negatives', 'tools/check-command-boundary-negatives.mjs');
  await node('rust-boundaries', 'tools/check-rust-command-boundaries.mjs');
  passedTapNames(await gate('rust-negatives', process.execPath, ['--test', '--test-reporter=tap', join(repository, 'tools/check-rust-command-boundaries.test.mjs')]));
  passedTapNames(await gate('bootstrap', process.execPath, ['--test', '--test-reporter=tap', join(repository, 'tools/check-command-bootstrap.test.mjs')]));
  await node('oracle-sensitivity', 'tools/check-command-oracle.mjs');
  await node('transport', 'tools/check-command-description-transport.mjs');
  const towerTests = passedTapNames(await gate('tower-tests', process.execPath, ['--test', '--test-reporter=tap', ...['plan', 'process'].map(n => join(repository, `tools/command-tower-${n}.test.mjs`)), join(repository, 'tools/command-towers.test.mjs')]));
  const stageEvidence = join(out, 'stage-evidence.json');
  await node('execution', 'tools/check-command-execution.mjs', ['--out', stageEvidence]);
  await node('towers', 'tools/command-towers.mjs', ['--evidence', stageEvidence, '--seed', seed, '--out', join(out, 'towers')]);
  await node('replay', 'tools/command-towers.mjs', ['--replay', join(out, 'towers/run.json'), '--out', join(out, 'replay')]);
  checkTowerEvidence(read(join(out, 'towers/run.json')), read(join(out, 'replay/run.json')), commit);
  assert(await git(['rev-parse', 'HEAD']) === commit && await git(['status', '--porcelain', '--untracked-files=normal']) === '', 'source changed during acceptance execution');
  const report = assembleAcceptance({ scenarios, commit, tree, native, gates, towerTests, conformance, review });
  report.seed = seed; report.nativeArtifacts = { vitest: { path: tsPath, sha256: digest(readFileSync(tsPath)) }, cargo: gates['rust-native'] };
  json(join(out, 'acceptance.json'), report); return report;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const value = name => { const index = process.argv.indexOf(name); if (index < 0) return undefined; assert(process.argv[index + 1] && !process.argv[index + 1].startsWith('--'), `missing ${name} value`); return process.argv[index + 1]; };
  const out = value('--out'), conformanceFile = value('--conformance');
  assert(out && conformanceFile, 'usage: --out NEW_DIRECTORY --conformance FILE [--review FILE] [--require-review] [--seed STRING]');
  const report = await runAcceptance({ out: resolve(out), conformanceFile: resolve(conformanceFile), reviewFile: value('--review'), requireReview: process.argv.includes('--require-review'), seed: value('--seed') });
  console.log(`Acceptance evidence: ${report.status}; ${report.witnesses[0].scenarios.filter(s => s.status === 'passed').length}/78 passed per witness. ${join(resolve(out), 'acceptance.json')}`);
}
