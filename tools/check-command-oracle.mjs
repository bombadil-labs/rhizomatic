// Negative-test sensitivity: a valid accepted artifact mislabeled invalid MUST fail the suite.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const fixture=JSON.parse(readFileSync(join(root,'vectors/command/descriptions.json'),'utf8'));
const selected=['view','bindings','configuration','operation','request','outcome'].map(kind=>fixture.cases.find(c=>c.kind===kind&&c.expected.valid));
if(selected.some(c=>!c))throw Error('missing positive sensitivity case');
const dir=mkdtempSync(join(tmpdir(),'command-oracle-'));
try{
 const path=join(dir,'accepted-as-invalid.json');
 writeFileSync(path,JSON.stringify({...fixture,cases:selected.map(c=>({...c,expected:{valid:false}}))}));
 const run=spawnSync(process.execPath,[join(root,'implementations/ts/node_modules/vitest/vitest.mjs'),'run','test/command-description-vectors.test.ts','--reporter=json','-t','command shared M1 descriptions'],{cwd:join(root,'implementations/ts'),env:{...process.env,COMMAND_VECTOR_PATH:path},encoding:'utf8'});
 const report=JSON.parse(run.stdout);
 if(run.status!==1||report.numFailedTests!==6||report.numPassedTests!==0)throw Error(`oracle sensitivity failed: status ${run.status}; ${run.stdout} ${run.stderr}`);
 console.log('Command negative oracles reject accepted artifacts for all six codec sorts (6 expected test failures).');
}finally{rmSync(dir,{recursive:true,force:true});}
