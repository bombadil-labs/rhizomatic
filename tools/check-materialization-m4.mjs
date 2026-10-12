// M4 cumulative gate over the retained M1, M2 and M3 bundles of one source head. It checks what
// no single milestone runner can: every required scenario's three seeded mixed plans and both
// fixed routes, artifact integrity, the capability gate against each real manifest, an
// independent oracle over agreeing towers, exact replay against a mutated bundle, and each
// runner's named harness failure proofs. It runs no witness semantics except the replay probe.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,cpSync,rmSync,existsSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {planTowers,validateReplayPlan,canonicalJson,fingerprint} from './command-tower-plan.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const packet=read(join(root,'contracts/materialization/TOWERS.json'));
const dirOf=(name,fallback)=>resolve(process.env[name]??join(root,fallback));
const dirs={M1:dirOf('M1_ARTIFACT_DIR','artifacts/materialization-m1'),M2:dirOf('M2_ARTIFACT_DIR','artifacts/materialization-m2'),M3:dirOf('M3_ARTIFACT_DIR','artifacts/materialization-m3')};
const out=dirOf('M4_ARTIFACT_DIR','artifacts/materialization-m4');mkdirSync(out,{recursive:true});
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const stagesOf=M=>packet.milestone_graphs[M].map(id=>packet.stages.find(s=>s.id===id));
// M1 scenarios are recorded under their fixture variant.
const M1_VARIANT={env_original_appearance:'original',env_reading_metadata:'metadata',env_legacy_missing_reading:'legacy'};
const bundles={
 M1:{evidence:'EVIDENCE.json',capabilities:'CAPABILITIES.json',plan:s=>`plans-${M1_VARIANT[s]}.json`,tower:(s,i)=>`tower-${M1_VARIANT[s]}-${i}.json`,lists:['fixed','towers']},
 M2:{evidence:'EVIDENCE.json',capabilities:'CAPABILITIES.json',plan:s=>`plans-${s}.json`,tower:(s,i)=>`tower-${s}-${i}.json`,lists:['fixed','towers','refusalBranches']},
 M3:{evidence:'M3-TOWERS.json',capabilities:'M3-CAPABILITIES.json',plan:s=>`m3-plans-${s}.json`,tower:(s,i)=>`m3-tower-${s}-${i}.json`,lists:['fixed','towers','faults']},
};
// The M3 runner compares records without host diagnostics; the other runners keep none.
const strip=records=>records.map(r=>{if(!r.actual||typeof r.actual!=='object')return r;const {diagnostics:_d,...actual}=r.actual;return {...r,actual};});
const report={format:'rhizomatic.materialization-m4-cumulative/1',bundles:{},threeSeeded:{},fixedRoutes:{},integrity:{},capability:{},oracle:{},replay:{},harness:{}};
const evidenceOf=M=>read(join(dirs[M],bundles[M].evidence)),capabilitiesOf=M=>read(join(dirs[M],bundles[M].capabilities));
const buildsOf=M=>evidenceOf(M).builds??Object.fromEntries(capabilitiesOf(M).witnesses.filter(w=>w.state==='supported').map(w=>[w.id,w.buildId]));

// ---- Fixed routes: parse "w:stage[/suffix] -> ..." into stage -> witness. A suffix shares the
// first name's prefix ("control-execute/export" names control-execute and control-export).
export function parseRoute(route){
 const assignment={};
 for(const token of route.split('->').map(t=>t.trim())){
  const [witness,names]=token.split(':'),[first,...rest]=names.split('/'),prefix=first.slice(0,first.lastIndexOf('-')+1);
  assignment[first]=witness;for(const r of rest)assignment[prefix+r]=witness;
 }
 return assignment;
}
// A fixed route is executable only when every witness it names supports that stage's contract.
export function requireFixedRoutes(M,capabilities){
 for(const route of packet.fixed_routes[M])for(const [stage,witness]of Object.entries(parseRoute(route))){
  const contract=packet.stages.find(s=>s.id===stage)?.contract;assert.ok(contract,`unknown fixed-route stage ${stage}`);
  const w=capabilities.witnesses.find(x=>x.id===witness);
  assert.ok(w&&w.state==='supported'&&w.stages.includes(contract),`fixed route needs ${witness}:${stage}`);
 }
}

