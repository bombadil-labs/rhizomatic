// M2 batch evidence. M3 variants stay explicitly allocated, not implemented or certified here.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {expectedMaterializationAssertions,materializationAssertionReceipts,validateMaterializationAssertions,materializationAccountingSensitivity} from './check-materialization-accounting.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=resolve(process.env.M2_ARTIFACT_DIR??join(root,'artifacts/materialization-m2'));mkdirSync(out,{recursive:true});
const read=p=>JSON.parse(readFileSync(join(root,p)));
const cases=read('contracts/materialization/M2-CASES.json').cases;
const required=read('contracts/materialization/MILESTONES.json').milestones.find(m=>m.id==='M2').required_cases.map(id=>id+'::batch').sort();
assert.equal(required.length,27);assert.deepEqual(cases.map(c=>c.id).sort(),required);
const run=(command,args,name)=>{
 const p=spawnSync(command,args,{cwd:root,encoding:'utf8',maxBuffer:50*1024*1024,env:{...process.env,M2_ARTIFACT_DIR:out}});
 const log=p.stdout+p.stderr;writeFileSync(join(out,name+'.log'),log);assert.equal(p.status,0,name+': '+log);return log;
};
const tsLog=run(join(root,'implementations/ts/node_modules/.bin/vitest'),['run','--root','implementations/ts','test/materialization-command.test.ts','test/materialization-source.test.ts','test/materialization-description.test.ts','test/materialization-evaluation-budget.test.ts','test/materialization-retention.test.ts','--reporter=default','--reporter=json','--outputFile',join(out,'TS-TESTS.json')],'ts');
const ts=JSON.parse(readFileSync(join(out,'TS-TESTS.json')));assert.equal(ts.success,true);assert.equal(ts.numFailedTests,0);assert.equal(ts.numPendingTests,0);
const rustLog=run(process.env.CARGO??'cargo',['test','--locked','--manifest-path','implementations/rust/Cargo.toml','--test','materialization_command','--test','materialization_source','--test','materialization_description','--','--nocapture'],'rust');
const rustNative=run(process.env.CARGO??'cargo',['test','--locked','--manifest-path','implementations/rust/Cargo.toml','--test','command_runtime','materialization_retention_is_inert','--','--nocapture'],'rust-retention');
run(process.env.CARGO??'cargo',['test','--locked','--manifest-path','implementations/rust/Cargo.toml','--lib','deterministic_logical_visitation','--','--nocapture'],'rust-visitation');
const corpora=Object.fromEntries(['commands','command-descriptions','source-snapshot'].map(name=>[name,readFileSync(join(root,'vectors/materialization',name+'.json'))]));
const assertions={format:'rhizomatic.materialization-m2-vector-assertions/1',note:'Counts, corpus identity and missing-evidence probes supplement semantic assertions and independent review, not a proof of arbitrary assertion meaning.'};
for(const [witness,log] of [['ts',tsLog],['rust',rustLog]]){
 const expected=expectedMaterializationAssertions(corpora,witness),actual=materializationAssertionReceipts(log);
 validateMaterializationAssertions(expected,actual);assertions[witness]={records:actual,negatives:materializationAccountingSensitivity(expected)};
}
writeFileSync(join(out,'VECTOR-ASSERTIONS.json'),JSON.stringify(assertions,null,2)+'\n');
const nativeNames={cmd_inert_retention:'cmd_inert_retention::batch actual profile1 journal preserves native catalogs and grants',cmd_input_snapshot:'native inputs and two trusted times survive asynchronous interleaving',cmd_public_basis_privacy:'public Basis hides private raw inventories and labels commitments'};
const passed=ts.testResults.flatMap(r=>r.assertionResults).filter(t=>t.status==='passed').map(t=>t.fullName);
for(const [id,name]of Object.entries(nativeNames)){
 assert.ok(passed.some(n=>n.includes(name)),id+' missing native TS assertions');
 assert.ok((rustLog+rustNative).includes('materialization-native:'+id+'::batch'),id+' missing native Rust assertions');
}
for(const c of cases){
 assert.ok(c.vector_assertions.length>0);
 for(const w of ['ts','rust'])for(const ref of c.vector_assertions)assert.ok(assertions[w].records.some(r=>r.corpus===ref.corpus&&r.group===ref.group&&r.id===ref.id),c.id+' missing executed vector '+ref.id);
}
run('node',['tools/check-materialization-towers.mjs'],'towers');
const towers=JSON.parse(readFileSync(join(out,'EVIDENCE.json')));assert.equal(towers.fixed.length,16);assert.equal(towers.towers.length,24);assert.equal(towers.refusalBranches.length,15);
const git=args=>spawnSync('git',args,{cwd:root,encoding:'utf8'}).stdout.trim();
const coverage={format:'rhizomatic.materialization-m2-coverage/1',scope:'M2 batch only; six M3 lifecycle variants remain specified.',cases:cases.map(c=>({...c,ts:'passed',rust:'passed'})),tsTests:ts.numPassedTests,nativeInputSnapshot:{ts:'Executed concurrent copied-input/time interleaving and local nonfinite framing refusal.',rust:'Safe owned/borrowed values prohibit concurrent mutation through the invocation slice; explicit-time corpus and framing refusal executed. Async native object-mutation schedule is unrepresentable, not a claimed Rust async port.'},artifacts:['VECTOR-ASSERTIONS.json','TS-TESTS.json','rust.log','rust-retention.log','rust-visitation.log','EVIDENCE.json']};
const report={format:'rhizomatic-conformance-report/1',profile:'rhizomatic.materialization/1',source:{commit:git(['rev-parse','HEAD']),tree:git(['rev-parse','HEAD^{tree}']),clean:git(['status','--porcelain','--untracked-files=normal'])===''},status:'runtime_passed_review_pending',scope:'M2 batch gather/resolve/input-preflight/readback only',witnesses:['ts','rust'],cases:coverage.cases,builds:towers.builds,toolchains:towers.toolchains,artifacts:coverage.artifacts,not_claimed:['M3 lifecycle variants','M4 cumulative acceptance','M5 Loam trial','independent review','Elixir/Haskell M2 support','source/control atomicity','execution proof']};
writeFileSync(join(out,'COVERAGE.json'),JSON.stringify(coverage,null,2)+'\n');writeFileSync(join(out,'REPORT.json'),JSON.stringify(report,null,2)+'\n');
console.log(`M2 batch: ${cases.length} case obligations with executed corpus receipts/native probes; ${ts.numPassedTests} TS tests;16 fixed crossings,24 seeded towers,15 refusal branches/exact replay.`);
