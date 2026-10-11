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
const fixtureFor=step=>({...fixture,boot:step.bootOverride??schedule.boot,source:step.source??schedule.source,...(step.receivedAt?{receivedAt:step.receivedAt}:{}),...(step.noGrant?{noGrant:true}:{}),...(step.sourceUnavailable?{sourceUnavailable:true}:{}),...(step.refusedSupport?{refusedSupport:step.refusedSupport}:{})});
// The erasure marker: text the shared definitions of the erasure registrations carry (MR-15).
const ERASED_MARKER=Buffer.from('PUBLIC-TEST-ERASED-DEFINITION-MARKER').toString('hex');
const dirHas=(dir,hex)=>files(dir).some(p=>readFileSync(p).toString('hex').includes(hex)||readFileSync(p,'utf8').includes(hex));
const kindOf=d=>d.claims.pointers.find(p=>p.role===role+'kind')?.target;
const delivered=(step,kind)=>step.delivery.find(d=>kindOf(d)===kind);
const install=stepOf('install');
// The operand marker: a source fact's text that no stored image or directory file may carry (MR-14).
const OPERAND_MARKER=Buffer.from('PUBLIC-TEST-OPERAND-MARKER').toString('hex');
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
function expectExecuted(actual,step){const src=step.source??schedule.source;assert.deepEqual(actual.outcome,step.expected.outcome);assert.deepEqual(actual.preflight,{status:'input-valid'});assert.equal(actual.store.bytesHex,step.expected.controlHex);for(const c of actual.calls)assert.deepEqual([c.binding,c.revision,c.authority],[src.binding,src.revision,src.authority]);}
// A read delivers only its snapshot; its capture was delivered by the step that selected that snapshot.
const captureFor=read=>{const snapshot=delivered(read,'snapshot/1');if(!snapshot)return undefined;const selecting=schedule.steps.find(s=>delivered(s,'capture/1')&&delivered(s,'snapshot/1')?.id===snapshot.id);return selecting?delivered(selecting,'capture/1'):delivered(install,'capture/1');};
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
 const executeInput={mode:'control-execute',fixture:{...fixtureFor(first),...(plan.refused?{refusedSupport:plan.refused}:{}),...(plan.moved?{movedSource:plan.moved}:{})},step:first,store:{dir:dirA},seed:true,upstream:constructed,...(fault?{fault:{kind:fault,...(plan.raced?{image:plan.raced}:{})}}:{})};
 const executed=run(a['control-execute'],executeInput);
 // The post-check race is an event in the committing process: the host's durable source moved before CAS dispatch, after exactly two checks.
 if(plan.moved){assert.deepEqual(executed.output.sourceAtCas,plan.moved,'the moved source is current at CAS dispatch');assert.equal(executed.output.calls.length,2,'no check after the final one');}
 if(after.crash){assert.notEqual(executed.status,0,'a crashed host answers nothing');assert.equal(executed.output,null);}
 else{assert.equal(executed.status,0,executed.stderr);if(after.outcome)expectExecuted(executed.output,first);if(after.status){assert.equal(executed.output.outcome.claims.pointers.find(p=>p.role===role+'status').target,after.status);assert.equal(executed.output.store.bytesHex,after.controlHex);}}
 const {upstream:_u,...executeRecord}=executeInput;record(records,'control-execute',a['control-execute'],executeRecord,executed.output??{crashed:true,status:executed.status});
 const exported=must(a['control-export'],{mode:'control-export',fixture:fixtureFor(first),store:{dir:dirA}});
 assert.equal(exported.bytesHex,after.controlHex,'the directory after the stage is the oracle');record(records,'control-export',a['control-export'],{mode:'control-export'},exported);
 assert.ok(!exported.bytesHex.includes(OPERAND_MARKER),'no operand bytes in the image');for(const p of files(dirA))assert.ok(!readFileSync(p).toString('hex').includes(OPERAND_MARKER)&&!readFileSync(p,'utf8').includes(OPERAND_MARKER),'no operand bytes in the directory');
 // Erasure settlement is a physical fact: the marker is present on the directory while a consumer is active, absent once the last consumer retired.
 if(plan.erased==='present')assert.ok(exported.bytesHex.includes(ERASED_MARKER)&&dirHas(dirA,ERASED_MARKER),'erased support still reachable, purge owed');
 if(plan.erased==='absent')assert.ok(!exported.bytesHex.includes(ERASED_MARKER)&&!dirHas(dirA,ERASED_MARKER),'erased support settled on every surface');
 // A later read over the same directory sees the moved source from the host's own durable state; the test supplies the original source.
 for(const e of plan.afterOnA??[]){const o=must(a['control-read'],{mode:'control-read',fixture:{...fixtureFor(e.step),source:schedule.source},step:e.step,store:{dir:dirA}});assert.deepEqual(o.outcome,e.step.expected.outcome);assert.equal(o.store.bytesHex,after.controlHex);record(records,'control-read',a['control-read'],{mode:'control-read',step:e.step.id,source:'original'},o);}
 const dirB=freshDir(label+'-b');
 const restored=must(a['control-restore'],{mode:'control-restore',fixture:fixtureFor(restore),step:restore,store:{dir:dirB},upstream:exported});
 assert.deepEqual(restored.outcome,restore.expected.outcome);assert.equal(restored.store.bytesHex,after.controlHex);record(records,'control-restore',a['control-restore'],{mode:'control-restore',step:restore.id},restored);
 const readOut=must(a['control-read'],{mode:'control-read',fixture:fixtureFor(read),step:read,store:{dir:dirB}});
 assert.deepEqual(readOut.outcome,read.expected.outcome);record(records,'control-read',a['control-read'],{mode:'control-read',step:read.id},readOut);
 const snapshot=delivered(read,'snapshot/1'),capture=delivered(read,'capture/1')??captureFor(read);
 const resultInput={mode:'control-result',fixture:fixtureFor(read),upstream:readOut,control:exported,...(snapshot?{capture,snapshot}:{})};
 const result=must(a['control-result'],resultInput);expectReadback(result,readback);record(records,'control-result',a['control-result'],{mode:'control-result',step:read.id},result);
 for(const e of extra){const o=must(a['control-read'],{mode:'control-execute',fixture:fixtureFor(e.step),step:e.step,store:{dir:dirB}});assert.deepEqual(o.outcome,e.step.expected.outcome);assert.equal(o.store.bytesHex,e.controlHex??after.controlHex);record(records,'control-read',a['control-read'],{mode:'control-execute',step:e.step.id},o);}
 if(!after.crash&&after.status){const r=must(a['control-result'],{mode:'control-result',fixture:fixtureFor(first),upstream:executed.output,control:exported});expectReadback(r,{status:after.status,classification:'verified-context',sourceCommitments:'attested',bodyHex:after.bodyHex});record(records,'control-result',a['control-result'],{mode:'control-result',step:first.id},r);}
 return records;
}
/**
 * The rotation crossing (ctl_capacity_rotation): the host durably selects the old configuration
 * over its 64-entry image, the 65th install refuses, the new configuration is prepared by
 * explicit installs that never serve, activation is one durable selection with a crash on either
 * side of it, and every later boot serves only the selected configuration.
 */
