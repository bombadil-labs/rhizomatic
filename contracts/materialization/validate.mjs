// M0 packet consistency only. This does not execute or certify the proposed profile.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const json = name => JSON.parse(readFileSync(resolve(directory, name), 'utf8'));
const requiredFiles = [
  'README.md', 'SPEC.md', 'DECISIONS.md', 'BOUNDARIES.json', 'API.json',
  'ACCEPTANCE.json', 'MILESTONES.json', 'TRANSPORT.md', 'TOWERS.json', 'CI.md',
  'bootstrap.json', 'LOAM-TRIAL.md', 'HANDOFF.md', 'REVIEW-REPAIRS.md', 'validate.mjs', 'M2-VARIANTS.json', 'M2-CASES.json',
];
const limits = {
  artifactBytes: 16777216, deliveryAppearances: 8192, deliveryBytes: 33554432,
  appearances: 4096, entries: 16384, nodes: 4096, depth: 32, pointers: 256,
  buckets: 256, readings: 256, definitions: 256, syntaxDepth: 64,
  syntaxNodes: 16384, roots: 64, registrations: 64, components: 64,
  inventoryIds: 16384,
};
const requirements = Array.from({ length: 24 }, (_, index) => `MR-${String(index + 1).padStart(2, '0')}`);
const ownerPins = {
  'rhizomatic.syntax/reading-appearance/1': 'syntax',
  'rhizomatic.hview-envelope/1/encode': 'algebra',
  'rhizomatic.hview-envelope/1/decode': 'algebra',
  'rhizomatic.materialization/1/description': 'command-data',
  'rhizomatic.materialization/1/capture': 'federation',
  'rhizomatic.materialization-control/1': 'reactor',
  'rhizomatic.materialization/1/control-store': 'storage',
};
const originalBoundaries = json('../command/BOUNDARIES.json');
const originalBootstrap = json('../command/bootstrap.json');
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
function unique(values, label) {
  assert.equal(new Set(values).size, values.length, `duplicate ${label}`);
}
function dag(nodes, label) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const visiting = new Set(), done = new Set();
  function visit(id) {
    assert(byId.has(id), `unknown ${label} dependency ${id}`);
    assert(!visiting.has(id), `cyclic ${label} dependency ${id}`);
    if (done.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).depends_on ?? []) visit(dependency);
    visiting.delete(id); done.add(id);
  }
  for (const id of byId.keys()) visit(id);
}
function packet() {
  return {
    acceptance: json('ACCEPTANCE.json'), milestones: json('MILESTONES.json'), variants: json('M2-VARIANTS.json'), batch: json('M2-CASES.json'),
    boundaries: json('BOUNDARIES.json'), api: json('API.json'),
    towers: json('TOWERS.json'), bootstrap: json('bootstrap.json'),
    spec: readFileSync(resolve(directory, '../../spec/16-materialization.md'), 'utf8'),
    loam: readFileSync(resolve(directory, 'LOAM-TRIAL.md'), 'utf8'),
    repairs: readFileSync(resolve(directory, 'REVIEW-REPAIRS.md'), 'utf8'),
  };
}
function validate(p) {
  assert.equal(p.acceptance.format, 'rhizomatic-materialization-acceptance/1', 'acceptance format');
  assert.equal(p.acceptance.status, 'scenario_specifications_not_executed', 'false acceptance claim');
  assert.deepEqual(p.acceptance.requirements, requirements, 'requirement inventory');
  const declared = [...p.spec.matchAll(/\*\*(MR-\d\d)\.\*\*/g)].map(match => match[1]);
  assert.deepEqual(declared, requirements, 'SPEC requirement inventory');
  const referenced = [...p.spec.matchAll(/MR-\d\d/g)].map(match => match[0]);
  for (const id of referenced) assert(requirements.includes(id), `unknown spec requirement ${id}`);
  for (const [name, maximum] of Object.entries(limits)) {
    const row = new RegExp(`\\| ${name} \\| ([\\d,]+) \\|`).exec(p.spec);
    assert(row && Number(row[1].replaceAll(',', '')) === maximum, `finite limit ${name}`);
  }

  const cases = p.acceptance.scenarios;
  unique(cases.map(c => c.id), 'case ID');
  const byCase = new Map(cases.map(c => [c.id, c]));
  const covered = new Set();
  for (const c of cases) {
    assert(/^[a-z][a-z0-9_]*$/.test(c.id), `case identity ${c.id}`);
    assert(nonempty(c.setup) && Array.isArray(c.schedule) && c.schedule.length > 0 &&
      c.schedule.every(nonempty) && nonempty(c.expected), `case schedule/expected ${c.id}`);
    assert.equal(c.state, 'specified', `false case certification ${c.id}`);
    assert.deepEqual(c.execution_evidence, [], `invented execution evidence ${c.id}`);
    assert(Array.isArray(c.requirements) && c.requirements.length > 0, `missing requirement ${c.id}`);
    unique(c.requirements, `case requirement ${c.id}`);
    for (const id of c.requirements) {
      assert(requirements.includes(id), `unknown requirement ${id}`); covered.add(id);
    }
  }
  assert.deepEqual([...covered].sort(), requirements, 'uncovered requirements');

  const milestones = p.milestones.milestones;
  assert.deepEqual(milestones.map(m => m.id), ['M0', 'M1', 'M2', 'M3', 'M4', 'M5'], 'milestone inventory');
  dag(milestones, 'milestone');
  const allocated = [];
  for (const m of milestones) {
    assert(m.required_cases.length > 0, `empty milestone ${m.id}`);
    unique(m.required_cases, 'milestone case');
    for (const id of m.required_cases) {
      assert(byCase.has(id), `missing allocated case ${id}`);
      assert.equal(byCase.get(id).milestone, m.id, `case moved ${id}`); allocated.push(id);
    }
  }
  unique(allocated, 'global allocation');
  assert.deepEqual(allocated.sort(), [...byCase.keys()].sort(), 'unallocated case');
  assert.deepEqual(cases.filter(c => c.milestone === 'M5').map(c => c.id).sort(), [
    'loam_primary_actual_door', 'loam_nested_reopen', 'loam_bucket_resolver',
    'loam_present_history_closure', 'loam_remove_replace', 'loam_time_authority',
    'loam_declared_restore', 'loam_bystander_exclusions', 'loam_concurrent_basis',
    'loam_production_delete_duplicate',
  ].sort(), 'Loam schedule inventory');
  const variantCases = p.variants.cases;
  assert.deepEqual(variantCases.map(c => c.case).sort(), cases.filter(c => c.milestone === 'M2').map(c => c.id).sort(), 'M2 variant case allocation');
  const lifecyclePins = ['cmd_delivery_support::install-support', 'cmd_shapes_closed::lifecycle-descriptions', 'cmd_inert_retention::empty-control-read', 'cmd_error_priority::retire-restore-unrelated-binding', 'cmd_error_priority::lifecycle-expected-source', 'cmd_authority_capture_validity::maintained-read-authority-expiry'];
  const allVariants = variantCases.flatMap(c => c.variants);
  unique(allVariants.map(v => v.id), 'variant ID');
  for (const c of variantCases) {
    assert(c.variants.some(v => v.id === `${c.case}::batch` && v.milestone === 'M2'), `missing batch variant ${c.case}`);
    for (const v of c.variants) assert(v.id.startsWith(`${c.case}::`) && ['M2','M3'].includes(v.milestone) && nonempty(v.expectation) && v.state === 'specified', `invalid variant ${v.id}`);
  }
  assert.deepEqual(allVariants.filter(v => v.milestone === 'M3').map(v => v.id).sort(), lifecyclePins.sort(), 'M3 cumulative lifecycle variants');
  assert.deepEqual(p.milestones.milestones.find(m => m.id === 'M3').required_variants.sort(), lifecyclePins.sort(), 'M3 cumulative executable allocation');
  assert.equal(p.batch.format, 'rhizomatic-materialization-m2-case-assertions/1', 'batch allocation format');
  unique(p.batch.cases.map(c => c.id), 'batch case');
  assert.deepEqual(p.batch.cases.map(c => c.id).sort(), allVariants.filter(v => v.milestone === 'M2').map(v => v.id).sort(), 'M2 executable batch allocation');
  for (const c of p.batch.cases) {
    assert(c.vector_assertions.length > 0, `empty batch assertions ${c.id}`);
    for (const ref of c.vector_assertions) {
      assert(['commands', 'command-descriptions', 'source-snapshot'].includes(ref.corpus), `unknown batch corpus ${c.id}`);
      const corpus = JSON.parse(readFileSync(resolve(directory, '../../vectors/materialization', ref.corpus + '.json')));
      assert(corpus[ref.group]?.some(v => v.id === ref.id), `missing batch fixture ${c.id}: ${ref.id}`);
    }
  }
  const repairCases = {
    M2: ['cmd_resolve_embedded_closure', 'cmd_authority_capture_validity', 'cmd_public_basis_privacy'],
    M3: ['ctl_capacity_rotation', 'ctl_shared_basis_limits', 'ctl_support_erasure', 'ctl_support_erasure_crashes'],
  };
  for (const [milestone, ids] of Object.entries(repairCases)) {
    for (const id of ids) assert.equal(byCase.get(id)?.milestone, milestone, `missing repair case ${id}`);
  }
  for (const finding of [...Array.from({ length: 9 }, (_, i) => `B${i + 1}`),
    ...Array.from({ length: 8 }, (_, i) => `A${i + 1}`), 'S1']) {
    assert(p.repairs.includes(`| ${finding} |`), `missing repair disposition ${finding}`);
  }
  for (const match of p.repairs.matchAll(/`((?:packet|profile1|env|cmd|ctl|tower|loam|nested)_[a-z0-9_]+)`/g)) {
    assert(byCase.has(match[1]), `unknown disposition case ${match[1]}`);
  }
  const basis = /Basis = \{([\s\S]*?)\}\nGatherBody/.exec(p.spec)?.[1];
  assert(basis && !/rawIds|operandIds|exclusions|root:/.test(basis), 'public Basis privacy/root boundary');
  assert(p.spec.includes('ComponentCommitment = {peer: PeerId, revision: ID, capturedAt: finiteFloat}'), 'compact component shape');
  const rootResult = /RootResult = \{([\s\S]*?)\}\nTransitionBody/.exec(p.spec)?.[1];
  assert(rootResult && !/basis|definitions|gather:/.test(rootResult), 'shared multi-root basis');
  assert(p.loam.includes('batch gather then resolve for') && p.loam.includes('ONE attempt') &&
    p.loam.includes('4096/4097') && p.loam.includes('BEFORE portable dispatch'), 'Loam bounded batch handoff');

  const cards = p.boundaries.cards;
  unique(cards.map(c => c.id), 'owner');
  const owners = new Set(cards.map(c => c.id));
  assert.deepEqual([...owners].sort(), originalBoundaries.cards.map(c => c.id).sort(), 'owner inventory');
  for (const card of cards) {
    const original = originalBoundaries.cards.find(c => c.id === card.id);
    assert.deepEqual(card.allowed_dependencies, original.allowed_dependencies, `changed owner graph ${card.id}`);
    assert.equal(card.evidence_state, 'specified_not_run', `false owner evidence ${card.id}`);
  }
  dag(cards.map(c => ({ id: c.id, depends_on: c.allowed_dependencies })), 'owner');
  assert.deepEqual(p.boundaries.lower_level_witnesses_preserved, { elixir: 0, haskell: 0 }, 'changed lower witness levels');
  const contracts = p.api.contracts;
  unique(contracts.map(c => c.id), 'API contract');
  const byContract = new Map(contracts.map(c => [c.id, c]));
  for (const contract of contracts) {
    assert(contract.owners.every(o => owners.has(o)), `unknown contract owner ${contract.id}`);
  }
  for (const [id, owner] of Object.entries(ownerPins)) {
    assert.deepEqual(byContract.get(id)?.owners, [owner], `wrong semantic owner ${id}`);
  }
  unique(p.api.exports.map(e => e.ts), 'prospective TS export');
  unique(p.api.exports.map(e => e.rust), 'prospective Rust export');
  for (const e of p.api.exports) {
    assert(owners.has(e.owner) && byContract.has(e.contract), `unclassified export ${e.ts}`);
    assert(['portable_contract', 'host_capability'].includes(e.classification) && nonempty(e.signature_contract), `invalid API classification ${e.ts}`);
  }

  const endpoint = p.api.exports.find(e => e.ts === 'MaterializationEndpoint')?.signature_contract;
  assert(endpoint?.includes('invoke(entryId,debugAppearances,receivedAt:') &&
    !/signer,clock/.test(endpoint), 'explicit trusted observation API');
  const source = p.api.exports.find(e => e.ts === 'MaterializationSourceCapability')?.signature_contract;
  assert(source?.includes('requiredSupport:'), 'explicit selected-support enforcement API');

  const towers = p.towers;
  assert.equal(towers.assignments_per_scenario, 3, 'three towers required');
  assert.equal(towers.planner.version, 'rhizomatic.command.tower/1', 'planner version');
  assert(towers.planner.seed_required && towers.planner.minimum_switches === 1 &&
    towers.planner.missing_mixed_route === 'fail', 'mixed scheduling requirement');
  assert.equal(towers.status, 'specified_not_executed', 'false tower certification');
  unique(towers.stages.map(s => s.id), 'stage');
  dag(towers.stages, 'stage');
  for (const stage of towers.stages) {
    assert(byContract.has(stage.contract) && stage.owners.every(o => owners.has(o)), `unknown stage contract/owner ${stage.id}`);
  }
  for (const m of ['M1', 'M2', 'M3']) {
    const selected = towers.milestone_graphs[m];
    assert(Array.isArray(selected) && selected.length >= 2, `missing graph ${m}`);
    dag(towers.stages.filter(s => selected.includes(s.id)), `${m} selected graph`);
    assert.equal(towers.fixed_routes[m]?.length, 2, `fixed mixed routes ${m}`);
    assert(towers.fixed_routes[m][0].startsWith('ts:') && towers.fixed_routes[m][1].startsWith('rust:'), `fixed direction ${m}`);
  }
  for (const ids of Object.values(towers.required_scenarios)) {
    for (const id of ids) assert(byCase.has(id), `unknown tower scenario ${id}`);
  }
  for (const field of ['concrete_assignments', 'source_commits', 'build_hashes', 'source_artifacts',
    'explicit_observation_schedule', 'fault_schedule', 'expected_outputs', 'actual_outputs', 'replay_command',
    'trusted_receivedAt_arguments', 'source_capacity_classification', 'durable_host_configuration_selection',
    'program_support_purge_observations']) {
    assert(towers.replay_bundle_fields.includes(field), `missing replay field ${field}`);
  }
  for (const witness of towers.witnesses) {
    assert.equal(witness.state, 'not_implemented', `false capability ${witness.id}`);
    assert.deepEqual(witness.stages, [], `false capability stages ${witness.id}`);
    const actual = JSON.parse(readFileSync(resolve(directory, '../../implementations', witness.id, 'witness.json'), 'utf8'));
    assert.equal(witness.level, actual.conformanceLevel, `witness level changed ${witness.id}`);
  }
  assert.deepEqual(p.bootstrap.existing_pins_preserved, originalBootstrap.canonical_pins, 'bootstrap pin changed');
  for (const item of [...p.bootstrap.intrinsics, ...p.bootstrap.host_capabilities]) {
    assert(owners.has(item.owner), `unknown bootstrap owner ${item.id}`);
  }
}