function checkIntegrity(M,evidence){
 let checked=0;
 for(const list of bundles[M].lists)for(const e of evidence[list]??[]){assert.equal(hash(join(dirs[M],e.artifact)),e.sha256,`${M} artifact ${e.artifact} changed`);checked++;}
 assert.ok(checked>0,`${M} retained no artifacts`);return checked;
}
for(const M of ['M1','M2','M3']){
 const b=bundles[M],evidence=evidenceOf(M),capabilities=capabilitiesOf(M),stages=stagesOf(M),builds=buildsOf(M);
 report.bundles[M]={dir:dirs[M],format:evidence.format,seed:evidence.seed,builds};
 // ---- Integrity: every retained artifact still hashes to its recorded digest.
 report.integrity[M]={artifacts:checkIntegrity(M,evidence)};
 // ---- Three seeded plans per required scenario, each mixed, each replayed exactly.
 report.threeSeeded[M]={};
 for(const scenario of packet.required_scenarios[M]){
  const bundle=read(join(dirs[M],b.plan(scenario)));
  validateReplayPlan(bundle,{stages,capabilities,availableBuilds:builds});
  assert.equal(bundle.plans.length,3,`${M} ${scenario} three plans`);
  for(const plan of bundle.plans){
   const tower=read(join(dirs[M],b.tower(scenario,plan.index)));
   assert.equal(canonicalJson(tower.plan),canonicalJson(plan),`${M} ${scenario} tower ${plan.index} ran its recorded plan`);
   assert.equal(canonicalJson(strip(M==='M1'?[tower.first]:tower.first)),canonicalJson(strip(M==='M1'?[tower.replay]:tower.replay)),`${M} ${scenario} tower ${plan.index} replays exactly`);
  }
  report.threeSeeded[M][scenario]={plans:3,distinct:bundle.distinctAssignments,repeats:bundle.plans.filter(p=>p.repeatedFrom!==null).map(p=>p.index)};
 }
 // ---- Both fixed routes for every required scenario.
 requireFixedRoutes(M,capabilities);
 const routes=packet.fixed_routes[M].map(parseRoute);
 report.fixedRoutes[M]={};
 for(const scenario of packet.required_scenarios[M]){
  const fixed=(evidence.fixed??[]).filter(e=>M==='M1'?e.variant===M1_VARIANT[scenario]:e.caseId===scenario);
  for(const route of routes){
   const found=fixed.some(e=>M==='M1'?e.write===route['envelope-write']&&e.read===route['envelope-read']:Object.entries(route).every(([s,w])=>e.assignment[s]===w));
   assert.ok(found,`${M} ${scenario} missing fixed route ${JSON.stringify(route)}`);
  }
  report.fixedRoutes[M][scenario]=routes.length;
 }
 // ---- tower_capability_refusal against the real manifest: each change must refuse at the gate.
 const plans=read(join(dirs[M],b.plan(packet.required_scenarios[M][0])));
 const refuse=(name,f,pattern)=>{assert.throws(f,pattern,`${M} ${name}`);(report.capability[M]??={})[name]='refused';};
 for(const id of ['elixir','haskell']){const w=capabilities.witnesses.find(x=>x.id===id);assert.ok(w&&w.state==='not_implemented'&&w.stages.length===0,`${M} ${id} stays below this level`);}
 refuse('advertised-without-evidence',()=>{const c=structuredClone(capabilities);c.witnesses.find(w=>w.id==='ts').stage_evidence[stages[0].contract]=[];planTowers({seed:'m4',scenario:'probe',stages,capabilities:c});},/missing executed stage cases/);
 refuse('unverified-upper-witness',()=>{const c=structuredClone(capabilities);c.witnesses.find(w=>w.id==='elixir').stages=[stages[0].contract];planTowers({seed:'m4',scenario:'probe',stages,capabilities:c});},/unverified capability advertised/);
 refuse('upper-witness-assignment',()=>{const p=structuredClone(plans);p.plans[0].assignments[0]={...p.plans[0].assignments[0],witness:'elixir',buildId:'elixir-l0'};const {planFingerprint:_f,...body}=p;p.planFingerprint=fingerprint(body);validateReplayPlan(p,{stages,capabilities,availableBuilds:{...builds,elixir:'elixir-l0'}});},/ineligible replay capability/);
 refuse('deleted-mixed-port',()=>{const c=structuredClone(capabilities),rust=c.witnesses.find(w=>w.id==='rust'),[stage]=Object.entries(routes[0]).find(([,w])=>w==='rust'),contract=packet.stages.find(s=>s.id===stage).contract;rust.stages=rust.stages.filter(x=>x!==contract);delete rust.stage_evidence[contract];requireFixedRoutes(M,c);},/fixed route needs rust/);
 refuse('missing-recorded-build',()=>{const {rust:_r,...rest}=builds;validateReplayPlan(plans,{stages,capabilities,availableBuilds:rest});},/pinned replay build unavailable/);
 refuse('stale-build',()=>validateReplayPlan(plans,{stages,capabilities,availableBuilds:{...builds,ts:'stale'}}),/pinned replay build/);
 refuse('modified-replay-plan',()=>{const p=structuredClone(plans);p.seed+='changed';validateReplayPlan(p,{stages,capabilities,availableBuilds:builds});},/fingerprint/);
 report.harness[M]=evidence.harnessNegatives;
}

