import test from 'node:test';
import assert from 'node:assert/strict';
import { bindStageEvidence, processOutput } from './command-tower-process.mjs';

function inputs() {
  return {
    commit: 'exact-head', builds: { ts: 'actual-ts-build', rust: 'actual-rust-build' },
    fixtures: { cases: [{ id: 'fixture', scenario: 'scenario', tower: true }] },
    spec: { required_scenarios: ['scenario'], stages: [{ id: 'construct', contract: 'construct/1' }] },
    capabilities: { witnesses: ['ts', 'rust'].map(id => ({ id, state: 'supported', stages: ['construct/1'] })) },
    report: { format: 'rhizomatic-command-stage-evidence/1', commit: 'exact-head', witnesses: ['ts', 'rust'].map(id => ({
      id, stages: { 'construct/1': [{ id: 'fixture/command/construct', status: 'passed' }] },
    })) },
  };
}

test('binds exact executed stage identities to independently measured build IDs', () => {
  const input = inputs(), before = structuredClone(input.capabilities), actual = bindStageEvidence(input);
  assert.deepEqual(input.capabilities, before);
  assert.equal(actual.witnesses[0].buildId, 'actual-ts-build');
  assert.deepEqual(actual.witnesses[1].stage_evidence, { 'construct/1': ['fixture/command/construct'] });
});

test('stale head, skipped case, renamed case, duplicate case and missing stage fail closed', () => {
  const changes = [
    input => { input.report.commit = 'stale-head'; },
    input => { input.report.witnesses[0].stages['construct/1'][0].status = 'skipped'; },
    input => { input.report.witnesses[0].stages['construct/1'][0].id = 'invented'; },
    input => { input.report.witnesses[0].stages['construct/1'].push({ id: 'fixture/command/construct', status: 'passed' }); },
    input => { delete input.report.witnesses[0].stages['construct/1']; },
    input => { input.report.witnesses.push(input.report.witnesses[0]); },
    input => { input.capabilities.witnesses[0].state = 'not_implemented'; },
    input => { delete input.builds.ts; },
    input => { input.report.witnesses[0].stages['unrecognized/1'] = []; },
  ];
  for (const change of changes) { const input = inputs(); change(input); assert.throws(() => bindStageEvidence(input)); }
});

test('named multi-step cases each require their own executed evidence', () => {
  const input = inputs(); input.fixtures.cases[0].steps = [{ id: 'retain' }, { id: 'query' }];
  assert.throws(() => bindStageEvidence(input), /identity mismatch/);
  for (const w of input.report.witnesses) w.stages['construct/1'] = ['retain', 'query'].map(step => ({ id: `fixture/${step}/construct`, status: 'passed' }));
  assert.equal(bindStageEvidence(input).witnesses[0].stage_evidence['construct/1'].length, 2);
});

test('real process framing preserves stdin, isolates diagnostics and rejects crashes', async () => {
  assert.equal(await processOutput(process.execPath, ['-e', "process.stdin.pipe(process.stdout); process.stderr.write('diagnostic');"], { input: '{"literal":"$(no shell)"}\n' }), '{"literal":"$(no shell)"}\n');
  await assert.rejects(processOutput(process.execPath, ['-e', "process.stderr.write('specific fault'); process.exit(3);"], { input: '' }), /exited 3: specific fault/);
  await assert.rejects(processOutput('rhizomatic-deliberately-nonexistent-executable', [], { input: '' }), /ENOENT/);
});

test('hung adapter is terminated with an explicit timeout', async () => {
  await assert.rejects(processOutput(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 100, input: '' }), /process timeout/);
});
