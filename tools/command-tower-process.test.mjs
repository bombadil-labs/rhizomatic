import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bindStageEvidence, processOutput, rustExecutableFromMessages } from './command-tower-process.mjs';

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

test('split UTF-8 pipe chunks preserve signed debug strings and diagnostics', async () => {
  const code = "process.stdout.write(Buffer.from([123,34,110,97,109,101,34,58,34,206])); setTimeout(() => process.stdout.write(Buffer.from([187,34,125])), 40);";
  assert.equal(await processOutput(process.execPath, ['-e', code], { input: '' }), '{"name":"λ"}');
  const failure = "process.stderr.write(Buffer.from([206])); setTimeout(() => { process.stderr.write(Buffer.from([187])); process.exitCode=1; }, 40);";
  await assert.rejects(processOutput(process.execPath, ['-e', failure], { input: '' }), /exited 1: λ/);
});

test('timeout terminates descendants before they can write durable state', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tower-process-group-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pid = join(dir, 'pid'), marker = join(dir, 'late-write');
  const worker = `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(pid)},String(process.pid)); setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'late'),1400);`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:'inherit'});`;
  await assert.rejects(processOutput(process.execPath, ['-e', parent], { timeout: 700, input: '' }), /process timeout/);
  assert.ok(existsSync(pid), 'descendant actually started before timeout');
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal(existsSync(marker), false, 'timed-out descendant must not keep executing');
  // A killed descendant may briefly be a zombie awaiting its parent/reaper, so
  // the portable assertion is cessation of its scheduled durable effect.
  assert.match(readFileSync(pid, 'utf8'), /^\d+$/);
});

test('Rust executable comes from Cargo artifact messages including target overrides', () => {
  const message = { reason: 'compiler-artifact', target: { name: 'command_fixture', kind: ['example'] }, executable: '/custom-target/host/debug/examples/command_fixture' };
  const output = JSON.stringify({ reason: 'compiler-artifact', target: { name: 'library', kind: ['lib'] } }) + '\n' + JSON.stringify(message) + '\n';
  assert.equal(rustExecutableFromMessages(output), message.executable);
  assert.throws(() => rustExecutableFromMessages(''), /exactly one/);
  assert.throws(() => rustExecutableFromMessages(JSON.stringify(message) + '\n' + JSON.stringify(message)), /exactly one/);
  assert.throws(() => rustExecutableFromMessages(JSON.stringify({ ...message, executable: null })), /exactly one/);
});

test('successful adapter exit also closes background descendants', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tower-process-success-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, 'late-write');
  const worker = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'late'),600);`;
  const parent = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(worker)}],{stdio:'ignore'}); child.unref(); setTimeout(()=>process.stdout.write('done'),150);`;
  assert.equal(await processOutput(process.execPath, ['-e', parent], { input: '' }), 'done');
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(existsSync(marker), false);
});