// ---- Independent oracle over retained towers. M1: produced envelopes equal the shared vector.
// M2: the final readback equals the corpus golden. M3: every restore and read outcome equals the
// schedule's signed expectation.
{
 const vectors=read(join(root,'vectors/materialization/evidence-envelope.json'));
 let n=0;for(const [scenario,variant]of Object.entries(M1_VARIANT)){const v=vectors.positives.find(p=>p.variant===variant);for(let i=0;i<3;i++){const t=read(join(dirs.M1,bundles.M1.tower(scenario,i)));assert.equal(t.first.produced.envelopeHex,v.envelopeHex,`M1 ${scenario} oracle`);assert.equal(t.first.received.envelopeHex,v.envelopeHex);n++;}}
 report.oracle.M1={towers:n};
}
const corpus=read(join(root,'vectors/materialization/commands.json'));
const M2_FIXTURE={cmd_gather_resolve_fresh:'plant',cmd_three_times:'three_times_definition_900',cmd_nested_local_bindings:'nested_local',cmd_source_authority_change:'same_rows_changed_authority',cmd_error_priority:'request_pointers_exact',cmd_resolve_embedded_closure:'embedded_three_originals',cmd_authority_capture_validity:'new_observation_same_revision',cmd_public_basis_privacy:'private_provenance'};
assert.deepEqual(Object.keys(M2_FIXTURE).sort(),packet.required_scenarios.M2.slice().sort());
const finalOf=(scenario,i)=>read(join(dirs.M2,bundles.M2.tower(scenario,i))).first.at(-1);
const golden=scenario=>corpus.positives.find(f=>f.id===M2_FIXTURE[scenario]).expected.resolveBodyHex;
// Agreement compares the towers with each other; the oracle compares each with the shared golden.
// The towers ran different witnesses; agreement compares the reported answer, not who reported it.
const agree=finals=>finals.every(f=>f.stage===finals[0].stage&&canonicalJson(f.actual)===canonicalJson(finals[0].actual));
const oracleRed=(scenario,finals)=>finals.filter(f=>f.stage!=='read-result'||f.actual.bodyHex!==golden(scenario)).length;
{
 const m2={};
 for(const scenario of packet.required_scenarios.M2){const finals=[0,1,2].map(i=>finalOf(scenario,i));assert.ok(agree(finals),`M2 ${scenario} towers agree`);assert.equal(oracleRed(scenario,finals),0,`M2 ${scenario} oracle`);m2[scenario]='agree+oracle';}
 report.oracle.M2=m2;
}
{
 const schedule=read(join(root,'vectors/materialization/lifecycle.json'));
 const expected=id=>schedule.steps.find(s=>s.id===id)?.expected.outcome;
 let n=0;
 for(const scenario of packet.required_scenarios.M3)for(let i=0;i<3;i++){
  for(const r of read(join(dirs.M3,bundles.M3.tower(scenario,i))).first){
   // Most crossings record a step ID; the rotation crossing records the step itself.
   const step=typeof r.input?.step==='string'?r.input.step:r.input?.step?.id;
   if(!['control-restore','control-read'].includes(r.stage)||!r.actual?.outcome||!step||r.input.mode!==r.stage)continue;
   assert.deepEqual(r.actual.outcome,expected(step),`M3 ${scenario} tower ${i} ${r.stage} ${step} oracle`);n++;
  }
 }
 report.oracle.M3={outcomes:n};
}
// ---- tower_wrong_shared_oracle: every tower reports height 99 where the fixture specifies 42.
// The towers still agree with each other, and the independent oracle turns all three red.
{
 const scenario='cmd_gather_resolve_fresh',HEIGHT_42='f95140',HEIGHT_99='f95630';
 const finals=[0,1,2].map(i=>finalOf(scenario,i));
 assert.ok(finals.every(f=>f.actual.bodyHex.split(HEIGHT_42).length===2),'the readback reports height 42 once');
 const wrong=finals.map(f=>({...f,actual:{...f.actual,bodyHex:f.actual.bodyHex.replace(HEIGHT_42,HEIGHT_99)}}));
 assert.ok(agree(wrong),'a common wrong answer still agrees across towers');
 assert.equal(oracleRed(scenario,wrong),3,'the independent oracle turns all three towers red');
 report.oracle.wrongShared={scenario,reported:99,specified:42,agreement:'passes',oracleRed:3};
}