function rotationCrossing(a,plan,label){
 const {fault}=plan;const records=[];const dir=freshDir(label+'-a');
 const old=S('rotation_install_65'),prepA=S('rotation_new_install_fern'),prepB=S('rotation_new_install_moss'),blockedNew=S('rotation_new_request_old_endpoint'),oldServes=S('rotation_old_read_fern'),oldAtNew=S('rotation_old_request_new_endpoint'),newRead=S('rotation_new_read_fern'),reopenInstall=S('rotation_old_install_retired'),reopenRestore=S('rotation_old_restore'),newInstallOld=S('rotation_new_install_retired_old');
 const oldId=schedule.boot.configuration.id,newId=prepA.bootOverride.configuration.id;assert.notEqual(oldId,newId);
 const ex=(stage,w,input)=>{const o=must(w,input);record(records,stage,w,input,o);return o;};
 const selectIn=(w,step,kind)=>{const input={mode:'control-select',fixture:fixtureFor(step),store:{dir},explicit:true,...(kind?{fault:{kind}}:{})};const r=run(w,input);record(records,'control-select',w,input,r.output??{crashed:true,status:r.status});return r;};
 // 1. The host selects the old configuration and seeds its 64-entry image; the 65th distinct install refuses before any source check or write.
 assert.equal(selectIn(a['construct'],old).status,0);
 const sixtyFifth=ex('control-execute',a['control-execute'],{mode:'control-execute',fixture:fixtureFor(old),step:old,store:{dir},seed:true});
 assert.deepEqual(sixtyFifth.outcome,old.expected.outcome);assert.equal(sixtyFifth.store.bytesHex,old.expected.controlHex);assert.deepEqual(sixtyFifth.calls,[]);assert.equal(sixtyFifth.selected,oldId);
 // 2. Preparation: explicit installs into the new scope, which never serves; a preparation crash restarts and the explicit retry completes.
 // The new scope is initialized by seeding its empty image; the prepared installs are explicit and never serve.
 const prepare=(w,step,kind)=>{const input={mode:'control-execute',fixture:fixtureFor(step),step,store:{dir},explicit:true,...(step===prepA?{seed:true}:{}),...(kind?{fault:{kind}}:{})};const r=run(w,input);record(records,'control-execute',w,input,r.output??{crashed:true,status:r.status});return r;};
 if(fault==='prep-crash'){const crashed=prepare(a['control-restore'],prepA,'crash-before-cas');assert.notEqual(crashed.status,0,'a crashed preparation answers nothing');}
 for(const step of [prepA,prepB]){const r=prepare(a['control-restore'],step);assert.equal(r.status,0,r.stderr);assert.deepEqual(r.output.outcome,step.expected.outcome);assert.equal(r.output.store.bytesHex,step.expected.controlHex);assert.equal(r.output.selected,oldId);}
 const blocked=ex('control-read',a['control-read'],{mode:'control-read',fixture:fixtureFor(blockedNew),step:blockedNew,store:{dir}});assert.deepEqual(blocked.outcome,blockedNew.expected.outcome);assert.equal(blocked.selected,oldId);
 const served=ex('control-read',a['control-read'],{mode:'control-read',fixture:fixtureFor(oldServes),step:oldServes,store:{dir}});expectExecuted(served,oldServes);
 const explicitRead=run(a['control-read'],{mode:'control-execute',fixture:fixtureFor(newRead),step:newRead,store:{dir},explicit:true});assert.notEqual(explicitRead.status,0,'an explicit attempt never serves');
 // 3. Activation: one durable selection, with a crash before or after the rename.
 const activation=selectIn(a['control-execute'],prepA,fault==='crash-before-activation'||fault==='crash-after-activation'?fault:undefined);
 if(fault==='crash-before-activation'||fault==='crash-after-activation')assert.notEqual(activation.status,0,'a crashed activation answers nothing');else assert.equal(activation.status,0,activation.stderr);
 const exported=ex('control-export',a['control-export'],{mode:'control-export',fixture:fixtureFor(prepB),store:{dir},explicit:true});assert.equal(exported.bytesHex,prepB.expected.controlHex);
 const exportedOld=ex('control-export',a['control-export'],{mode:'control-export',fixture:fixtureFor(old),store:{dir},explicit:true});assert.equal(exportedOld.bytesHex,old.expected.controlHex);
 if(fault==='crash-before-activation'){
  // The restart selects the old configuration only; the prepared scope stays inert; the explicit retry activates.
  assert.equal(exported.selected,oldId);
  const still=ex('control-read',a['control-read'],{mode:'control-read',fixture:fixtureFor(blockedNew),step:blockedNew,store:{dir}});assert.deepEqual(still.outcome,blockedNew.expected.outcome);
  const again=ex('control-read',a['control-read'],{mode:'control-read',fixture:fixtureFor(oldServes),step:oldServes,store:{dir}});expectExecuted(again,oldServes);
  assert.equal(selectIn(a['control-execute'],prepA).status,0);
 }else assert.equal(exported.selected,newId);
 // 4. After activation every boot serves the new configuration only: old requests refuse, the new scope serves after a fresh source check.
 const mismatch=ex('control-read',a['control-read'],{mode:'control-read',fixture:fixtureFor(oldAtNew),step:oldAtNew,store:{dir}});assert.deepEqual(mismatch.outcome,oldAtNew.expected.outcome);assert.equal(mismatch.selected,newId);
 const fresh=ex('control-read',a['control-read'],{mode:'control-read',fixture:fixtureFor(newRead),step:newRead,store:{dir}});expectExecuted(fresh,newRead);assert.ok(fresh.calls.length>=1,'a fresh source check');assert.equal(fresh.selected,newId);
 const snapshot=delivered(newRead,'snapshot/1'),capture=captureFor(newRead);
 const result=ex('control-result',a['control-result'],{mode:'control-result',fixture:fixtureFor(newRead),upstream:fresh,control:{bytesHex:prepB.expected.controlHex},capture,snapshot});expectReadback(result,completed(newRead));
 // 5. The old scope reopened explicitly keeps its retirements; nothing is copied or resurrected.
 for(const step of [reopenInstall,reopenRestore]){const r=prepare(a['control-restore'],step);assert.equal(r.status,0,r.stderr);assert.deepEqual(r.output.outcome,step.expected.outcome);assert.equal(r.output.store.bytesHex,old.expected.controlHex);}
 // 6. An explicit install of an old retired descriptor into the new scope is a new install.
 const newInstall=ex('control-execute',a['control-execute'],{mode:'control-execute',fixture:fixtureFor(newInstallOld),step:newInstallOld,store:{dir}});expectExecuted(newInstall,newInstallOld);assert.equal(newInstall.selected,newId);
 const final=ex('control-export',a['control-export'],{mode:'control-export',fixture:fixtureFor(old),store:{dir},explicit:true});assert.equal(final.bytesHex,old.expected.controlHex,'the old image is untouched by rotation');assert.equal(final.selected,newId);
 return records;
}
/**
 * The erasure crossing (ctl_support_erasure, ctl_support_erasure_crashes): the host is told the
 * refused acts once, with the seed, and keeps them as durable facts; every later process over the
 * directory reopens under that restriction without being told again. Seeded historical copies
 * are the physical program-support copies an older host left; settlement purges them only once
 * no active entry reaches a refused act, and a crash between a durable retire and that purge
 * leaves debt a reopen settles. The fresh witness then restores without the originals.
 */
