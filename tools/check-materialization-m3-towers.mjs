// M3 fresh-process crossings over durable directories. Every stage starts a new witness process;
// only the schedule's signed descriptions, the exported image bytes and the readback cross.
// Faults name one MR-18 point each; the directory after the fault is the oracle, never a retry.
import {readFileSync,writeFileSync,mkdirSync,readdirSync,rmSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {planTowers,validateReplayPlan,canonicalJson,fingerprint} from './command-tower-plan.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const schedule=JSON.parse(readFileSync(join(root,'vectors/materialization/lifecycle.json')));
const packet=JSON.parse(readFileSync(join(root,'contracts/materialization/TOWERS.json')));
const stages=packet.milestone_graphs.M3.map(id=>packet.stages.find(s=>s.id===id));
const adapter=join(root,'implementations/ts/tools/materialization-fixture.ts'),tsx=join(root,'implementations/ts/node_modules/.bin/tsx');
const built=spawnSync(process.env.CARGO??'cargo',['build','--locked','--manifest-path','implementations/rust/Cargo.toml','--example','materialization_fixture','--message-format=json'],{cwd:root,encoding:'utf8',maxBuffer:20*1024*1024});assert.equal(built.status,0,built.stderr);
const binaries=built.stdout.trim().split('\n').filter(Boolean).map(JSON.parse).filter(m=>m.reason==='compiler-artifact'&&m.target?.name==='materialization_fixture'&&m.executable);
assert.equal(binaries.length,1,'exact Cargo executable');const rust=binaries[0].executable;
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const files=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]).sort();
const src=join(root,'implementations/ts/src');
const builds={ts:'ts-source:'+fingerprint(files(src).map(p=>[p.slice(src.length+1),hash(p)]).concat([['adapter',hash(adapter)],['lock',hash(join(root,'implementations/ts/package-lock.json'))],['node',process.version]])),rust:'rust-binary:'+hash(rust)};
const out=resolve(process.env.M3_ARTIFACT_DIR??join(root,'artifacts/materialization-m3'));mkdirSync(out,{recursive:true});
const stores=join(out,'stores');rmSync(stores,{recursive:true,force:true});mkdirSync(stores,{recursive:true});
const replayIndex=process.argv.indexOf('--replay'),replayDir=replayIndex<0?null:resolve(process.argv[replayIndex+1]);
const role='rhizomatic.materialization.';
const verbs=new Map(schedule.boot.declarations.map(d=>[d.id,d.claims.pointers.find(p=>p.role===role+'name')?.target?.id?.slice(role.length)]));
const fixture={boot:schedule.boot,seeds:schedule.seeds,keys:schedule.keys,source:schedule.source};
const stepOf=id=>{const s=schedule.steps.find(s=>s.id===id);assert.ok(s,id);return {...s,verb:verbs.get(s.request.claims.pointers.find(p=>p.role===role+'operation').target.delta)};};
// A step may name its own source, receive time or no grant; the hosts read those from the fixture.
const fixtureFor=step=>({...fixture,source:step.source??schedule.source,...(step.receivedAt?{receivedAt:step.receivedAt}:{}),...(step.noGrant?{noGrant:true}:{})});
const kindOf=d=>d.claims.pointers.find(p=>p.role===role+'kind')?.target;
const delivered=(step,kind)=>step.delivery.find(d=>kindOf(d)===kind);
const install=stepOf('install');
const bodyOf=step=>Buffer.from(step.expected.outcome.claims.pointers.find(p=>p.role===role+'result').target.value,'base64url').toString('hex');
// Canonical CBOR of the two indeterminate bodies and the control-rejected refusal (MR-19).
const tstr=s=>Buffer.concat([Buffer.from([s.length<24?0x60+s.length:0x78,...(s.length<24?[]:[s.length])]),Buffer.from(s)]);
const cborMap=entries=>Buffer.concat([Buffer.from([0xa0+entries.length]),...entries.flatMap(([k,v])=>[tstr(k),tstr(v)])]).toString('hex');
let counter=0;const freshDir=label=>{const dir=join(stores,`${String(++counter).padStart(3,'0')}-${label}`);mkdirSync(dir,{recursive:true});return dir;};
const run=(w,input)=>{
 const r=spawnSync(w==='ts'?tsx:rust,w==='ts'?[adapter]:[],{cwd:root,input:JSON.stringify(input),encoding:'utf8',maxBuffer:40*1024*1024});
 return {status:r.status,output:r.status===0?JSON.parse(r.stdout):null,stderr:r.stderr};
};
const must=(w,input)=>{const r=run(w,input);assert.equal(r.status,0,`${w} ${input.mode}: ${r.stderr}`);return r.output;};
// Directory names carry a run counter, so records keep the logical side (a or b), never the path.
const record=(records,stage,witness,input,actual)=>{const {store,...rest}=input;records.push({stage,witness,input:{...rest,...(store?{store:store.dir.endsWith('-b')?'b':'a'}:{})},actual});};
function expectExecuted(actual,step){assert.deepEqual(actual.outcome,step.expected.outcome);assert.deepEqual(actual.preflight,{status:'input-valid'});assert.equal(actual.store.bytesHex,step.expected.controlHex);for(const c of actual.calls)assert.deepEqual([c.binding,c.revision,c.authority],[schedule.source.binding,schedule.source.revision,schedule.source.authority]);}
function expectReadback(actual,expected){assert.deepEqual(actual,{receiverTestimony:true,executionVerified:false,...expected});}
/**
 * One crossing: execute `first` (with an optional fault) on a fresh directory, export the
 * directory, restore the export in a second fresh directory with `restore`, read `read` there,
 * and read the read outcome back with the exported image. `after` names what the directory must
 * hold after the executing stage; a crash leaves no outcome and the directory decides.
 */
