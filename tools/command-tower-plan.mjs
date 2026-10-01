import { createHash } from 'node:crypto';

// CI-only scheduling: no part of this module changes command interpretation.
export const PLANNER_VERSION = 'rhizomatic.command.tower/1';
const FORMAT = 'rhizomatic-command-tower-plans/1';
const WITNESSES = ['ts', 'rust', 'elixir', 'haskell'];
const plain = value => value !== null && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const nonempty = value => typeof value === 'string' && value.length > 0;
const unique = values => new Set(values).size === values.length;
const same = (a, b) => canonicalJson(a) === canonicalJson(b);

// Object-key order is not semantic. Arrays retain their contract order.
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    requireThat(Number.isFinite(value), 'non-finite plan value');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  requireThat(plain(value), 'unsupported plan value');
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function fingerprint(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function graphOf(stages) {
  requireThat(Array.isArray(stages) && stages.length > 1 && stages.length <= 64, 'invalid stage inventory');
  requireThat(stages.every(s => plain(s) && typeof s.id === 'string' && /^[a-z][a-z0-9-]*$/.test(s.id) && nonempty(s.contract)), 'missing stage identity/contract');
  requireThat(unique(stages.map(s => s.id)), 'duplicate stage identity');
  const ids = new Set(stages.map(s => s.id));
  const nodes = stages.map(s => {
    requireThat(!(s.input_from !== undefined && s.depends_on !== undefined), 'ambiguous stage dependencies');
    const dependencies = s.depends_on ?? (s.input_from === undefined ? [] : [s.input_from]);
    requireThat(Array.isArray(dependencies) && unique(dependencies) && dependencies.every(d => ids.has(d) && d !== s.id), 'invalid stage dependency');
    return { id: s.id, contract: s.contract, dependencies: [...dependencies].sort(), unsplit: s.unsplit_internal_region === true };
  });
  const ordered = [], pending = new Map(nodes.map(n => [n.id, n]));
  while (pending.size) {
    const ready = [...pending.values()].filter(n => n.dependencies.every(d => !pending.has(d))).sort((a, b) => compare(a.id, b.id));
    requireThat(ready.length > 0, 'cyclic stage graph');
    for (const n of ready) { ordered.push(n); pending.delete(n.id); }
  }
  requireThat(ordered.some(n => n.dependencies.length), 'no portable edge to exercise');
  return ordered;
}

function eligibleFor(graph, capabilities) {
  requireThat(plain(capabilities) && capabilities.format === 'rhizomatic-command-capabilities/1', 'invalid capability manifest');
  requireThat(Array.isArray(capabilities.witnesses), 'missing witness inventory');
  const witnesses = capabilities.witnesses;
  requireThat(unique(witnesses.map(w => w.id)), 'duplicate witness identity');
  for (const w of witnesses) {
    requireThat(plain(w) && WITNESSES.includes(w.id), 'unknown witness');
    requireThat(Array.isArray(w.stages) && unique(w.stages) && w.stages.every(nonempty), 'invalid stage capabilities');
    requireThat(Array.isArray(w.profiles) && unique(w.profiles) && w.profiles.every(nonempty), 'invalid profile capabilities');
    requireThat(['not_implemented', 'partial', 'supported'].includes(w.state), 'invalid capability state');
    if (w.state !== 'supported') {
      requireThat(w.stages.length === 0 && w.profiles.length === 0, 'unverified capability advertised');
      continue;
    }
    requireThat(nonempty(w.buildId), 'missing pinned witness build');
    requireThat(plain(w.stage_evidence), 'missing stage evidence');
    requireThat(same(Object.keys(w.stage_evidence).sort(), [...w.stages].sort()), 'stage evidence inventory mismatch');
    for (const contract of w.stages) {
      const evidence = w.stage_evidence[contract];
      requireThat(Array.isArray(evidence) && evidence.length > 0 && unique(evidence) && evidence.every(nonempty), 'missing executed stage cases');
    }
  }
  const byStage = new Map();
  for (const node of graph) {
    const choices = witnesses.filter(w => w.state === 'supported' && w.stages.includes(node.contract));
    requireThat(choices.length > 0, `unsupported required stage: ${node.id}`);
    byStage.set(node.id, choices.map(w => ({ witness: w.id, buildId: w.buildId })).sort((a, b) => compare(a.witness, b.witness)));
  }
  return byStage;
}

function isMixed(graph, choice) {
  return graph.some(n => n.dependencies.some(d => choice.get(d).witness !== choice.get(n.id).witness));
}

// SHA-256 over a canonical JSON tuple pins the planner's deterministic ordering.
const ranked = (values, seed, scenario, label) => [...values].sort((a, b) => {
  const rank = v => fingerprint([PLANNER_VERSION, seed, scenario, label, v]);
  const x = rank(a), y = rank(b);
  return x < y ? -1 : x > y ? 1 : 0;
});

export function planTowers({ stages, capabilities, scenario, seed }) {
  requireThat(nonempty(scenario) && nonempty(seed), 'scenario and seed are required');
  const graph = graphOf(stages), eligible = eligibleFor(graph, capabilities);
  const base = new Map(graph.map(n => [n.id, ranked(eligible.get(n.id), seed, scenario, n.id)[0]]));
  const plans = [], seen = new Set();
  const add = choice => {
    if (!isMixed(graph, choice)) return;
    const assignments = graph.map(n => ({ stage: n.id, ...choice.get(n.id) }));
    const identity = canonicalJson(assignments);
    if (seen.has(identity)) return;
    seen.add(identity);
    plans.push({ index: plans.length, assignments, repeatedFrom: null });
  };
  add(base);

  // Every mixed assignment satisfies at least one producer/consumer inequality.
  // Visit those small clauses, not the exponential Cartesian product of layers.
  // Within a clause, base plus one-coordinate variations suffices to find up to
  // three distinct assignments; smaller clauses are fully represented this way.
  const clauses = graph.flatMap(n => n.dependencies.flatMap(producer =>
    eligible.get(producer).flatMap(a => eligible.get(n.id)
      .filter(b => a.witness !== b.witness).map(b => ({ producer, consumer: n.id, a, b })))));
  for (const clause of ranked(clauses, seed, scenario, 'edges')) {
    if (plans.length >= 3) break;
    const choice = new Map(base);
    choice.set(clause.producer, clause.a); choice.set(clause.consumer, clause.b);
    add(choice);
    for (const node of ranked(graph, seed, scenario, 'variations')) {
      if (plans.length >= 3) break;
      if (node.id === clause.producer || node.id === clause.consumer) continue;
      for (const alternative of ranked(eligible.get(node.id), seed, scenario, node.id)) {
        if (plans.length >= 3) break;
        const variant = new Map(choice); variant.set(node.id, alternative); add(variant);
      }
    }
  }
  requireThat(plans.length > 0, 'no supported mixed-language assignment');
  const distinctAssignments = plans.length;
  while (plans.length < 3) {
    const original = plans[plans.length % distinctAssignments];
    plans.push({ index: plans.length, assignments: structuredClone(original.assignments), repeatedFrom: original.index });
  }
  const body = {
    format: FORMAT, plannerVersion: PLANNER_VERSION, seed, scenario,
    capabilityFingerprint: fingerprint(capabilities), graph, distinctAssignments, plans,
  };
  return { ...body, planFingerprint: fingerprint(body) };
}

// Replay checks the recorded assignment; it never chooses a new assignment.
// Build availability is supplied from the runner's independently checked binary
// identities. Retained capability evidence does not establish binary availability.
export function validateReplayPlan(bundle, { stages, capabilities, availableBuilds }) {
  requireThat(plain(bundle) && bundle.format === FORMAT && bundle.plannerVersion === PLANNER_VERSION, 'unsupported replay plan');
  requireThat(same(Object.keys(bundle).sort(), ['format', 'plannerVersion', 'seed', 'scenario', 'capabilityFingerprint', 'graph', 'distinctAssignments', 'plans', 'planFingerprint'].sort()), 'invalid replay fields');
  requireThat(nonempty(bundle.seed) && nonempty(bundle.scenario), 'missing replay context');
  const { planFingerprint, ...body } = bundle;
  requireThat(planFingerprint === fingerprint(body), 'replay plan fingerprint mismatch');
  const graph = graphOf(stages), eligible = eligibleFor(graph, capabilities);
  requireThat(same(graph, bundle.graph), 'replay graph changed');
  requireThat(fingerprint(capabilities) === bundle.capabilityFingerprint, 'replay capabilities changed');
  requireThat(plain(availableBuilds), 'missing available build identities');
  requireThat(Array.isArray(bundle.plans) && bundle.plans.length === 3, 'replay requires three assignments');
  const seen = new Map();
  for (let i = 0; i < bundle.plans.length; i++) {
    const plan = bundle.plans[i];
    requireThat(plain(plan) && same(Object.keys(plan).sort(), ['assignments', 'index', 'repeatedFrom']) && plan.index === i, 'invalid replay assignment');
    requireThat(Array.isArray(plan.assignments) && plan.assignments.length === graph.length, 'missing replay stage');
    const choice = new Map();
    for (let j = 0; j < graph.length; j++) {
      const entry = plan.assignments[j], node = graph[j];
      requireThat(plain(entry) && same(Object.keys(entry).sort(), ['buildId', 'stage', 'witness']) && entry.stage === node.id, 'invalid replay stage');
      requireThat(eligible.get(node.id).some(e => e.witness === entry.witness && e.buildId === entry.buildId), 'ineligible replay capability');
      requireThat(availableBuilds[entry.witness] === entry.buildId, 'pinned replay build unavailable');
      choice.set(node.id, entry);
    }
    requireThat(isMixed(graph, choice), 'homogeneous replay is not a mixed tower');
    const identity = canonicalJson(plan.assignments);
    if (seen.has(identity)) requireThat(plan.repeatedFrom === seen.get(identity), 'unreported repeated assignment');
    else { requireThat(plan.repeatedFrom === null, 'false repeated assignment'); seen.set(identity, i); }
  }
  requireThat(bundle.distinctAssignments === seen.size, 'incorrect distinct assignment count');
  return structuredClone(bundle);
}