function erasureCrossing(a,plan,label){
 const {first,fault,after,refused,seedHistory=[],then=[],restore,read,readback,extra=[]}=plan;const records=[];
 const dirA=freshDir(label+'-a');
 const scan=(exported,erased,where)=>{const image=exported.bytesHex.includes(ERASED_MARKER),dir=dirHas(dirA,ERASED_MARKER);
  if(erased==='present')assert.ok(image&&dir,where+': erased support still reachable, purge owed');
  if(erased==='debt')assert.ok(!image&&dir,where+': the image settled, historical copies still owed');
  if(erased==='absent')assert.ok(!image&&!dir,where+': erased support settled on every surface');};
 const exportA=()=>{const e=must(a['control-export'],{mode:'control-export',fixture:fixtureFor(first),store:{dir:dirA}});record(records,'control-export',a['control-export'],{mode:'control-export'},e);return e;};
 const constructed=must(a['construct'],{mode:'construct',fixture,step:first});
 assert.deepEqual(constructed.delivery.map(d=>d.id),first.delivery.map(d=>d.id));record(records,'construct',a['construct'],{mode:'construct',step:first.id},constructed);
 const executeInput={mode:'control-execute',fixture:{...fixtureFor(first),refusedSupport:refused},step:first,store:{dir:dirA},seed:true,seedHistory,upstream:constructed,...(fault?{fault:{kind:fault}}:{})};
 const executed=run(a['control-execute'],executeInput);
 if(after.crash){assert.notEqual(executed.status,0,'a crashed host answers nothing');assert.equal(executed.output,null);}
 else{assert.equal(executed.status,0,executed.stderr);if(after.outcome)expectExecuted(executed.output,first);if(after.status){assert.equal(executed.output.outcome.claims.pointers.find(p=>p.role===role+'status').target,after.status);assert.equal(executed.output.store.bytesHex,after.controlHex);}if(after.settled!==undefined)assert.equal(executed.output.erasure.afterAttempt.settled,after.settled,'settlement after '+first.id);}
 const {upstream:_u,...executeRecord}=executeInput;record(records,'control-execute',a['control-execute'],executeRecord,executed.output??{crashed:true,status:executed.status});
 let exported=exportA();assert.equal(exported.bytesHex,after.controlHex,'the directory after the stage is the oracle');scan(exported,after.erased,'after '+first.id);
 assert.deepEqual(exported.erasure.refused,refused,'the refused acts are durable host facts');
 // Later processes reopen the surviving directory; the test never supplies the refused acts again.
 for(const t of then){const {refusedSupport:_r,...fx}=fixtureFor(t.step);const input={mode:'control-execute',fixture:fx,step:t.step,store:{dir:dirA},...(t.fault?{fault:{kind:t.fault}}:{})};const o=run(a['control-read'],input);
  if(t.crash){assert.notEqual(o.status,0,'a crashed host answers nothing');record(records,'control-execute',a['control-read'],input,{crashed:true,status:o.status});}
  else{assert.equal(o.status,0,o.stderr);assert.deepEqual(o.output.outcome,t.step.expected.outcome);assert.equal(o.output.store.bytesHex,t.step.expected.controlHex);assert.deepEqual(o.output.erasure.refused,refused,'reopened under the persisted restriction');if(t.settled!==undefined)assert.equal(o.output.erasure.afterAttempt.settled,t.settled,'settlement after '+t.step.id);record(records,'control-execute',a['control-read'],input,o.output);}
  exported=exportA();scan(exported,t.erased,'after '+t.step.id);}
 const finalHex=exported.bytesHex;
 // The fresh witness has its own erasure law and is told the same acts; it restores the terminal image without the originals.
 const dirB=freshDir(label+'-b');
 const toldB=step=>({...fixtureFor(step),refusedSupport:refused});
 const restored=must(a['control-restore'],{mode:'control-restore',fixture:toldB(restore),step:restore,store:{dir:dirB},upstream:exported});
 assert.deepEqual(restored.outcome,restore.expected.outcome);assert.equal(restored.store.bytesHex,finalHex);record(records,'control-restore',a['control-restore'],{mode:'control-restore',step:restore.id},restored);
 const readOut=must(a['control-read'],{mode:'control-read',fixture:toldB(read),step:read,store:{dir:dirB}});
 assert.deepEqual(readOut.outcome,read.expected.outcome);record(records,'control-read',a['control-read'],{mode:'control-read',step:read.id},readOut);
 const snapshot=delivered(read,'snapshot/1'),capture=delivered(read,'capture/1')??captureFor(read);
 const result=must(a['control-result'],{mode:'control-result',fixture:fixtureFor(read),upstream:readOut,control:exported,...(snapshot?{capture,snapshot}:{})});expectReadback(result,readback);record(records,'control-result',a['control-result'],{mode:'control-result',step:read.id},result);
 for(const e of extra){const o=must(a['control-read'],{mode:'control-execute',fixture:toldB(e.step),step:e.step,store:{dir:dirB}});assert.deepEqual(o.outcome,e.step.expected.outcome);assert.equal(o.store.bytesHex,e.controlHex??finalHex);record(records,'control-read',a['control-read'],{mode:'control-execute',step:e.step.id},o);}
 if(plan.finalErased==='absent')assert.ok(!exported.bytesHex.includes(ERASED_MARKER)&&!dirHas(dirB,ERASED_MARKER),'the fresh witness carries no erased support');
 return records;
}
const cross=(a,plan,label)=>plan.kind==='rotation'?rotationCrossing(a,plan,label):plan.kind==='erasure'?erasureCrossing(a,plan,label):crossing(a,plan,label);
const completed=(read,commitments=true)=>({status:'completed',classification:'verified-context',sourceCommitments:commitments?'commitments-verified':'attested',bodyHex:read.expected.bodyHex});
const refusedRead=read=>({status:'refused',classification:'verified-context',sourceCommitments:'attested',bodyHex:bodyOf(read)});
const S=id=>stepOf(id);
// The refused acts of the erasure cases, and the historical copies an older host left that carry them.
const ERASED_IDS=stepOf('erasure_read_a_refused').refusedSupport,TARGET_IDS=stepOf('erasure_targeted_read_a_refused').refusedSupport;
const erasureHistory=['erasure_install_b','erasure_install_c'].map(id=>({revision:stepOf(id).initialControl.revision,hex:stepOf(id).initialControl.hex}));
const r2=S('read_advanced').initialControl.revision;
const scenarios={
 ctl_cross_witness_restore:{first:S('install'),after:{outcome:true,controlHex:S('install').expected.controlHex},restore:S('restore_installed'),read:S('read_installed'),readback:completed(S('read_installed'))},
 ctl_uncertain_present:{first:S('advance_time'),fault:'unconfirmed-present',after:{status:'indeterminate',controlHex:S('advance_time').expected.controlHex,bodyHex:cborMap([['code','commit-unconfirmed']])},restore:S('restore_advanced'),read:S('read_advanced'),readback:completed(S('read_advanced'))},
 ctl_retired_restart:{first:S('retire'),fault:'crash-after-cas',after:{crash:true,controlHex:S('retire').expected.controlHex},restore:S('restore_retired'),read:S('read_retired'),readback:refusedRead(S('read_retired')),extra:[{step:S('install_retired')},{step:S('retire_retired')}]},
 // The host's source moves after the final check: the committed selection stands and the next read refuses.
 ctl_postcheck_precommit_race:{first:S('advance_time'),fault:'source-replaced-after-final-check',moved:S('read_advanced_source_replaced').source,afterOnA:[{step:S('read_advanced_source_replaced')}],after:{outcome:true,controlHex:S('advance_time').expected.controlHex},restore:S('restore_advanced'),read:S('read_advanced_source_replaced'),readback:refusedRead(S('read_advanced_source_replaced'))},
 ctl_equal_count_replace:{first:S('replace_equal_count'),after:{outcome:true,controlHex:S('replace_equal_count').expected.controlHex},restore:S('restore_equal_count'),read:S('read_equal_count'),readback:completed(S('read_equal_count'))},
 ctl_shared_basis_limits:{first:S('limits_install_64_roots'),after:{outcome:true,controlHex:S('limits_install_64_roots').expected.controlHex},restore:S('restore_64_roots'),read:S('limits_read_64_roots'),readback:completed(S('limits_read_64_roots'))},
 // A source fact carries the operand marker; the image, the directory and the other witness's restore never do.
 ctl_metadata_no_payload:{first:S('install_marker'),after:{outcome:true,controlHex:S('install_marker').expected.controlHex},restore:S('restore_marker'),read:S('read_marker'),readback:completed(S('read_marker'))},
 // Retained ordinary deltas never activate: the empty image restores empty and reads missing; only an authorized install activates.
 ctl_delta_state_inert:{first:S('restore_empty_retained'),after:{outcome:true,controlHex:S('restore_empty_retained').expected.controlHex},restore:S('restore_empty_retained'),read:S('read_missing_retained'),readback:refusedRead(S('read_missing_retained')),extra:[{step:S('install'),controlHex:S('install').expected.controlHex}]},
 // The last consumer of the refused definitions retires: the image and the directory no longer carry the marker, the other witness restores the terminal selections without the originals, and the unrelated registration still serves.
 ctl_support_erasure:{kind:'erasure',first:S('erasure_retire_a'),refused:ERASED_IDS,seedHistory:erasureHistory,after:{outcome:true,controlHex:S('erasure_retire_a').expected.controlHex,erased:'present',settled:false},then:[{step:S('erasure_read_b_refused_retired_a'),erased:'present',settled:false},{step:S('erasure_retire_b'),erased:'absent',settled:true},{step:S('erasure_read_a_retired'),erased:'absent'},{step:S('erasure_install_a_retired'),erased:'absent'}],restore:S('erasure_restore_settled'),read:S('erasure_read_c_settled'),readback:completed(S('erasure_read_c_settled')),finalErased:'absent'},
 // The 64-entry lifetime and rotation: the 65th install refuses, the new configuration is prepared without serving, activated by one durable selection, and serves alone afterwards.
 ctl_capacity_rotation:{kind:'rotation'},
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
 // The host's source moves, or its authority is revoked, between the precompute check and the final check: refused, no CAS.
 ctl_precheck_source_race:{first:S('advance_time'),fault:'source-replaced-before-final-check',after:{status:'refused',controlHex:S('advance_time').initialControl.hex,bodyHex:cborMap([['code','source-changed']])},restore:S('restore_installed'),read:S('read_installed'),readback:completed(S('read_installed'))},
 ctl_precheck_authority_revoked:{first:S('advance_time'),fault:'authority-revoked-before-final-check',after:{status:'refused',controlHex:S('advance_time').initialControl.hex,bodyHex:cborMap([['code','unauthorized']])},restore:S('restore_installed'),read:S('read_installed'),readback:completed(S('read_installed'))},
 // The committed selection is restored in a fresh process after the source moved: the read refuses, nothing cached answers.
 ctl_rebuild_source_replace:{first:S('advance_time'),after:{outcome:true,controlHex:S('advance_time').expected.controlHex},restore:S('restore_advanced'),read:S('read_advanced_source_replaced'),readback:refusedRead(S('read_advanced_source_replaced'))},
 // The provider is unavailable after restore: the selection is reported unchecked, the read refuses, and a later read with the source back completes.
 ctl_restore_unavailable:{first:S('advance_time'),after:{outcome:true,controlHex:S('advance_time').expected.controlHex},restore:S('restore_advanced'),read:S('read_advanced_source_unavailable'),readback:refusedRead(S('read_advanced_source_unavailable')),extra:[{step:S('read_advanced')}]},
 // A retained configuration, descriptor and install-shaped request create no operation, grant or entry.
 cmd_inert_retention_empty_control_read:{first:S('restore_empty_retained_request'),after:{outcome:true,controlHex:S('restore_empty_retained_request').expected.controlHex},restore:S('restore_empty_retained_request'),read:S('read_missing_retained'),readback:refusedRead(S('read_missing_retained'))},
 // Support erasure: the first retire leaves the shared definitions reachable through B and purge owed; B stays blocked after a reopen that is not told the refused acts again.
 ctl_support_erasure_first_retire:{kind:'erasure',first:S('erasure_retire_a'),refused:ERASED_IDS,seedHistory:erasureHistory,after:{outcome:true,controlHex:S('erasure_retire_a').expected.controlHex,erased:'present',settled:false},then:[{step:S('erasure_read_b_refused_retired_a'),erased:'present',settled:false}],restore:S('erasure_restore_a_retired'),read:S('erasure_read_b_refused_retired_a'),readback:refusedRead(S('erasure_read_b_refused_retired_a'))},
 // The targeted variant refuses A's descriptor alone: retiring A drops it, the historical copies carrying it settle at once, and B keeps the shared definitions and serves.
 ctl_support_erasure_targeted:{kind:'erasure',first:S('erasure_targeted_retire_a'),refused:TARGET_IDS,seedHistory:erasureHistory,after:{outcome:true,controlHex:S('erasure_targeted_retire_a').expected.controlHex,erased:'present',settled:true},then:[{step:S('erasure_targeted_read_b_retired_a'),erased:'present',settled:true}],restore:S('erasure_restore_a_retired'),read:S('erasure_targeted_read_b_retired_a'),readback:completed(S('erasure_targeted_read_b_retired_a'))},
 // Between the two checks of a replacement the shared definition is refused: unauthorized before CAS with the same requiredSupport at both checks; C on the same source still reads.
 ctl_support_erasure_between_checks:{first:S('erasure_replace_a'),fault:'support-refused-before-final-check',refused:S('erasure_read_a_refused').refusedSupport,after:{status:'refused',controlHex:S('erasure_replace_a').initialControl.hex,bodyHex:cborMap([['code','unauthorized']])},erased:'present',restore:S('erasure_restore_abc'),read:S('erasure_read_c_allowed'),readback:completed(S('erasure_read_c_allowed'))},
 // The erasure crash schedule runs each faulted history to settlement: before the retire CAS or with the write absent, A stays active and blocked under the persisted restriction and the explicit retry retires it; with the write present or after the CAS, A reads retired; then B retires with the observed control, the historical copies purge, and the fresh witness restores the terminal image without the originals.
 ctl_support_erasure_crash_before:{kind:'erasure',first:S('erasure_retire_a'),fault:'crash-before-cas',refused:ERASED_IDS,seedHistory:erasureHistory,after:{crash:true,controlHex:S('erasure_retire_a').initialControl.hex,erased:'present'},then:[{step:S('erasure_read_a_refused'),erased:'present',settled:false},{step:S('erasure_retire_a'),erased:'present',settled:false},{step:S('erasure_read_b_refused_retired_a'),erased:'present',settled:false},{step:S('erasure_retire_b'),erased:'absent',settled:true}],restore:S('erasure_restore_settled'),read:S('erasure_read_c_settled'),readback:completed(S('erasure_read_c_settled')),finalErased:'absent'},
 ctl_support_erasure_uncertain_absent:{kind:'erasure',first:S('erasure_retire_a'),fault:'unconfirmed-absent',refused:ERASED_IDS,seedHistory:erasureHistory,after:{status:'indeterminate',controlHex:S('erasure_retire_a').initialControl.hex,bodyHex:cborMap([['code','commit-unconfirmed']]),erased:'present',settled:false},then:[{step:S('erasure_read_a_refused'),erased:'present',settled:false},{step:S('erasure_retire_a'),erased:'present',settled:false},{step:S('erasure_read_b_refused_retired_a'),erased:'present',settled:false},{step:S('erasure_retire_b'),erased:'absent',settled:true}],restore:S('erasure_restore_settled'),read:S('erasure_read_c_settled'),readback:completed(S('erasure_read_c_settled')),finalErased:'absent'},
 ctl_support_erasure_uncertain_present:{kind:'erasure',first:S('erasure_retire_a'),fault:'unconfirmed-present',refused:ERASED_IDS,seedHistory:erasureHistory,after:{status:'indeterminate',controlHex:S('erasure_retire_a').expected.controlHex,bodyHex:cborMap([['code','commit-unconfirmed']]),erased:'present',settled:false},then:[{step:S('erasure_read_a_retired_bc'),erased:'present',settled:false},{step:S('erasure_retire_b'),erased:'absent',settled:true}],restore:S('erasure_restore_settled'),read:S('erasure_read_c_settled'),readback:completed(S('erasure_read_c_settled')),finalErased:'absent'},
 ctl_support_erasure_crash_after:{kind:'erasure',first:S('erasure_retire_a'),fault:'crash-after-cas',refused:ERASED_IDS,seedHistory:erasureHistory,after:{crash:true,controlHex:S('erasure_retire_a').expected.controlHex,erased:'present'},then:[{step:S('erasure_read_a_retired_bc'),erased:'present',settled:false},{step:S('erasure_retire_b'),erased:'absent',settled:true}],restore:S('erasure_restore_settled'),read:S('erasure_read_c_settled'),readback:completed(S('erasure_read_c_settled')),finalErased:'absent'},
 // The last consumer retires durably and the host crashes before the purge: the image settled, the historical copies are still owed, and the reopen purges them before anything else.
 ctl_support_erasure_crash_after_last_retire:{kind:'erasure',first:S('erasure_retire_b'),fault:'crash-after-cas',refused:ERASED_IDS,seedHistory:[...erasureHistory,{revision:S('erasure_retire_b').initialControl.revision,hex:S('erasure_retire_b').initialControl.hex}],after:{crash:true,controlHex:S('erasure_retire_b').expected.controlHex,erased:'debt'},then:[{step:S('erasure_read_c_settled'),erased:'absent',settled:true}],restore:S('erasure_restore_settled'),read:S('erasure_read_c_settled'),readback:completed(S('erasure_read_c_settled')),finalErased:'absent'},
 // Rotation crashes: during preparation the explicit retry completes; before activation the restart selects the old configuration only; after it, only the new one.
 ctl_capacity_rotation_prep_crash:{kind:'rotation',fault:'prep-crash'},
 ctl_capacity_rotation_crash_before_activation:{kind:'rotation',fault:'crash-before-activation'},
 ctl_capacity_rotation_crash_after_activation:{kind:'rotation',fault:'crash-after-activation'},
};
assert.equal(S('read_wrong_control').initialControl.hex,S('install').expected.controlHex);
const capabilities={format:'rhizomatic-command-capabilities/1',witnesses:['ts','rust'].map(id=>({id,state:'supported',buildId:builds[id],profiles:[],stages:[...new Set(stages.map(s=>s.contract))],stage_evidence:Object.fromEntries(stages.map(s=>[s.contract,Object.keys(scenarios)]))})).concat(['elixir','haskell'].map(id=>({id,state:'not_implemented',stages:[],profiles:[]})))};
const fixed=[['ts','ts','ts','rust','rust','ts'],['rust','rust','rust','ts','ts','rust']].map(ws=>Object.fromEntries(stages.map((s,i)=>[s.id,ws[i]])));
const evidence={format:'rhizomatic.materialization-m3-executed/1',scope:'M3 lifecycle crossings over durable directories, MR-18 fault points, source races, support erasure and configuration rotation; no source journal or execution proof',seed:process.env.M3_SEED??'M3-2026-10-09',builds,toolchains:{node:process.version,rust:spawnSync(process.env.RUSTC??'rustc',['--version','--verbose'],{encoding:'utf8'}).stdout.trim()},fixed:[],towers:[],faults:[],executed:{towers:Object.keys(scenarios),faults:Object.keys(faults)},notExecuted:packet.required_scenarios.M3.filter(id=>!(id in scenarios))};
const strip=records=>records.map(r=>{if(!r.actual||typeof r.actual!=='object')return r;const {diagnostics:_d,...actual}=r.actual;return {...r,actual};});
for(const [caseId,plan]of Object.entries(scenarios)){
 for(let i=0;i<fixed.length;i++){const records=cross(fixed[i],plan,`${caseId}-fixed-${i}`),path=`m3-fixed-${caseId}-${i}.json`;writeFileSync(join(out,path),canonicalJson({caseId,assignment:fixed[i],records})+'\n');evidence.fixed.push({caseId,assignment:fixed[i],artifact:path,sha256:hash(join(out,path))});}
 const plans=replayDir?JSON.parse(readFileSync(join(replayDir,`m3-plans-${caseId}.json`))):planTowers({seed:evidence.seed,scenario:caseId,stages,capabilities});validateReplayPlan(plans,{stages,capabilities,availableBuilds:builds});
 writeFileSync(join(out,`m3-plans-${caseId}.json`),canonicalJson(plans)+'\n');
 for(const p of plans.plans){const a=Object.fromEntries(p.assignments.map(x=>[x.stage,x.witness]));const first=cross(a,plan,`${caseId}-tower-${p.index}`);const path=`m3-tower-${caseId}-${p.index}.json`;
  if(replayDir){const prior=JSON.parse(readFileSync(join(replayDir,path)));assert.equal(canonicalJson(strip(prior.first)),canonicalJson(strip(first)),'retained exact replay');}
  const replay=cross(a,plan,`${caseId}-replay-${p.index}`);assert.equal(canonicalJson(strip(first)),canonicalJson(strip(replay)),'deterministic stage replay');
  writeFileSync(join(out,path),canonicalJson({plan:p,first,replay})+'\n');evidence.towers.push({caseId,plan:p,artifact:path,sha256:hash(join(out,path))});
 }
 console.log(`M3 ${caseId}: both fixed directions + three towers/replay`);
}
for(const [caseId,plan]of Object.entries(faults)){
 for(let i=0;i<fixed.length;i++){const records=cross(fixed[i],plan,`${caseId}-${i}`),path=`m3-fault-${caseId}-${i}.json`;
  if(replayDir){const prior=JSON.parse(readFileSync(join(replayDir,path)));assert.equal(canonicalJson(strip(prior.records)),canonicalJson(strip(records)),'retained fault replay');}
  writeFileSync(join(out,path),canonicalJson({caseId,...(plan.fault?{fault:plan.fault}:{}),assignment:fixed[i],records})+'\n');evidence.faults.push({caseId,...(plan.fault?{fault:plan.fault}:{}),assignment:fixed[i],artifact:path,sha256:hash(join(out,path))});}
 console.log(`M3 fault ${caseId} (${plan.fault??'no fault'}): both fixed directions`);
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
