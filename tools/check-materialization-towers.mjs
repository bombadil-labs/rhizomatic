// M2 fresh-process boundaries. Goldens are independent hand-constructed native views, not wrapper agreement.
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {planTowers,validateReplayPlan,canonicalJson,fingerprint} from './command-tower-plan.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const corpus=JSON.parse(readFileSync(join(root,'vectors/materialization/commands.json')));
const packet=JSON.parse(readFileSync(join(root,'contracts/materialization/TOWERS.json')));
const stages=packet.milestone_graphs.M2.map(id=>packet.stages.find(s=>s.id===id));
const adapter=join(root,'implementations/ts/tools/materialization-fixture.ts'),tsx=join(root,'implementations/ts/node_modules/.bin/tsx');
const built=spawnSync(process.env.CARGO??'cargo',['build','--locked','--manifest-path','implementations/rust/Cargo.toml','--example','materialization_fixture','--message-format=json'],{cwd:root,encoding:'utf8',maxBuffer:20*1024*1024});assert.equal(built.status,0,built.stderr);
const binaries=built.stdout.trim().split('\n').filter(Boolean).map(JSON.parse).filter(m=>m.reason==='compiler-artifact'&&m.target?.name==='materialization_fixture'&&m.executable);
assert.equal(binaries.length,1,'exact Cargo executable');const rust=binaries[0].executable;
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const files=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]).sort();
const src=join(root,'implementations/ts/src');
const builds={ts:'ts-source:'+fingerprint(files(src).map(p=>[p.slice(src.length+1),hash(p)]).concat([['adapter',hash(adapter)],['lock',hash(join(root,'implementations/ts/package-lock.json'))],['node',process.version]])),rust:'rust-binary:'+hash(rust)};
const selection={cmd_gather_resolve_fresh:'plant',cmd_three_times:'three_times_definition_900',cmd_nested_local_bindings:'nested_local',cmd_source_authority_change:'same_rows_changed_authority',cmd_error_priority:'request_pointers_exact',cmd_resolve_embedded_closure:'embedded_three_originals',cmd_authority_capture_validity:'new_observation_same_revision',cmd_public_basis_privacy:'private_provenance'};
assert.deepEqual(Object.keys(selection).sort(),packet.required_scenarios.M2.slice().sort());
const capabilities={format:'rhizomatic-command-capabilities/1',witnesses:['ts','rust'].map(id=>({id,state:'supported',buildId:builds[id],profiles:[],stages:[...new Set(stages.map(s=>s.contract))],stage_evidence:Object.fromEntries(stages.map(s=>[s.contract,Object.keys(selection)]))})).concat(['elixir','haskell'].map(id=>({id,state:'not_implemented',stages:[],profiles:[]})))};
const out=resolve(process.env.M2_ARTIFACT_DIR??join(root,'artifacts/materialization-m2'));mkdirSync(out,{recursive:true});
const replayIndex=process.argv.indexOf('--replay'),replayDir=replayIndex<0?null:resolve(process.argv[replayIndex+1]);
const run=(w,input)=>{const r=spawnSync(w==='ts'?tsx:rust,w==='ts'?[adapter]:[],{cwd:root,input:JSON.stringify(input),encoding:'utf8',maxBuffer:40*1024*1024});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
const evidence={format:'rhizomatic.materialization-m2-executed/1',scope:'M2 batch ports only; no lifecycle/native stack interchangeability/execution proof',seed:process.env.M2_SEED??'M2-2026-10-05',builds,toolchains:{node:process.version,rust:spawnSync(process.env.RUSTC??'rustc',['--version','--verbose'],{encoding:'utf8'}).stdout.trim()},fixed:[],towers:[],negative:[],caseIds:['cmd_fixed_mixed_routes::batch']};
function validateStage(mode,f,actual){
 if(mode==='construct'){assert.deepEqual(actual.request,f.request);assert.deepEqual(actual.delivery,f.delivery);}
 if(mode==='gather'){
  assert.deepEqual(actual.outcome,f.expected.gather);assert.deepEqual(actual.preflight,{status:'input-valid'});
  assert.equal(actual.calls.length,2);assert.deepEqual(actual.calls[0],actual.calls[1]);assert.deepEqual(actual.calls[0].support,f.source.requiredSupport);assert.equal(actual.calls[0].at,f.receivedAt??1000);
 }
 if(mode==='wrap-evidence'){assert.deepEqual(actual.request,f.resolve);assert.deepEqual(actual.delivery,f.resolveDelivery);}
 if(mode==='resolve'){assert.deepEqual(actual.outcome,f.expected.resolve);assert.deepEqual(actual.preflight,{status:'input-valid'});}
 if(mode==='read-result')assert.deepEqual(actual,{status:'completed',classification:'verified-context',sourceCommitments:'commitments-verified',receiverTestimony:true,executionVerified:false,bodyHex:f.expected.resolveBodyHex});
}
function crossing(f,assignments){
 // Expected bytes do not enter either host/adapter.
 const {expected,...data}=f;const fixture={...data,boot:f.boot??corpus.boot,seeds:corpus.seeds};
 let upstream=null;const records=[];
 for(const s of stages){const witness=assignments[s.id],input={mode:s.id,fixture,upstream};const actual=run(witness,input);validateStage(s.id,f,actual);records.push({stage:s.id,witness,input,actual});upstream=actual;}
 return records;
}
const fixed=[['ts','rust','ts','ts','rust'],['rust','ts','rust','rust','ts']].map(ws=>Object.fromEntries(stages.map((s,i)=>[s.id,ws[i]])));
for(const [caseId,fixtureId]of Object.entries(selection)){
 const f=corpus.positives.find(f=>f.id===fixtureId);assert.ok(f,fixtureId);
 for(let i=0;i<fixed.length;i++){const records=crossing(f,fixed[i]),path=`fixed-${caseId}-${i}.json`;writeFileSync(join(out,path),canonicalJson({caseId,fixtureId,assignment:fixed[i],records})+'\n');evidence.fixed.push({caseId,fixtureId,assignment:fixed[i],artifact:path,sha256:hash(join(out,path))});}
 const plans=replayDir?JSON.parse(readFileSync(join(replayDir,`plans-${caseId}.json`))):planTowers({seed:evidence.seed,scenario:caseId,stages,capabilities});validateReplayPlan(plans,{stages,capabilities,availableBuilds:builds});
 writeFileSync(join(out,`plans-${caseId}.json`),canonicalJson(plans)+'\n');
 for(const plan of plans.plans){const assignments=Object.fromEntries(plan.assignments.map(a=>[a.stage,a.witness]));const first=crossing(f,assignments);const path=`tower-${caseId}-${plan.index}.json`;
  if(replayDir){const prior=JSON.parse(readFileSync(join(replayDir,path)));assert.equal(canonicalJson(prior.first),canonicalJson(first),'retained exact replay');}
  const replay=crossing(f,assignments);assert.equal(canonicalJson(first),canonicalJson(replay),'deterministic stage replay');
  writeFileSync(join(out,path),canonicalJson({plan,first,replay})+'\n');evidence.towers.push({caseId,fixtureId,plan,artifact:path,sha256:hash(join(out,path))});
 }
 console.log(`M2 ${caseId}: both fixed directions + three towers/replay`);
}
// Refusal terminates the graph at gather; read the signed refusal in a fresh receiving process.
// Downstream evidence/resolve ports cannot consume a refusal and are deliberately never dispatched.
evidence.refusalBranches=[];
for(const id of ['reflective_top','request_pointers_over','snapshot_count_before_bad_row']){
 const n=corpus.negatives.find(f=>f.id===id),base=corpus.positives.find(f=>f.id===(n.fixtureSourceId??'plant'));
 const fixture={...base,request:n.request,delivery:n.delivery,source:n.source,boot:n.boot??corpus.boot,seeds:corpus.seeds};delete fixture.expected;
 function branch(assignment){
  const records=[];let upstream=null;
  for(const stage of ['construct','gather','read-result']){
   const w=assignment[stage],actual=run(w,{mode:stage,fixture,upstream});
   if(stage==='construct'){assert.deepEqual(actual.request,n.request);assert.deepEqual(actual.delivery,n.delivery);}
   if(stage==='gather'){
    assert.deepEqual(actual.outcome,n.expected.outcome);
    const code=n.expected.preflight??n.expected.code;
    assert.deepEqual(actual.preflight,code==='resource-limit'?{status:'over-input-limit',code}:{status:'invalid-input',code});
   }
   if(stage==='read-result')assert.deepEqual(actual,{status:'refused',classification:'verified-context',sourceCommitments:'attested',receiverTestimony:true,executionVerified:false,bodyHex:Buffer.from(n.expected.outcome.claims.pointers.find(p=>p.role==='rhizomatic.materialization.result').target.value,'base64url').toString('hex')});
   records.push({stage,witness:w,actual});upstream=actual;
  }
  return records;
 }
 const plans=JSON.parse(readFileSync(join(out,'plans-cmd_error_priority.json'))).plans;
 const assignments=[...fixed,...plans.map(p=>Object.fromEntries(p.assignments.map(a=>[a.stage,a.witness])))];
 for(let i=0;i<assignments.length;i++){
  const first=branch(assignments[i]),replay=branch(assignments[i]);assert.equal(canonicalJson(first),canonicalJson(replay));
  const path=`refusal-${id}-${i}.json`;const record={fixtureId:id,assignment:assignments[i],termination:'gather refusal, then contextual readback; no wrap/resolve dispatch',first,replay};
  if(replayDir)assert.equal(canonicalJson(JSON.parse(readFileSync(join(replayDir,path))).first),canonicalJson(first),'retained refusal replay');
  writeFileSync(join(out,path),canonicalJson(record)+'\n');evidence.refusalBranches.push({fixtureId:id,artifact:path,sha256:hash(join(out,path))});
 }
}
const f=corpus.positives.find(f=>f.id==='plant'),fixture={...f,boot:corpus.boot,seeds:corpus.seeds};delete fixture.expected;
const constructed=run('ts',{mode:'construct',fixture});
for(const w of ['ts','rust']){
 const broken=structuredClone(constructed);broken.delivery[0].sig='00'.repeat(64);
 const refused=run(w,{mode:'gather',fixture,upstream:broken});const golden=corpus.negatives.find(f=>f.id==='invalid_duplicate').expected.outcome;
 // That vector retains the same request id, receive time and configuration; invalid signature refuses before dedup/dispatch.
 assert.deepEqual(refused.outcome,golden);assert.deepEqual(refused.calls,[]);evidence.negative.push({name:'corrupt-signed-delivery',witness:w,actual:refused});
}
const good=run('ts',{mode:'gather',fixture,upstream:constructed}),wrong=structuredClone(good);wrong.outcome=corpus.positives.find(f=>f.id==='empty').expected.gather;
assert.throws(()=>validateStage('gather',f,wrong),/Expected values/);
const plans=JSON.parse(readFileSync(join(out,'plans-cmd_gather_resolve_fresh.json')));
assert.throws(()=>validateReplayPlan(plans,{stages,capabilities,availableBuilds:{...builds,ts:'stale'}}),/pinned replay build/);
const tampered=structuredClone(plans);tampered.seed+='changed';assert.throws(()=>validateReplayPlan(tampered,{stages,capabilities,availableBuilds:builds}),/fingerprint/);
const unsupported=structuredClone(capabilities);for(const w of unsupported.witnesses){w.state='not_implemented';w.stages=[];w.profiles=[];}assert.throws(()=>planTowers({seed:'negative',scenario:'unsupported',stages,capabilities:unsupported}),/unsupported required stage/);
const missing=structuredClone(capabilities);delete missing.witnesses[0].stage_evidence[stages[0].contract];assert.throws(()=>planTowers({seed:'negative',scenario:'missing',stages,capabilities:missing}),/stage evidence/);
const broken=structuredClone(good);broken.outcome.sig='00'.repeat(64);assert.throws(()=>validateStage('gather',f,broken),/Expected values/);
evidence.harnessNegatives=['common-wrong-artifact','stale-build','modified-replay-plan','unsupported-stage','missing-stage-evidence','modified-replay-artifact','corrupt-signed-delivery'];
writeFileSync(join(out,'CAPABILITIES.json'),JSON.stringify(capabilities,null,2)+'\n');writeFileSync(join(out,'EVIDENCE.json'),JSON.stringify(evidence,null,2)+'\n');
console.log(`M2 crossings: ${evidence.fixed.length} fixed, ${evidence.towers.length} seeded towers + exact replay; ${evidence.harnessNegatives.length} sensitivity negatives; ${out}`);
