import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { planTowers, validateReplayPlan, fingerprint, canonicalJson } from './command-tower-plan.mjs';

const FORMAT = 'rhizomatic-command-tower-run/1';
const STAGES = ['construct', 'validate', 'execute', 'read-result'];
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
const copy = value => structuredClone(value);
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const digestRecord = value => ({ value: copy(value), hash: fingerprint(value) });

function selectFixtures(fixtures, spec) {
  requireThat(fixtures.format === 'rhizomatic-command-execution-vectors/1' && Array.isArray(fixtures.cases), 'execution fixture format');
  requireThat(new Set(fixtures.cases.map(c => c.id)).size === fixtures.cases.length, 'duplicate fixture identity');
  requireThat(Array.isArray(spec.required_scenarios) && new Set(spec.required_scenarios).size === spec.required_scenarios.length, 'required scenario inventory');
  return spec.required_scenarios.map(scenario => {
    const selected = fixtures.cases.filter(c => c.scenario === scenario && c.tower === true);
    requireThat(selected.length === 1, `expected one explicit tower fixture for ${scenario}`);
    const fixture = selected[0];
    requireThat(typeof fixture.id === 'string' && /^[a-zA-Z0-9_-]+$/.test(fixture.id), 'invalid fixture ID');
    return copy(fixture);
  });
}

function stepsOf(fixture) {
  const steps = fixture.steps ?? [{ id: 'command', context: fixture.context, expected: fixture.expected }];
  requireThat(Array.isArray(steps) && steps.length > 0, `missing steps: ${fixture.id}`);
  requireThat(new Set(steps.map(s => s.id)).size === steps.length, 'duplicate step identity');
  return steps.map((step, i) => {
    requireThat(typeof step.id === 'string' && step.id.length > 0, 'missing step identity');
    requireThat(step && step.context && step.expected, `missing explicit step context/oracle: ${fixture.id}/${i}`);
    requireThat(typeof step.expected.oracle === 'string' && step.expected.oracle.length > 0, `missing independent oracle explanation: ${fixture.id}/${i}`);
    requireThat(step.expected.artifact && step.expected.result && step.expected.observed && step.expected.outcome, `incomplete artifact/result/state/outcome oracle: ${fixture.id}/${i}`);
    return copy(step);
  });
}

function bindContext(step, observations) {
  const context = copy(step.context);
  requireThat(context.storePath === undefined, 'fixture must not choose a shared durable directory');
  for (const binding of context.construction?.bind ?? []) {
    requireThat(binding.role === 'rhizomatic.command.expected-head' && binding.observation?.field === 'head', 'unsupported explicit observation binding');
    const previous = observations.get(binding.observation.step);
    requireThat(previous && typeof previous.head === 'string', 'head binding needs prior observed head');
    const pointers = context.construction?.request?.claims?.pointers;
    requireThat(Array.isArray(pointers), 'head binding needs explicit request claims');
    const heads = pointers.filter(p => p.role === 'rhizomatic.command.expected-head');
    requireThat(heads.length === 1, 'head binding needs one explicit expected-head field');
    heads[0].target = previous.head;
  }
  return context;
}

function assertSame(actual, expected, label) {
  requireThat(isDeepStrictEqual(actual, expected), `${label}: actual ${canonicalJson(actual)} expected ${canonicalJson(expected)}`);
}

// Compare the independently fixed oracle at each semantic port, before comparing
// witnesses. Agreement between two wrong implementations cannot pass this gate.
function checkPort(stage, output, expected, artifact) {
  if (stage === 'construct') {
    requireThat(output && Object.keys(output).length === 1 && output.artifact, 'construct framing');
    assertSame(output.artifact, expected.artifact, 'construction oracle');
  } else if (stage === 'validate') {
    requireThat(output?.verdict?.valid === true, 'description validator refused tower fixture');
    assertSame(output.artifact, artifact, 'validator changed serialized artifact');
  } else if (stage === 'execute') {
    requireThat(output?.outcome && output.observed, 'execution framing');
    assertSame(output.observed, expected.observed, 'durable state oracle');
    assertSame(output.outcome, expected.outcome, 'signed outcome oracle');
  } else {
    assertSame(output, expected.result, 'complete readback oracle');
  }
}

function fixedRoutes(stages, capabilities, builds) {
  return [['ts', 'rust', 'rust', 'ts'], ['rust', 'ts', 'ts', 'rust']].map((witnesses, index) => ({
    index: `fixed-${index}`, repeatedFrom: null,
    assignments: stages.map((stage, i) => {
      const witness = witnesses[i], capability = capabilities.witnesses.find(w => w.id === witness);
      requireThat(capability?.state === 'supported' && capability.stages.includes(stage.contract), `missing fixed ${witness} route at ${stage.id}`);
      requireThat(builds[witness] === capability.buildId, 'fixed route build mismatch');
      return { stage: stage.id, witness, buildId: capability.buildId };
    }),
  }));
}