// ---- tower_exact_replay: the M3 runner replays one retained scenario without a seed reroll.
// An intact bundle reproduces; a bundle with one changed recorded byte refuses clearly.
{
 const scenario='ctl_cross_witness_restore',tmp=join(out,'replay-probe');rmSync(tmp,{recursive:true,force:true});
 const replay=(bundle,label)=>spawnSync('node',['tools/check-materialization-m3-towers.mjs','--replay',bundle],{cwd:root,encoding:'utf8',maxBuffer:50*1024*1024,env:{...process.env,M3_ONLY:scenario,M3_ARTIFACT_DIR:join(tmp,label),M3_SEED:evidenceOf('M3').seed}});
 const intact=replay(dirs.M3,'intact');assert.equal(intact.status,0,'intact replay: '+intact.stderr);
 const mutated=join(tmp,'mutated-bundle');cpSync(dirs.M3,mutated,{recursive:true,filter:src=>!src.includes('/stores')});
 const artifact=join(mutated,bundles.M3.tower(scenario,0)),doc=read(artifact);
 const outcome=doc.first.find(r=>r.stage==='control-read').actual.outcome;outcome.sig=outcome.sig.replace(/^./,c=>c==='0'?'1':'0');
 writeFileSync(artifact,canonicalJson(doc)+'\n');
 const changed=replay(mutated,'mutated');assert.notEqual(changed.status,0,'a changed retained artifact must not replay');
 assert.match(changed.stderr,/retained exact replay/,'the refusal names the retained replay');
 report.replay={scenario,intact:'reproduced',mutated:'refused: retained exact replay',missingBuild:'refused: pinned replay build unavailable'};
 rmSync(tmp,{recursive:true,force:true});
}

