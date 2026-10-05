// Composition gate: JSON only across fresh processes; exact existing planner/replay.
import { readFileSync,writeFileSync,mkdirSync,readdirSync } from 'node:fs';
import { resolve,dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { planTowers,validateReplayPlan,canonicalJson,fingerprint } from './command-tower-plan.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const vectors=JSON.parse(readFileSync(join(root,'vectors/materialization/evidence-envelope.json')));
const packet=JSON.parse(readFileSync(join(root,'contracts/materialization/TOWERS.json')));
const stages=packet.stages.filter(s=>s.id==='envelope-write'||s.id==='envelope-read');
const fixture=join(root,'implementations/ts/tools/evidence-fixture.ts');
const tsx=join(root,'implementations/ts/node_modules/.bin/tsx');
const cargo=process.env.CARGO??'cargo';
const build=spawnSync(cargo,['build','--locked','--manifest-path',join(root,'implementations/rust/Cargo.toml'),'--example','evidence_fixture','--message-format=json'],{cwd:root,encoding:'utf8',maxBuffer:10*1024*1024});
assert.equal(build.status,0,build.stderr);
const executableArtifacts=build.stdout.trim().split('\n').filter(Boolean).map(JSON.parse).filter(m=>m.reason==='compiler-artifact'&&m.target?.name==='evidence_fixture'&&m.target.kind?.includes('example')&&m.executable);
assert.equal(executableArtifacts.length,1,'Cargo must report exactly one evidence fixture executable');
const rust=executableArtifacts[0].executable;
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
const tsSrc=join(root,'implementations/ts/src');
const files=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):[join(dir,e.name)]).sort();
const sourceDigest=fingerprint(files(tsSrc).map(p=>[p.slice(tsSrc.length+1),hash(p)]).concat([["adapter",hash(fixture)],["fixture-helper",hash(join(root,'implementations/ts/test/support/evidence-fixture.ts'))],["lock",hash(join(root,'implementations/ts/package-lock.json'))],["node",process.version]]));
const ids={ts:`ts-source:${sourceDigest}`,rust:`rust-binary:${hash(rust)}`};
const executedCases=['env_original_appearance','env_reading_metadata','env_legacy_missing_reading','env_fixed_mixed_routes'];
const capabilities={format:'rhizomatic-command-capabilities/1',witnesses:['ts','rust'].map(id=>({id,state:'supported',buildId:ids[id],stages:stages.map(s=>s.contract),profiles:[],stage_evidence:Object.fromEntries(stages.map(s=>[s.contract,executedCases]))})).concat(['elixir','haskell'].map(id=>({id,state:'not_implemented',stages:[],profiles:[]})))};
const replayAt=process.argv.indexOf('--replay');
const replayDir=replayAt<0?null:resolve(process.argv[replayAt+1]);
const outdir=resolve(process.env.M1_ARTIFACT_DIR??join(root,'artifacts/materialization-m1'));mkdirSync(outdir,{recursive:true});
const run=(w,input)=>{const r=spawnSync(w==='ts'?tsx:rust,w==='ts'?[fixture]:[],{input:JSON.stringify(input),cwd:root,encoding:'utf8',maxBuffer:20*1024*1024});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
const evidence={toolchains:{node:process.version,rust:spawnSync('rustc',['--version','--verbose'],{encoding:'utf8'}).stdout.trim()},format:'rhizomatic.materialization-m1-executed/1',seed:process.env.M1_SEED??'M1-2026-10-05',builds:ids,fixed:[],towers:[],negative:[],caseIds:[]};
const fixtures=vectors.positives.filter(v=>['original','metadata','legacy','reserved-keys'].includes(v.variant));
function validateCrossing(v,produced,received){
 assert.equal(produced.envelopeHex,v.envelopeHex);assert.equal(received.envelopeHex,v.envelopeHex);
 assert.equal(received.transportId,v.transportId);assert.equal(received.existingHViewHex,v.existingHViewHex);
 assert.equal(canonicalJson(received.native),canonicalJson(produced.native));assert.equal(canonicalJson(received.resolution),canonicalJson(produced.resolution));
 if(v.variant==='legacy')assert.equal(received.resolution.status,'missing-reading');
}
function crossing(v,write,read){
 const produced=run(write,{mode:'encode',native:v.native});
 const received=run(read,{mode:'decode',envelopeHex:produced.envelopeHex});validateCrossing(v,produced,received);
 return {input:{mode:'encode',native:v.native},produced,received};
}
for(const v of fixtures)for(const [write,read]of[['ts','rust'],['rust','ts']]){const data=crossing(v,write,read);const path=`fixed-${v.variant}-${write}-${read}.json`;writeFileSync(join(outdir,path),canonicalJson(data)+'\n');evidence.fixed.push({caseId:'env_fixed_mixed_routes',variant:v.variant,write,read,artifact:path,sha256:hash(join(outdir,path))});}
for(const v of fixtures){
 const plans=replayDir?JSON.parse(readFileSync(join(replayDir,`plans-${v.variant}.json`))):planTowers({seed:evidence.seed,scenario:v.variant,stages,capabilities});
 validateReplayPlan(plans,{stages,capabilities,availableBuilds:ids});
 writeFileSync(join(outdir,`plans-${v.variant}.json`),canonicalJson(plans)+'\n');
 for(const plan of plans.plans){
  validateReplayPlan(plans,{stages,capabilities,availableBuilds:ids});
  const assignment=Object.fromEntries(plan.assignments.map(a=>[a.stage,a.witness]));
  const first=crossing(v,assignment['envelope-write'],assignment['envelope-read']);
  if(replayDir){const prior=JSON.parse(readFileSync(join(replayDir,`tower-${v.variant}-${plan.index}.json`)));assert.equal(canonicalJson(first),canonicalJson(prior.first));}
  const replay=crossing(v,assignment['envelope-write'],assignment['envelope-read']);assert.equal(canonicalJson(first),canonicalJson(replay));
  const path=`tower-${v.variant}-${plan.index}.json`;writeFileSync(join(outdir,path),canonicalJson({plan,first,replay})+'\n');evidence.towers.push({caseId:'env_fixed_mixed_routes',variant:v.variant,plan,artifact:path,sha256:hash(join(outdir,path))});
 }
}
for(const v of vectors.negative)for(const w of['ts','rust']){const result=run(w,{mode:'decode',envelopeHex:v.envelopeHex,limits:v.limits});assert.equal(result.error,v.error,`${w} ${v.variant}`);evidence.negative.push({id:v.id,variant:v.variant,witness:w,result});}
// Explicit receiving-boundary corruption of previously passing serialized output.
evidence.receivingCorruption=[];
for(const v of fixtures)for(const w of['ts','rust']){const result=run(w,{mode:'decode',envelopeHex:v.envelopeHex+'f4'});assert.equal(result.error,'invalid-evidence');evidence.receivingCorruption.push({caseId:'env_canonical_malformed',variant:v.variant,witness:w,result});}
// Named harness failure proofs, with the same checks used by normal execution.
const original=fixtures.find(v=>v.variant==='original'),metadata=fixtures.find(v=>v.variant==='metadata');
const good=run('ts',{mode:'encode',native:original.native}),wrong=run('ts',{mode:'encode',native:metadata.native});
assert.throws(()=>validateCrossing(original,wrong,run('rust',{mode:'decode',envelopeHex:wrong.envelopeHex})),/Expected values/);
const plans=JSON.parse(readFileSync(join(outdir,'plans-original.json')));
assert.throws(()=>validateReplayPlan(plans,{stages,capabilities,availableBuilds:{...ids,ts:'stale'}}),/pinned replay build/);
const changed=structuredClone(plans);changed.seed+='tampered';assert.throws(()=>validateReplayPlan(changed,{stages,capabilities,availableBuilds:ids}),/fingerprint/);
const unavailable=structuredClone(capabilities);for(const w of unavailable.witnesses){w.state='not_implemented';w.stages=[];w.profiles=[];}assert.throws(()=>planTowers({seed:'negative',scenario:'unsupported',stages,capabilities:unavailable}),/unsupported required stage/);
const missing=structuredClone(capabilities);delete missing.witnesses[0].stage_evidence[stages[0].contract];assert.throws(()=>planTowers({seed:'negative',scenario:'missing-evidence',stages,capabilities:missing}),/stage evidence/);
assert.throws(()=>validateCrossing(original,good,{...good,envelopeHex:good.envelopeHex+'f4'}),/Expected values/);
evidence.harnessNegatives=['common-wrong-artifact','stale-build','modified-replay-plan','unsupported-stage','missing-stage-evidence','modified-replay-artifact'];
evidence.caseIds=['env_fixed_mixed_routes'];writeFileSync(join(outdir,'CAPABILITIES.json'),JSON.stringify(capabilities,null,2)+'\n');writeFileSync(join(outdir,'EVIDENCE.json'),JSON.stringify(evidence,null,2)+'\n');
console.log(`M1 crossings: ${evidence.fixed.length} fixed routes, ${evidence.towers.length} seeded towers plus exact replay, ${evidence.negative.length} hostile receiving checks; artifacts ${outdir}`);