function verifyRecord(record, label) {
  requireThat(record && record.hash === fingerprint(record.value), `retained ${label} hash mismatch`);
  return copy(record.value);
}

export function validateRunBundle(bundle, availableBuilds) {
  requireThat(bundle?.format === FORMAT, 'unsupported run bundle');
  const { bundleHash, ...body } = bundle;
  requireThat(bundleHash === fingerprint(body), 'run bundle hash mismatch');
  const capabilities = verifyRecord(bundle.capabilities, 'capabilities');
  const spec = verifyRecord(bundle.spec, 'stage inventory');
  const fixtures = verifyRecord(bundle.fixtures, 'fixtures');
  requireThat(Array.isArray(bundle.scenarios), 'missing retained scenario plans');
  const selected = selectFixtures(fixtures, spec);
  requireThat(bundle.scenarios.length === selected.length, 'missing retained scenario');
  for (let i = 0; i < selected.length; i++) {
    const recorded = bundle.scenarios[i], fixture = selected[i];
    requireThat(recorded.fixtureId === fixture.id && recorded.scenario === fixture.scenario, 'retained fixture identity changed');
    validateReplayPlan(recorded.plan, { stages: spec.stages, capabilities, availableBuilds });
    requireThat(recorded.plan.scenario === fixture.scenario, 'plan scenario mismatch');
    assertSame(recorded.fixedRoutes, fixedRoutes(spec.stages, capabilities, availableBuilds), 'fixed replay routes');
    for (const run of recorded.runs) for (const stage of run.stages) {
      verifyRecord(stage.input, 'stage input');
      if (stage.output) verifyRecord(stage.output, 'stage output');
    }
  }
  return { capabilities, spec, fixtures };
}

// The injected adapter is a process runner in CI. Unit tests substitute a tiny
// transport to attack orchestration only; those tests never certify a witness.
export async function runTowerSuite({ fixtures, spec, capabilities, builds, buildMetadata, seed, outDir, adapter, replayBundle }) {
  requireThat(typeof adapter === 'function', 'missing executable adapters');
  requireThat(!existsSync(outDir), 'output directory already exists; each run needs isolated state');
  const selected = selectFixtures(fixtures, spec);
  requireThat(isDeepStrictEqual(spec.stages.map(s => s.id), STAGES), 'runner supports only the four declared initial ports');
  requireThat(spec.stages.every((stage, i) => stage.depends_on === undefined && stage.input_from === (i === 0 ? undefined : STAGES[i - 1])), 'runner supports only the explicit initial chain');
  for (const fixture of selected) stepsOf(fixture);
  if (replayBundle) {
    const retained = validateRunBundle(replayBundle, builds);
    assertSame({ fixtures, spec, capabilities }, retained, 'replay retained inputs');
  }
  mkdirSync(outDir, { recursive: true });
  const bundle = {
    format: FORMAT, seed, builds: copy(builds), buildMetadata: copy(buildMetadata),
    capabilities: digestRecord(capabilities), spec: digestRecord(spec), fixtures: digestRecord(fixtures),
    scenarios: selected.map((fixture, i) => ({
      fixtureId: fixture.id, scenario: fixture.scenario,
      plan: replayBundle ? copy(replayBundle.scenarios[i].plan) : planTowers({ stages: spec.stages, capabilities, seed, scenario: fixture.scenario }),
      fixedRoutes: replayBundle ? copy(replayBundle.scenarios[i].fixedRoutes) : fixedRoutes(spec.stages, capabilities, builds), runs: [], edges: [],
    })), status: 'running',
  };
  const save = () => json(join(outDir, 'run.json'), { ...bundle, bundleHash: fingerprint(bundle) });
  save();
  try {
    for (let fi = 0; fi < selected.length; fi++) {
      const fixture = selected[fi], scenario = bundle.scenarios[fi], plan = scenario.plan;
      validateReplayPlan(plan, { stages: spec.stages, capabilities, availableBuilds: builds });
      const routes = scenario.fixedRoutes;
      const reference = new Map();
      for (const route of [...routes, ...plan.plans]) {
        const runId = String(route.index), run = { id: runId, stages: [], status: 'running' };
        scenario.runs.push(run);
        const statePath = join(resolve(outDir), 'states', fixture.id, runId, 'journal.json');
        mkdirSync(dirname(statePath), { recursive: true });
        const observations = new Map();
        const steps = stepsOf(fixture);
        for (let si = 0; si < steps.length; si++) {
          const step = steps[si], context = bindContext(step, observations);
          // The initial state and complete observation schedule are retained in
          // the hashed fixture. Only this transport-local directory is fresh.
          context.storePath = statePath;
          let artifact, outcome, execution;
          for (let ni = 0; ni < STAGES.length; ni++) {
            const stage = STAGES[ni], assignment = route.assignments[ni];
            const input = { mode: stage, scenario: fixture.scenario, context: copy(context),
              ...(artifact ? { artifact: copy(artifact) } : {}), ...(outcome ? { outcome: copy(outcome) } : {}) };
            // Persist input before invoking a process, including when it crashes.
            const record = { step: si, stage, witness: assignment.witness, contract: spec.stages[ni].contract,
              owners: copy(spec.stages[ni].owners ?? []), input: digestRecord(input), status: 'running' };
            run.stages.push(record); save();
            try {
              const output = await adapter(assignment.witness, copy(input), { fixtureId: fixture.id, runId, step: si, stage });
              record.output = digestRecord(output); save();
              checkPort(stage, output, step.expected, artifact);
              const comparisonKey = `${si}/${stage}`;
              if (reference.has(comparisonKey)) assertSame(output, reference.get(comparisonKey), `cross-tower ${comparisonKey}`);
              else reference.set(comparisonKey, copy(output));
              if (stage === 'construct' || stage === 'validate') artifact = output.artifact;
              if (stage === 'execute') { outcome = output.outcome; execution = output; }
              record.status = 'passed';
            } catch (error) {
              record.status = 'failed'; record.error = String(error); run.status = 'failed';
              bundle.failure = { fixtureId: fixture.id, runId, step: si, stage, witness: assignment.witness,
                contract: record.contract, owners: record.owners, error: String(error) };
              throw error;
            } finally { save(); }
            if (ni > 0) scenario.edges.push({ step: si, runId, producerContract: spec.stages[ni - 1].contract,
              producerWitness: route.assignments[ni - 1].witness, consumerContract: record.contract, consumerWitness: assignment.witness });
          }
          observations.set(step.id, execution.observed);
        }
        run.status = 'passed'; save();
      }
    }
    bundle.status = 'passed'; save();
    return JSON.parse(readFileSync(join(outDir, 'run.json'), 'utf8'));
  } catch (error) {
    bundle.status = 'failed'; save();
    throw new Error(`${error}\nRetained tower run: ${join(resolve(outDir), 'run.json')}\nReplay: node tools/command-towers.mjs --replay ${JSON.stringify(join(resolve(outDir), 'run.json'))}`, { cause: error });
  }
}