// ---- The named harness failure proofs each runner must carry (CI.md "Harness failure proofs").
const requiredNegatives={
 M1:['common-wrong-artifact','stale-build','modified-replay-plan','unsupported-stage','missing-stage-evidence','modified-replay-artifact'],
 M2:['common-wrong-artifact','stale-build','modified-replay-plan','unsupported-stage','missing-stage-evidence','modified-replay-artifact','corrupt-signed-delivery'],
 M3:['wrong-outcome','wrong-directory','stale-build','modified-replay-plan','unsupported-stage','missing-stage-evidence','receiving-corruption','tower-isolation'],
};
for(const M of ['M1','M2','M3'])for(const n of requiredNegatives[M])assert.ok(report.harness[M].includes(n),`${M} runner lacks harness proof ${n}`);
const m3=evidenceOf('M3');
assert.ok(m3.receivingCorruption?.length===4&&m3.receivingCorruption.every(r=>r.edges.length===2),'M3 receiving corruption covers both edges in both directions');
assert.ok(m3.isolation?.leakDetected===true&&m3.isolation.unchanged.length===2,'M3 tower isolation');
assert.ok(evidenceOf('M1').receivingCorruption?.length>0,'M1 receiving corruption');
report.corruption={M1:evidenceOf('M1').receivingCorruption.length,M2:evidenceOf('M2').negative.filter(n=>n.name==='corrupt-signed-delivery').length,M3:m3.receivingCorruption};
report.isolation=m3.isolation;

