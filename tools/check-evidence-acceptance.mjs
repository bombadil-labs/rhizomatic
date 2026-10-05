// M1-only executed case accounting. Full witness gates remain separate required CI jobs.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {expectedVectorEvidence,readAssertionEvidence,validateAssertionEvidence,accountingSensitivity} from './check-evidence-accounting.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=resolve(process.env.M1_ARTIFACT_DIR??join(root,'artifacts/materialization-m1'));mkdirSync(out,{recursive:true});
const acceptance=JSON.parse(readFileSync(join(root,'contracts/materialization/ACCEPTANCE.json')));
const required=acceptance.scenarios.filter(c=>c.milestone==='M1').map(c=>c.id).sort();
assert.equal(required.length,15);
const run=(cmd,args,name)=>{const r=spawnSync(cmd,args,{cwd:root,encoding:'utf8',maxBuffer:40*1024*1024,env:{...process.env,M1_ARTIFACT_DIR:out}});writeFileSync(join(out,`${name}.log`),r.stdout+r.stderr);assert.equal(r.status,0,`${name}: ${r.stdout}\n${r.stderr}`);return r.stdout+r.stderr;};
const tsLog=run(join(root,'implementations/ts/node_modules/.bin/vitest'),['run','--root','implementations/ts','test/evidence-envelope.test.ts','test/evidence-verification.test.ts','--reporter=default','--reporter=json','--outputFile',join(out,'TS-TESTS.json')],'ts');
const ts=JSON.parse(readFileSync(join(out,'TS-TESTS.json')));assert.equal(ts.success,true);assert.equal(ts.numFailedTests,0);
const discovered=ts.testResults.flatMap(r=>r.assertionResults).filter(a=>a.status==='passed').flatMap(a=>a.fullName.match(/env_[a-z_]+/g)??[]);
const rust=run(process.env.CARGO??'cargo',['test','--locked','--manifest-path','implementations/rust/Cargo.toml','--test','evidence_envelope','--test','evidence_budget','--test','evidence_verification','--','--nocapture'],'rust');
const rustCases=[...rust.matchAll(/materialization-case:\"?(env_[a-z_]+)\"?/g)].map(m=>m[1]);
const codecOnly=required.filter(id=>id!=='env_fixed_mixed_routes');
assert.deepEqual([...new Set(discovered)].filter(id=>id!=='env_fixed_mixed_routes').sort(),codecOnly);
assert.deepEqual([...new Set(rustCases)].sort(),codecOnly);
const vectorBytes=readFileSync(join(root,'vectors/materialization/evidence-envelope.json'));
const vectorEvidence={format:'rhizomatic.materialization-vector-assertions/1',note:'Executed assertion counters and corpus/vector identity receipts supplement passing tests and independent review; metadata alone cannot prove arbitrary assertions.'};
for(const [witness,log] of [['ts',tsLog],['rust',rust]]){
 const expected=expectedVectorEvidence(vectorBytes,witness),actual=readAssertionEvidence(log);validateAssertionEvidence(expected,actual);
 vectorEvidence[witness]={vectors:actual.length,records:actual,sensitivityNegatives:accountingSensitivity(expected)};
}
writeFileSync(join(out,'VECTOR-ASSERTIONS.json'),JSON.stringify(vectorEvidence,null,2)+'\n');
run('node',['tools/check-evidence-towers.mjs'],'towers');
const towers=JSON.parse(readFileSync(join(out,'EVIDENCE.json')));assert.equal(towers.fixed.length,8);assert.equal(towers.towers.length,12);
const git=args=>spawnSync('git',args,{cwd:root,encoding:'utf8'}).stdout.trim();
const coverage={format:'rhizomatic.materialization-m1-coverage/1',scope:'M1 only; no M2-M5 or review certification',cases:required.map(id=>({id,ts:'passed',rust:'passed',evidence:id==='env_fixed_mixed_routes'?['EVIDENCE.json']:['TS-TESTS.json','rust.log']})),tsTests:ts.numPassedTests,vectorEvidence:'VECTOR-ASSERTIONS.json',
 nativeCycle:{ts:'Explicit object-cycle rejection executed.',rust:'Structurally unrepresentable in safe owned HView/AST types (no native handles); bounded hostile tree decoding executed.'},towerEvidence:'EVIDENCE.json'};
const report={format:'rhizomatic-conformance-report/1',profile:'rhizomatic.hview-envelope/1',source:{commit:git(['rev-parse','HEAD']),tree:git(['rev-parse','HEAD^{tree}']),clean:git(['status','--porcelain','--untracked-files=normal'])===''},status:'runtime_passed_review_pending',ports:['rhizomatic.syntax/reading-appearance/1','rhizomatic.hview-envelope/1/encode','rhizomatic.hview-envelope/1/decode'],witnesses:['ts','rust'],cases:coverage.cases,builds:towers.builds,toolchains:towers.toolchains,artifacts:['COVERAGE.json','EVIDENCE.json','VECTOR-ASSERTIONS.json','TS-TESTS.json','rust.log'],not_claimed:['M2','M3','M4','M5','independent-review','Elixir/Haskell M1 support']};
writeFileSync(join(out,'REPORT.json'),JSON.stringify(report,null,2)+'\n');
writeFileSync(join(out,'COVERAGE.json'),JSON.stringify(coverage,null,2)+'\n');console.log(`M1 acceptance: ${required.length} case IDs executed; ${ts.numPassedTests} TS tests; Rust shared schedules + syntax/fix/binding/metadata probes; fixed directions and three towers/replay per fixture.`);