for (const name of requiredFiles) assert(existsSync(resolve(directory, name)), `missing packet file ${name}`);
for (const name of requiredFiles.filter(name => name.endsWith('.md'))) {
  const content = readFileSync(resolve(directory, name), 'utf8');
  for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (target && !/^[a-z]+:/i.test(target)) assert(existsSync(resolve(directory, target)), `broken local link ${name}: ${target}`);
  }
}
const p = packet();
validate(p);
let negativeCount = 0;
if (process.argv.includes('--self-test')) {
  const mutations = [
    ['missing batch allocation', q => q.batch.cases.pop(), /M2 executable batch allocation/],
    ['missing batch fixture', q => q.batch.cases[0].vector_assertions[0].id = 'absent', /missing batch fixture/],
    ['missing lifecycle variant', q => q.variants.cases.find(c => c.case === 'cmd_error_priority').variants.pop(), /M3 cumulative lifecycle variants/],
    ['missing M3 variant gate', q => q.milestones.milestones.find(m => m.id === 'M3').required_variants.pop(), /M3 cumulative executable allocation/],
    ['missing case', q => q.acceptance.scenarios.splice(5, 1), /missing allocated case/],
    ['unknown requirement', q => q.acceptance.scenarios[0].requirements.push('MR-99'), /unknown requirement/],
    ['moved case', q => q.acceptance.scenarios[0].milestone = 'M1', /case moved/],
    ['wrong semantic owner', q => q.api.contracts[1].owners = ['command'], /wrong semantic owner/],
    ['changed graph', q => q.boundaries.cards[0].allowed_dependencies.push('command'), /changed owner graph/],
    ['limit changed', q => q.spec = q.spec.replace('| depth | 32 |', '| depth | 33 |'), /finite limit depth/],
    ['false capability', q => q.towers.witnesses[0].state = 'supported', /false capability/],
    ['replay omitted', q => q.towers.replay_bundle_fields = q.towers.replay_bundle_fields.filter(x => x !== 'source_artifacts'), /missing replay field/],
    ['missing fixed route', q => q.towers.fixed_routes.M2.pop(), /fixed mixed routes/],
    ['invented evidence', q => q.acceptance.scenarios[0].execution_evidence.push('passed'), /invented execution evidence/],
    ['public inventories', q => q.spec = q.spec.replace('components: [ComponentCommitment...]', 'components: [ComponentCommitment...], rawIds: [ID...]'), /public Basis privacy/],
    ['root repeats basis', q => q.spec = q.spec.replace('RootResult = {root:', 'RootResult = {basis: Basis, root:'), /shared multi-root basis/],
    ['observation omitted', q => q.api.exports.find(e => e.ts === 'MaterializationEndpoint').signature_contract = 'invoke(entryId,debugAppearances)', /explicit trusted observation API/],
    ['support context omitted', q => q.api.exports.find(e => e.ts === 'MaterializationSourceCapability').signature_contract = 'checkCurrent(binding,revision,authority,servingAt)', /explicit selected-support enforcement API/],
    ['disposition omitted', q => q.repairs = q.repairs.replace('| S1 |', '| X1 |'), /missing repair disposition/],
  ];
  for (const [label, mutate, expected] of mutations) {
    const q = structuredClone(p); mutate(q);
    assert.throws(() => validate(q), expected, `negative mutation failed: ${label}`);
    negativeCount++;
  }
}
console.log(`M0 packet consistent: ${p.acceptance.scenarios.length} specified cases, ${requirements.length} requirements, 6 milestones, ${negativeCount} negative checks. Runtime/review acceptance pending.`);
