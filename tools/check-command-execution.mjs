// Real homogeneous stage evidence against independently authored signed/state oracles.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { prepareWitnesses } from './command-tower-process.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const fixtures=JSON.parse(readFileSync(join(root,'vectors/command/execution.json'),'utf8'));
const spec=JSON.parse(readFileSync(join(root,'contracts/command/TOWERS.json'),'utf8'));
const selected=fixtures.cases.filter(f=>f.tower===true||f.peerComparison||f.execution===true);
if(selected.length!==8+spec.required_execution_regressions.length||spec.required_scenarios.some(s=>selected.filter(f=>f.tower&&f.scenario===s).length!==1)||spec.required_execution_regressions.some(id=>selected.filter(f=>f.execution&&f.id===id).length!==1))throw Error('missing/duplicate explicit runtime fixtures');
const prepared=await prepareWitnesses(root);
const report={format:'rhizomatic-command-stage-evidence/1',commit:prepared.commit,witnesses:[]};
const directory=mkdtempSync(join(tmpdir(),'command-stage-evidence-'));
const assert=(actual,expected,label)=>{if(!isDeepStrictEqual(actual,expected))throw Error(`${label}\nactual:${JSON.stringify(actual)}\nexpected:${JSON.stringify(expected)}`);};
try {
for(const id of ['ts','rust']){
 const witness={id,stages:Object.fromEntries(spec.stages.map(s=>[s.contract,[]]))};
 for(const fixture of selected){
  const storePath=join(directory,id,fixture.id,'journal.json');mkdirSync(dirname(storePath),{recursive:true});
  const observations=new Map();
  for(const step of fixture.steps){
   if(!step.expected?.oracle||!step.expected.outcome)throw Error('missing independent oracle');
   const context=structuredClone(step.context);context.storePath=storePath;
   for(const binding of context.construction.bind??[]){
    if(binding.role!=='rhizomatic.command.expected-head'||binding.observation.field!=='head')throw Error('unsupported explicit observation binding');
    const observation=observations.get(binding.observation.step);
    if(!observation)throw Error('missing previous observation');
    const heads=context.construction.request.claims.pointers.filter(p=>p.role===binding.role);
    if(heads.length!==1)throw Error('ambiguous expected head binding');
    heads[0].target=observation.head;
   }
   let artifact,outcome,observed;
   for(const stage of spec.stages){
    const output=await prepared.adapter(id,{mode:stage.id,scenario:fixture.scenario,context,
      ...(artifact?{artifact}:{}),...(outcome?{outcome}: {})});
    const label=`${id}/${fixture.id}/${step.id}/${stage.id}`;
    if(stage.id==='construct'){assert(output,{artifact:step.expected.artifact},label);artifact=output.artifact;}
    else if(stage.id==='validate')assert(output,{artifact:step.expected.artifact,verdict:{valid:true}},label);
    else if(stage.id==='execute'){assert(output,{outcome:step.expected.outcome,observed:step.expected.observed},label);outcome=output.outcome;observed=output.observed;}
    else assert(output,step.expected.result,label);
    if(fixture.tower)witness.stages[stage.contract].push({id:`${fixture.id}/${step.id}/${stage.id}`,status:'passed'});
   }
   observations.set(step.id,observed);
  }
 }
 report.witnesses.push(witness);
}
const index=process.argv.indexOf('--out');
if(index!==-1){if(!process.argv[index+1])throw Error('missing --out path');writeFileSync(resolve(process.argv[index+1]),JSON.stringify(report,null,2)+'\n');}
console.log(`Command execution: ${selected.length} independently oracled fixtures passed every serialized stage in TS and Rust at ${prepared.commit}.`);
} finally {rmSync(directory,{recursive:true,force:true});}