// ---- Sensitivity of this gate: a changed artifact digest and a missing fixed route must refuse.
{
 const e=structuredClone(evidenceOf('M3'));e.towers[0].sha256='0'.repeat(64);
 assert.throws(()=>checkIntegrity('M3',e),/artifact .* changed/);
 const caps=capabilitiesOf('M2');assert.doesNotThrow(()=>requireFixedRoutes('M2',caps));
 const broken=structuredClone(caps);broken.witnesses.find(w=>w.id==='ts').stages=[];broken.witnesses.find(w=>w.id==='ts').stage_evidence={};
 assert.throws(()=>requireFixedRoutes('M2',broken),/fixed route needs ts/);
}
// ---- nested_resource_baseline: the M2 batch report (nested Bed fixture and source sweep) and the
// M4 lifecycle report (install, replacement, fresh restore and read across the sweep), each with
// both witnesses' byte accounting in agreement and the over-limit size refused before any check.
{
 const m2=read(join(dirs.M2,'MEASUREMENTS.json')),life=read(join(out,'MEASUREMENTS-LIFECYCLE.json'));
 const sweep=[0,128,1024,4096,4097];
 assert.deepEqual(m2.rows.map(r=>r.id).sort(),['bed_32x4_two_levels',...sweep.map(n=>'source_'+n)].sort(),'M2 batch measurement rows');
 for(const r of m2.rows)assert.deepEqual(r.measurements.map(m=>m.witness),['ts','rust-release'],r.id+' both witnesses');
 assert.deepEqual(life.rows.map(r=>r.selectedAppearances),sweep,'lifecycle sweep sizes');
 for(const r of life.rows){
  assert.deepEqual(r.measurements.map(m=>m.witness),['ts','rust'],r.id+' both witnesses');
  const [ts,rust]=r.measurements;
  assert.deepEqual(ts.steps.map(x=>[x.phase,x.lengths]),rust.steps.map(x=>[x.phase,x.lengths]),r.id+' byte accounting agrees');
  for(const m of r.measurements)for(const x of m.steps)for(const phase of ['boot',x.phase])assert.ok(Number.isFinite(x.phases[phase]?.wallMs)&&Number.isInteger(x.phases[phase]?.strictSignatureVerifications),`${r.id} ${m.witness} ${x.id} ${phase} measured`);
  if(r.selectedAppearances>4096)assert.ok(r.measurements.every(m=>m.steps.length===1&&m.steps[0].status==='refused'&&m.steps[0].currentChecks===0),r.id+' refused before any source check');
  else assert.ok(r.measurements.every(m=>m.steps.every(x=>x.status==='completed')&&m.steps.some(x=>x.phase==='restore')&&m.steps.some(x=>x.phase==='read')),r.id+' completes install, restore and read');
 }
 assert.deepEqual(life.boundaries.pairs.map(b=>b.limit),['deliveryBytes','artifactBytes','requestPointers'],'exact and one-over boundary pairs named');
 report.measurements={batchRows:m2.rows.map(r=>r.id),lifecycleRows:life.rows.map(r=>({id:r.id,phases:r.measurements[0].steps.map(x=>x.phase)})),boundaries:life.boundaries,deferred:life.deferred};
}
// ---- existing_conformance_gates: in CI the job needs every existing gate of the same run and
// records their results; a local run cannot produce this evidence and says so.
const git=args=>spawnSync('git',args,{cwd:root,encoding:'utf8'}).stdout.trim();
const head=git(['rev-parse','HEAD']);
let gates;
if(process.env.CI_RESULTS){
 assert.equal(process.env.CI_COMMIT,head,'CI checkout matches the gated commit');
 const results=JSON.parse(process.env.CI_RESULTS);
 for(const job of ['typescript','rust','haskell','elixir','command','materialization-m1','materialization-m2','materialization-m3'])assert.equal(results[job]?.result,'success',`required gate ${job}`);
 gates={status:'passed',commit:head,jobs:Object.fromEntries(Object.entries(results).map(([k,v])=>[k,v.result]))};
}else gates={status:'not-run-locally',reason:'the existing gates are the CI jobs of one run; run this checker in the materialization-m4 job'};
report.existingGates=gates;
writeFileSync(join(out,'M4-CUMULATIVE.json'),JSON.stringify(report,null,2)+'\n');
// ---- The case ledger allocates exactly M4's required cases; the report never upgrades a case.
const m4=read(join(root,'contracts/materialization/M4-CASES.json'));
const required=read(join(root,'contracts/materialization/MILESTONES.json')).milestones.find(m=>m.id==='M4').required_cases;
assert.deepEqual(m4.cases.map(c=>c.id).sort(),[...required].sort(),'M4 ledger allocation');
for(const c of m4.cases){assert.ok(['executed','specified'].includes(c.state),c.id);assert.equal(c.state==='specified',c.evidence.length===0,c.id+' evidence matches state');if(c.state!=='executed')assert.ok(c.remaining,c.id+' names what remains');}
const status=c=>c.state==='specified'?'not-run':c.id==='existing_conformance_gates'&&gates.status!=='passed'?'not-run-locally':'passed';
writeFileSync(join(out,'REPORT.json'),JSON.stringify({format:'rhizomatic-conformance-report/1',profile:'rhizomatic.materialization/1',milestone:'M4',source:{commit:head,tree:git(['rev-parse','HEAD^{tree}']),clean:git(['status','--porcelain','--untracked-files=normal'])===''},bundles:report.bundles,cases:m4.cases.map(c=>({id:c.id,state:c.state,status:status(c)})),not_claimed:['release B','M5 Loam trial','source/control atomicity','execution proof','production adapter durability']},null,2)+'\n');
const scenarios=Object.values(report.threeSeeded).reduce((n,m)=>n+Object.keys(m).length,0);
console.log(`M4 cumulative: ${scenarios} required scenarios with three replayed plans and both fixed routes; ${Object.values(report.integrity).reduce((n,x)=>n+x.artifacts,0)} retained artifacts intact; capability, oracle, replay and harness probes refused as required; ${out}`);
