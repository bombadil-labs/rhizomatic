// M3 lifecycle evidence: shared control-image and lifecycle receipts from both witnesses, each
// allocated case's executed references, and the native walks. Partial and specified cases are
// reported, never counted as executed.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {expectedMaterializationAssertions,materializationAssertionReceipts,expectedMaterializationM3Assertions,materializationM3AssertionReceipts,validateMaterializationAssertions,materializationAccountingSensitivity} from './check-materialization-accounting.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=resolve(process.env.M3_ARTIFACT_DIR??join(root,'artifacts/materialization-m3'));mkdirSync(out,{recursive:true});
const read=p=>JSON.parse(readFileSync(join(root,p)));
const m3=read('contracts/materialization/M3-CASES.json');
const required=read('contracts/materialization/MILESTONES.json').milestones.find(m=>m.id==='M3');
assert.deepEqual(m3.cases.map(c=>c.id).sort(),[...required.required_cases].sort());
assert.deepEqual(m3.variants.map(c=>c.id).sort(),[...required.required_variants].sort());
const run=(command,args,name)=>{
 const p=spawnSync(command,args,{cwd:root,encoding:'utf8',maxBuffer:50*1024*1024,env:{...process.env,M3_ARTIFACT_DIR:out}});
 const log=p.stdout+p.stderr;writeFileSync(join(out,name+'.log'),log);assert.equal(p.status,0,name+': '+log);return log;
};
const tsLog=run(join(root,'implementations/ts/node_modules/.bin/vitest'),['run','--root','implementations/ts','test/materialization-control.test.ts','test/materialization-lifecycle.test.ts','test/materialization-description.test.ts','--reporter=default','--reporter=json','--outputFile',join(out,'TS-TESTS.json')],'ts');
const ts=JSON.parse(readFileSync(join(out,'TS-TESTS.json')));assert.equal(ts.success,true);assert.equal(ts.numFailedTests,0);assert.equal(ts.numPendingTests,0);
const rustLog=run(process.env.CARGO??'cargo',['test','--locked','--manifest-path','implementations/rust/Cargo.toml','--test','materialization_control','--test','materialization_lifecycle','--test','materialization_description','--','--nocapture'],'rust');
const m3Corpora=Object.fromEntries(['control-image','lifecycle'].map(name=>[name,readFileSync(join(root,'vectors/materialization',name+'.json'))]));
const descriptions={'command-descriptions':readFileSync(join(root,'vectors/materialization/command-descriptions.json'))};
const assertions={format:'rhizomatic.materialization-m3-vector-assertions/1',note:'Counts, corpus identity and missing-evidence probes supplement semantic assertions and independent review, not a proof of arbitrary assertion meaning.'};
for(const [witness,log] of [['ts',tsLog],['rust',rustLog]]){
 const expected=expectedMaterializationM3Assertions(m3Corpora),actual=materializationM3AssertionReceipts(log);
 validateMaterializationAssertions(expected,actual);
 const expectedDescriptions=expectedMaterializationAssertions(descriptions,witness),actualDescriptions=materializationAssertionReceipts(log);
 validateMaterializationAssertions(expectedDescriptions,actualDescriptions);
 assertions[witness]={records:[...actual,...actualDescriptions],negatives:materializationAccountingSensitivity(expected)};
}
writeFileSync(join(out,'VECTOR-ASSERTIONS.json'),JSON.stringify(assertions,null,2)+'\n');
const passed=ts.testResults.flatMap(r=>r.assertionResults).filter(t=>t.status==='passed').map(t=>t.fullName);
for(const c of [...m3.cases,...m3.variants]){
 for(const w of ['ts','rust'])for(const ref of c.vector_assertions)assert.ok(assertions[w].records.some(r=>r.corpus===ref.corpus&&r.group===ref.group&&r.id===ref.id),c.id+' missing executed vector '+ref.id+' in '+w);
 const [tsName,rustName]=c.native_evidence;
 if(tsName)assert.ok(passed.some(n=>n.includes(tsName)),c.id+' missing native TS walk: '+tsName);
 if(rustName)assert.ok(rustLog.includes('test '+rustName+' ... ok'),c.id+' missing native Rust walk: '+rustName);
}
// Mixed towers and fault branches over durable directories; the replay flag re-checks a prior run.
const replayIndex=process.argv.indexOf('--replay');
run('node',['tools/check-materialization-m3-towers.mjs',...(replayIndex<0?[]:['--replay',resolve(process.argv[replayIndex+1])])],'towers');
const towers=JSON.parse(readFileSync(join(out,'M3-TOWERS.json')));
const executedTowers=new Set([...towers.executed.towers,...towers.executed.faults]);
for(const c of [...m3.cases,...m3.variants])for(const id of c.tower_evidence)assert.ok(executedTowers.has(id),c.id+' missing executed tower or fault '+id);
assert.equal(towers.fixed.length,6);assert.equal(towers.towers.length,9);assert.equal(towers.faults.length,18);
const git=args=>spawnSync('git',args,{cwd:root,encoding:'utf8'}).stdout.trim();
const states=Object.fromEntries(['executed','partial','specified'].map(s=>[s,[...m3.cases,...m3.variants].filter(c=>c.state===s).map(c=>c.id)]));
const coverage={format:'rhizomatic.materialization-m3-coverage/1',scope:'M3 slices A, B and C1: control image, planner, six lifecycle verbs, CAS outcomes, MR-20 readback over the shared schedule, durable fixture hosts, MR-18 fault points and mixed towers. Journal-backed sources, source races, rotation, shared-basis limits and erasure are not executed.',cases:m3.cases.map(c=>({...c,ts:c.state==='specified'?'not-run':'passed',rust:c.state==='specified'?'not-run':'passed'})),variants:m3.variants,states,tsTests:ts.numPassedTests,artifacts:['VECTOR-ASSERTIONS.json','TS-TESTS.json','ts.log','rust.log','M3-TOWERS.json','M3-CAPABILITIES.json','towers.log']};
const report={format:'rhizomatic-conformance-report/1',profile:'rhizomatic.materialization/1',source:{commit:git(['rev-parse','HEAD']),tree:git(['rev-parse','HEAD^{tree}']),clean:git(['status','--porcelain','--untracked-files=normal'])===''},status:'runtime_partial_review_pending',scope:'M3 control image, lifecycle verbs, readback, durable hosts, fault points and mixed towers over the shared schedule',witnesses:['ts','rust'],states,artifacts:coverage.artifacts,not_claimed:['M3 journal-backed sources and source races','M3 capacity rotation','M3 shared-basis limits','M3 support erasure','M4 cumulative acceptance','M5 Loam trial','independent review','source/control atomicity','execution proof']};
writeFileSync(join(out,'COVERAGE.json'),JSON.stringify(coverage,null,2)+'\n');writeFileSync(join(out,'REPORT.json'),JSON.stringify(report,null,2)+'\n');
console.log(`M3 lifecycle: ${states.executed.length} executed, ${states.partial.length} partial, ${states.specified.length} specified of ${m3.cases.length} cases and ${m3.variants.length} variants; ${ts.numPassedTests} TS tests; receipts equal in both witnesses; ${towers.fixed.length} fixed crossings, ${towers.towers.length} seeded towers, ${towers.faults.length} fault branches.`);