async function main(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    requireThat(['--evidence', '--seed', '--out', '--replay'].includes(args[i]) && args[i + 1] && flags[args[i]] === undefined, 'usage: --evidence REPORT [--seed SEED] [--out NEW_DIRECTORY], or --replay RUN_JSON [--out NEW_DIRECTORY]');
    flags[args[i]] = args[i + 1];
  }
  requireThat(Boolean(flags['--evidence']) !== Boolean(flags['--replay']), 'provide exactly one evidence report or retained replay');
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const load = path => JSON.parse(readFileSync(path, 'utf8'));
  const { prepareWitnesses, bindStageEvidence } = await import('./command-tower-process.mjs');
  const prepared = await prepareWitnesses(root);
  let fixtures, spec, capabilities, replayBundle;
  if (flags['--replay']) {
    replayBundle = load(flags['--replay']);
    ({ fixtures, spec, capabilities } = validateRunBundle(replayBundle, prepared.builds));
    assertSame(prepared.metadata, replayBundle.buildMetadata, 'replay pinned build metadata');
  } else {
    fixtures = load(join(root, 'vectors/command/execution.json'));
    spec = load(join(root, 'contracts/command/TOWERS.json'));
    capabilities = bindStageEvidence({ report: load(flags['--evidence']), commit: prepared.commit, fixtures, spec,
      capabilities: load(join(root, 'contracts/command/capabilities.json')), builds: prepared.builds });
  }
  const seed = replayBundle?.seed ?? flags['--seed'] ?? randomBytes(16).toString('hex');
  const outDir = resolve(flags['--out'] ?? join(tmpdir(), `rhizomatic-towers-${randomBytes(8).toString('hex')}`));
  process.stdout.write(`Tower seed ${seed}; pinned commit ${prepared.commit}; artifacts ${outDir}\n`);
  const bundle = await runTowerSuite({ fixtures, spec, capabilities, builds: prepared.builds, buildMetadata: prepared.metadata,
    seed, outDir, adapter: prepared.adapter, replayBundle });
  process.stdout.write(`Passed ${bundle.scenarios.length} scenarios, each with two fixed routes and three mixed towers.\nReplay: node tools/command-towers.mjs --replay ${JSON.stringify(join(outDir, 'run.json'))}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { process.stderr.write(String(error) + '\n'); process.exitCode = 1; });
}
