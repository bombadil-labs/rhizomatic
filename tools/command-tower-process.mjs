import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { fingerprint } from './command-tower-plan.mjs';

const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const environment = () => ({ ...process.env, PATH: join(homedir(), '.cargo/bin') + delimiter + process.env.PATH });

export function processOutput(command, args, { cwd, input, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: environment(), stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '', stderr = '', settled = false;
    const finish = error => { if (!settled) { settled = true; clearTimeout(timer); error ? reject(error) : resolve(stdout); } };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(Error(`process timeout: ${command} ${args.join(' ')}`)); }, timeout);
    child.stdout.on('data', bytes => { stdout += bytes; if (stdout.length > 64 * 1024 * 1024) { child.kill('SIGKILL'); finish(Error('adapter stdout limit')); } });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-65536); });
    child.on('error', finish);
    child.on('close', (code, signal) => finish(code === 0 ? null : Error(`${command} exited ${code ?? signal}: ${stderr}`)));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') finish(error); });
    child.stdin.end(input);
  });
}

function directoryDigest(directory) {
  const files = [];
  const visit = (path, relative) => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name), key = relative ? relative + '/' + name : name, stat = lstatSync(full);
      // npm's .bin symlinks are launch conveniences. Invocation below uses the
      // actual pinned package file; hash every real installed dependency file.
      if (stat.isSymbolicLink()) {
        requireThat(key.split('/').includes('.bin'), `unpinned symlink dependency: ${key}`);
        continue;
      }
      if (stat.isDirectory()) visit(full, key);
      else if (stat.isFile()) files.push([key, digest(readFileSync(full))]);
      else throw Error(`unsupported installed dependency entry: ${key}`);
    }
  };
  visit(directory, '');
  return fingerprint(files);
}

export async function prepareWitnesses(root) {
  const git = async args => (await processOutput('git', args, { cwd: root })).trim();
  requireThat(await git(['status', '--porcelain', '--untracked-files=normal']) === '', 'tower evidence requires a clean committed source tree');
  const commit = await git(['rev-parse', 'HEAD']);
  const tree = await git(['rev-parse', 'HEAD^{tree}']);
  const tsDirectory = join(root, 'implementations/ts'), rustDirectory = join(root, 'implementations/rust');
  const nodeVersion = (await processOutput(process.execPath, ['--version'])).trim();
  const rustVersion = (await processOutput('rustc', ['--version'])).trim();
  const cargoVersion = (await processOutput('cargo', ['--version'])).trim();
  await processOutput('cargo', ['build', '--locked', '--quiet', '--example', 'command_fixture'], { cwd: rustDirectory, timeout: 600000 });
  const binary = join(rustDirectory, 'target/debug/examples/command_fixture' + (process.platform === 'win32' ? '.exe' : ''));
  const metadata = {
    commit, tree, platform: process.platform, architecture: process.arch,
    ts: { nodeVersion, installedDependencies: directoryDigest(join(tsDirectory, 'node_modules')) },
    rust: { rustVersion, cargoVersion, binary: digest(readFileSync(binary)) },
  };
  const builds = Object.fromEntries(['ts', 'rust'].map(id => [id, fingerprint({ commit, tree, platform: metadata.platform, architecture: metadata.architecture, witness: id, artifact: metadata[id] })]));
  const adapter = async (witness, input) => {
    requireThat(witness === 'ts' || witness === 'rust', `unavailable adapter: ${witness}`);
    const command = witness === 'ts' ? process.execPath : binary;
    const args = witness === 'ts' ? [join(tsDirectory, 'node_modules/tsx/dist/cli.mjs'), join(tsDirectory, 'tools/command-fixture.ts')] : [];
    const stdout = await processOutput(command, args, { cwd: root, input: JSON.stringify(input) + '\n' });
    try { return JSON.parse(stdout); } catch { throw Error(`${witness} adapter emitted invalid JSON`); }
  };
  return { commit, builds, metadata, adapter };
}

// This verifies exact reported execution identities. CI controls report creation;
// metadata cannot prove assertion quality, which remains an independent review.
export function bindStageEvidence({ report, commit, fixtures, spec, capabilities, builds }) {
  requireThat(report?.format === 'rhizomatic-command-stage-evidence/1' && report.commit === commit, 'stage evidence must name the exact implementation commit');
  requireThat(Array.isArray(report.witnesses) && new Set(report.witnesses.map(w => w.id)).size === report.witnesses.length, 'duplicate or missing evidence witness');
  const snapshot = structuredClone(capabilities);
  for (const id of ['ts', 'rust']) {
    const witness = snapshot.witnesses.find(w => w.id === id), evidence = report.witnesses.find(w => w.id === id);
    requireThat(witness && evidence?.stages && builds[id], `missing executed ${id} evidence/build`);
    requireThat(witness.state === 'supported', `unadvertised ${id} stage support`);
    witness.buildId = builds[id]; witness.stage_evidence = {};
    for (const stage of spec.stages) {
      requireThat(witness.stages.includes(stage.contract), `unadvertised ${id}/${stage.contract}`);
      const expected = fixtures.cases.filter(f => f.tower === true && spec.required_scenarios.includes(f.scenario))
        .flatMap(f => (f.steps ?? [{ id: 'command' }]).map(s => `${f.id}/${s.id}/${stage.id}`)).sort();
      const actual = evidence.stages[stage.contract];
      requireThat(expected.length > 0 && Array.isArray(actual) && actual.every(c => c.status === 'passed'), `missing/nonpassing stage cases: ${id}/${stage.id}`);
      requireThat(fingerprint(actual.map(c => c.id).sort()) === fingerprint(expected), `executed stage identity mismatch: ${id}/${stage.id}`);
      witness.stage_evidence[stage.contract] = expected;
    }
    requireThat(fingerprint(Object.keys(evidence.stages).sort()) === fingerprint(spec.stages.map(s => s.contract).sort()), 'unknown evidence stage');
  }
  return snapshot;
}