function crossing(a,plan,label){
 const {first,fault,after,restore,read,readback,extra=[]}=plan;const records=[];
 const dirA=freshDir(label+'-a');
 const constructed=must(a['construct'],{mode:'construct',fixture,step:first});
 assert.deepEqual(constructed.delivery.map(d=>d.id),first.delivery.map(d=>d.id));record(records,'construct',a['construct'],{mode:'construct',step:first.id},constructed);
 const executeInput={mode:'control-execute',fixture:fixtureFor(first),step:first,store:{dir:dirA},seed:true,upstream:constructed,...(fault?{fault:{kind:fault,...(plan.raced?{image:plan.raced}:{})}}:{})};
 const executed=run(a['control-execute'],executeInput);
 if(after.crash){assert.notEqual(executed.status,0,'a crashed host answers nothing');assert.equal(executed.output,null);}
 else{assert.equal(executed.status,0,executed.stderr);if(after.outcome)expectExecuted(executed.output,first);if(after.status){assert.equal(executed.output.outcome.claims.pointers.find(p=>p.role===role+'status').target,after.status);assert.equal(executed.output.store.bytesHex,after.controlHex);}}
 const {upstream:_u,...executeRecord}=executeInput;record(records,'control-execute',a['control-execute'],executeRecord,executed.output??{crashed:true,status:executed.status});
 const exported=must(a['control-export'],{mode:'control-export',fixture,store:{dir:dirA}});
 assert.equal(exported.bytesHex,after.controlHex,'the directory after the stage is the oracle');record(records,'control-export',a['control-export'],{mode:'control-export'},exported);
 const dirB=freshDir(label+'-b');
 const restored=must(a['control-restore'],{mode:'control-restore',fixture,step:restore,store:{dir:dirB},upstream:exported});
 assert.deepEqual(restored.outcome,restore.expected.outcome);assert.equal(restored.store.bytesHex,after.controlHex);record(records,'control-restore',a['control-restore'],{mode:'control-restore',step:restore.id},restored);
 const readOut=must(a['control-read'],{mode:'control-read',fixture:fixtureFor(read),step:read,store:{dir:dirB}});
 assert.deepEqual(readOut.outcome,read.expected.outcome);record(records,'control-read',a['control-read'],{mode:'control-read',step:read.id},readOut);
 const snapshot=delivered(read,'snapshot/1'),capture=delivered(read,'capture/1')??delivered(install,'capture/1');
 const resultInput={mode:'control-result',fixture,upstream:readOut,control:exported,...(snapshot?{capture,snapshot}:{})};
 const result=must(a['control-result'],resultInput);expectReadback(result,readback);record(records,'control-result',a['control-result'],{mode:'control-result',step:read.id},result);
 for(const e of extra){const o=must(a['control-read'],{mode:'control-execute',fixture:fixtureFor(e.step),step:e.step,store:{dir:dirB}});assert.deepEqual(o.outcome,e.step.expected.outcome);assert.equal(o.store.bytesHex,after.controlHex);record(records,'control-read',a['control-read'],{mode:'control-execute',step:e.step.id},o);}
 if(!after.crash&&after.status){const r=must(a['control-result'],{mode:'control-result',fixture,upstream:executed.output,control:exported});expectReadback(r,{status:after.status,classification:'verified-context',sourceCommitments:'attested',bodyHex:after.bodyHex});record(records,'control-result',a['control-result'],{mode:'control-result',step:first.id},r);}
 return records;
}
const completed=(read,commitments=true)=>({status:'completed',classification:'verified-context',sourceCommitments:commitments?'commitments-verified':'attested',bodyHex:read.expected.bodyHex});
const refusedRead=read=>({status:'refused',classification:'verified-context',sourceCommitments:'attested',bodyHex:bodyOf(read)});
const S=id=>stepOf(id);
const r2=S('read_advanced').initialControl.revision;
const scenarios={
 ctl_cross_witness_restore:{first:S('install'),after:{outcome:true,controlHex:S('install').expected.controlHex},restore:S('restore_installed'),read:S('read_installed'),readback:completed(S('read_installed'))},
 ctl_uncertain_present:{first:S('advance_time'),fault:'unconfirmed-present',after:{status:'indeterminate',controlHex:S('advance_time').expected.controlHex,bodyHex:cborMap([['code','commit-unconfirmed']])},restore:S('restore_advanced'),read:S('read_advanced'),readback:completed(S('read_advanced'))},
 ctl_retired_restart:{first:S('retire'),fault:'crash-after-cas',after:{crash:true,controlHex:S('retire').expected.controlHex},restore:S('restore_retired'),read:S('read_retired'),readback:refusedRead(S('read_retired')),extra:[{step:S('install_retired')},{step:S('retire_retired')}]},
};
const faults={
 ctl_before_commit_crash:{first:S('advance_time'),fault:'crash-before-cas',after:{crash:true,controlHex:S('advance_time').initialControl.hex},restore:S('restore_installed'),read:S('read_installed'),readback:completed(S('read_installed'))},
 ctl_after_commit_crash:{first:S('advance_time'),fault:'crash-after-cas',after:{crash:true,controlHex:S('advance_time').expected.controlHex},restore:S('restore_advanced'),read:S('read_advanced'),readback:completed(S('read_advanced'))},
 ctl_uncertain_absent:{first:S('advance_time'),fault:'unconfirmed-absent',after:{status:'indeterminate',controlHex:S('advance_time').initialControl.hex,bodyHex:cborMap([['code','commit-unconfirmed']])},restore:S('restore_installed'),read:S('read_installed'),readback:completed(S('read_installed'))},
 ctl_known_rejection:{first:S('advance_time'),fault:'rejected',after:{status:'refused',controlHex:S('advance_time').initialControl.hex,bodyHex:cborMap([['code','control-rejected']])},restore:S('restore_installed'),read:S('read_installed'),readback:completed(S('read_installed'))},
 ctl_postcommit_rebuild_fault:{first:S('advance_time'),fault:'post-cas-result',after:{status:'indeterminate',controlHex:S('advance_time').expected.controlHex,bodyHex:cborMap([['code','result-unavailable'],['control',r2]])},restore:S('restore_advanced'),read:S('read_advanced'),readback:completed(S('read_advanced'))},
 ctl_postcommit_sign_delivery:{first:S('retire'),fault:'sign-failure',after:{crash:true,controlHex:S('retire').expected.controlHex},restore:S('restore_retired'),read:S('read_retired'),readback:refusedRead(S('read_retired'))},
 ctl_retire_uncertain_absent:{first:S('retire'),fault:'unconfirmed-absent',after:{status:'indeterminate',controlHex:S('retire').initialControl.hex,bodyHex:cborMap([['code','commit-unconfirmed']])},restore:S('restore_replaced'),read:S('read_replaced'),readback:completed(S('read_replaced'))},
 ctl_two_writers:{first:S('advance_time'),fault:'race',raced:{hex:S('advance_time').expected.controlHex,revision:r2},after:{status:'refused',controlHex:S('advance_time').expected.controlHex,bodyHex:cborMap([['code','write-conflict']])},restore:S('restore_advanced'),read:S('read_advanced'),readback:completed(S('read_advanced'))},
 ctl_retire_uncertain_present:{first:S('retire'),fault:'unconfirmed-present',after:{status:'indeterminate',controlHex:S('retire').expected.controlHex,bodyHex:cborMap([['code','commit-unconfirmed']])},restore:S('restore_retired'),read:S('read_retired'),readback:refusedRead(S('read_retired'))},
};
assert.equal(S('read_wrong_control').initialControl.hex,S('install').expected.controlHex);
const capabilities={format:'rhizomatic-command-capabilities/1',witnesses:['ts','rust'].map(id=>({id,state:'supported',buildId:builds[id],profiles:[],stages:[...new Set(stages.map(s=>s.contract))],stage_evidence:Object.fromEntries(stages.map(s=>[s.contract,Object.keys(scenarios)]))})).concat(['elixir','haskell'].map(id=>({id,state:'not_implemented',stages:[],profiles:[]})))};
const fixed=[['ts','ts','ts','rust','rust','ts'],['rust','rust','rust','ts','ts','rust']].map(ws=>Object.fromEntries(stages.map((s,i)=>[s.id,ws[i]])));
const evidence={format:'rhizomatic.materialization-m3-executed/1',scope:'M3 lifecycle crossings over durable directories and MR-18 fault points; no source journal, rotation, erasure or execution proof',seed:process.env.M3_SEED??'M3-2026-10-09',builds,toolchains:{node:process.version,rust:spawnSync(process.env.RUSTC??'rustc',['--version','--verbose'],{encoding:'utf8'}).stdout.trim()},fixed:[],towers:[],faults:[],executed:{towers:Object.keys(scenarios),faults:Object.keys(faults)},notExecuted:packet.required_scenarios.M3.filter(id=>!(id in scenarios))};
const strip=records=>records.map(r=>{if(!r.actual||typeof r.actual!=='object')return r;const {diagnostics:_d,...actual}=r.actual;return {...r,actual};});
for(const [caseId,plan]of Object.entries(scenarios)){
 for(let i=0;i<fixed.length;i++){const records=crossing(fixed[i],plan,`${caseId}-fixed-${i}`),path=`m3-fixed-${caseId}-${i}.json`;writeFileSync(join(out,path),canonicalJson({caseId,assignment:fixed[i],records})+'\n');evidence.fixed.push({caseId,assignment:fixed[i],artifact:path,sha256:hash(join(out,path))});}
 const plans=replayDir?JSON.parse(readFileSync(join(replayDir,`m3-plans-${caseId}.json`))):planTowers({seed:evidence.seed,scenario:caseId,stages,capabilities});validateReplayPlan(plans,{stages,capabilities,availableBuilds:builds});
 writeFileSync(join(out,`m3-plans-${caseId}.json`),canonicalJson(plans)+'\n');
 for(const p of plans.plans){const a=Object.fromEntries(p.assignments.map(x=>[x.stage,x.witness]));const first=crossing(a,plan,`${caseId}-tower-${p.index}`);const path=`m3-tower-${caseId}-${p.index}.json`;
  if(replayDir){const prior=JSON.parse(readFileSync(join(replayDir,path)));assert.equal(canonicalJson(strip(prior.first)),canonicalJson(strip(first)),'retained exact replay');}
  const replay=crossing(a,plan,`${caseId}-replay-${p.index}`);assert.equal(canonicalJson(strip(first)),canonicalJson(strip(replay)),'deterministic stage replay');
  writeFileSync(join(out,path),canonicalJson({plan:p,first,replay})+'\n');evidence.towers.push({caseId,plan:p,artifact:path,sha256:hash(join(out,path))});
 }
 console.log(`M3 ${caseId}: both fixed directions + three towers/replay`);
}
for(const [caseId,plan]of Object.entries(faults)){
 for(let i=0;i<fixed.length;i++){const records=crossing(fixed[i],plan,`${caseId}-${i}`),path=`m3-fault-${caseId}-${i}.json`;
  if(replayDir){const prior=JSON.parse(readFileSync(join(replayDir,path)));assert.equal(canonicalJson(strip(prior.records)),canonicalJson(strip(records)),'retained fault replay');}
  writeFileSync(join(out,path),canonicalJson({caseId,fault:plan.fault,assignment:fixed[i],records})+'\n');evidence.faults.push({caseId,fault:plan.fault,assignment:fixed[i],artifact:path,sha256:hash(join(out,path))});}
 console.log(`M3 fault ${caseId} (${plan.fault}): both fixed directions`);
}
// Harness sensitivity: a wrong outcome, a stale build and a modified plan must each refuse.
const good=must('ts',{mode:'control-execute',fixture,step:install,store:{dir:freshDir('negative')},seed:true});
const wrong=structuredClone(good);wrong.outcome=S('read_installed').expected.outcome;assert.throws(()=>expectExecuted(wrong,install),/Expected values/);
const tampered=structuredClone(good);tampered.store.bytesHex=S('advance_time').expected.controlHex;assert.throws(()=>expectExecuted(tampered,install),/Expected values/);
const plans=JSON.parse(readFileSync(join(out,'m3-plans-ctl_cross_witness_restore.json')));
assert.throws(()=>validateReplayPlan(plans,{stages,capabilities,availableBuilds:{...builds,ts:'stale'}}),/pinned replay build/);
const modified=structuredClone(plans);modified.seed+='changed';assert.throws(()=>validateReplayPlan(modified,{stages,capabilities,availableBuilds:builds}),/fingerprint/);
evidence.harnessNegatives=['wrong-outcome','wrong-directory','stale-build','modified-replay-plan'];
rmSync(stores,{recursive:true,force:true});
writeFileSync(join(out,'M3-CAPABILITIES.json'),JSON.stringify(capabilities,null,2)+'\n');writeFileSync(join(out,'M3-TOWERS.json'),JSON.stringify(evidence,null,2)+'\n');
console.log(`M3 crossings: ${evidence.fixed.length} fixed, ${evidence.towers.length} seeded towers + exact replay, ${evidence.faults.length} fault branches; ${evidence.harnessNegatives.length} sensitivity negatives; ${out}`);
