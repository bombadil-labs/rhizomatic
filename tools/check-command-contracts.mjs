import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const base=join(root,'contracts/command');
const read=name=>JSON.parse(readFileSync(join(base,name+'.json'),'utf8'));
function validate({cards,scenarios,plan,coverage,capabilities,bootstrap,towers,execution,api}){
 const unique=(items,label)=>{if(new Set(items).size!==items.length)throw Error(`duplicate ${label}`);};
 unique(cards.map(c=>c.id),'owner');const owners=new Set(cards.map(c=>c.id)); if(owners.size!==14)throw Error('missing semantic owner');
 for(const c of cards){for(const k of ['responsibility','lower_binding','upper_affordance','bootstrap_and_capabilities','observable_state_and_reconstruction','forbidden_semantics','first_delivery_success','later_portability_success'])if(typeof c[k]!=='string'||!c[k])throw Error(`missing contract ${c.id}.${k}`);for(const d of c.allowed_dependencies)if(!owners.has(d))throw Error('unknown dependency');for(const r of c.requirements)if(!/^R-(0[1-9]|[12][0-9]|3[0-4])$/.test(r))throw Error('unknown spec reference');}
 unique(scenarios.map(s=>s.id),'scenario');unique(coverage.map(c=>c.id),'coverage');
 const frozen=new Map(plan.flatMap(m=>m.required_cases.map(id=>[id,m.id])));
 if(frozen.size!==scenarios.length||scenarios.some(s=>frozen.get(s.id)!==s.milestone))throw Error('missing required case or changed allocation');
 if(coverage.length!==frozen.size||coverage.some(c=>frozen.get(c.id)!==c.milestone||!c.owners.length||c.owners.some(o=>!owners.has(o))))throw Error('missing coverage owner/case');
 for(const name of ['HyperSchemaSchema','SchemaSchema'])if(!/^1e20[0-9a-f]{64}$/.test(bootstrap.canonical_pins[name]))throw Error('invalid bootstrap pin');
 unique(capabilities.witnesses.map(w=>w.id),'witness');if(capabilities.witnesses.length!==4||['ts','rust','elixir','haskell'].some(id=>!capabilities.witnesses.some(w=>w.id===id)))throw Error('missing required witness');
 for(const c of coverage){
  const scenario=scenarios.find(s=>s.id===c.id);
  if(!['specified','implemented_unverified'].includes(c.state))throw Error('unknown coverage state');
  if(JSON.stringify([...c.required_witnesses].sort())!==JSON.stringify(['rust','ts']))throw Error('missing required coverage witness');
  if(new Set(c.requirements).size!==c.requirements.length||JSON.stringify([...c.requirements].sort())!==JSON.stringify([...scenario.requirements].sort()))throw Error('unknown or missing coverage requirement');
  if(!Array.isArray(c.tests)||c.tests.some(t=>typeof t!=='string'||!t)||new Set(c.tests).size!==c.tests.length)throw Error('invalid executable evidence references');
 }
 const stageContracts=towers.stages.map(s=>s.contract);unique(stageContracts,'stage contract');
 const selected=execution.cases.filter(f=>f.tower===true);unique(selected.map(f=>f.scenario),'tower scenario');
 if(JSON.stringify(selected.map(f=>f.scenario).sort())!==JSON.stringify([...towers.required_scenarios].sort()))throw Error('missing tower scenario');
 const equalSet=(a,b)=>Array.isArray(a)&&a.length===b.length&&new Set(a).size===a.length&&JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
 for(const w of capabilities.witnesses){
  if(!['supported','not_implemented'].includes(w.state))throw Error('unknown capability state');
  if(w.state==='not_implemented'&&(w.stages.length||Object.keys(w.stage_evidence??{}).length))throw Error('unsupported stage advertisement');
  if(!Array.isArray(w.profiles)||new Set(w.profiles).size!==w.profiles.length||w.profiles.some(id=>id!=='rhizomatic.command/1'))throw Error('unsupported profile capability');
  if(!equalSet(Object.keys(w.profile_evidence??{}),w.profiles))throw Error('profile needs external executed evidence requirements');
  for(const profile of w.profiles){
   const evidence=w.profile_evidence[profile];
   if(w.state!=='supported'||evidence.format!=='rhizomatic-command-acceptance-evidence/1'||!equalSet(evidence.required_cases,[...frozen.keys()]))throw Error('missing profile acceptance case inventory');
   if(evidence.requires_exact_commit!==true||evidence.requires_independent_review!==true||!equalSet(evidence.requires_existing_conformance,['ts','rust','elixir','haskell']))throw Error('missing external profile acceptance condition');
   if(!equalSet(Object.keys(evidence),['format','required_cases','requires_exact_commit','requires_independent_review','requires_existing_conformance']))throw Error('static profile self-certification is forbidden');
  }
  if(['elixir','haskell'].includes(w.id)&&(w.conformance_level!==0||w.stages.length||w.state!=='not_implemented'))throw Error('lower witness capability changed');
  if(w.state==='supported'){
   if(!equalSet(w.stages,stageContracts)||!equalSet(Object.keys(w.stage_evidence??{}),stageContracts))throw Error('missing or unknown stage capability');
   for(const stage of towers.stages){const expected=selected.flatMap(f=>f.steps.map(step=>`${f.id}/${step.id??'command'}/${stage.id}`));if(!equalSet(w.stage_evidence[stage.contract],expected))throw Error('missing or duplicate executed stage case');}
  }
 }
 unique(api.contracts.map(c=>c.id),'API contract');
 if(stageContracts.some(id=>!api.contracts.some(c=>c.id===id)))throw Error('missing API stage contract');
 for(const c of api.contracts)if(!c.id||!c.semantics||!c.owners.length||c.owners.some(o=>!owners.has(o))||!c.requirements.length||c.requirements.some(r=>c.spec==='spec/16-materialization.md' ? !/^MR-(0[1-9]|1[0-9]|2[0-4])$/.test(r) || !([...JSON.parse(readFileSync(join(root,'contracts/materialization/API.json'),'utf8')).contracts.filter(c=>c.milestone==='M1'||c.milestone==='M2').map(c=>c.id),'rhizomatic.hview-envelope/1','rhizomatic.syntax/materialization-program-budget/1'].includes(c.id)) : !/^R-(0[1-9]|[12][0-9]|3[0-4])$/.test(r)))throw Error('invalid API semantic contract');
}
const data={cards:read('BOUNDARIES').cards,scenarios:read('ACCEPTANCE').scenarios,plan:read('MILESTONES').milestones,coverage:read('coverage').scenarios,capabilities:read('capabilities'),bootstrap:read('bootstrap'),towers:read('TOWERS'),execution:JSON.parse(readFileSync(join(root,'vectors/command/execution.json'),'utf8')),api:read('API')};
validate(data);
if(process.argv.includes('--self-test'))for(const [name,mutate,pattern] of [
 ['duplicate coverage',d=>d.coverage[1]=d.coverage[0],/duplicate coverage/],
 ['duplicate scenario',d=>d.scenarios[1]=d.scenarios[0],/duplicate scenario/],
 ['unknown owner',d=>d.coverage[0].owners=['nonexistent'],/missing coverage/],
 ['garbage pin',d=>d.bootstrap.canonical_pins.HyperSchemaSchema='garbage',/invalid bootstrap pin/],
 ['missing rust',d=>d.capabilities.witnesses=d.capabilities.witnesses.filter(w=>w.id!=='rust'),/missing required witness/],
 ['missing contract',d=>delete d.cards[0].responsibility,/missing contract/],
 ['unknown requirement',d=>d.cards[0].requirements.push('R-99'),/unknown spec/],
 ['missing case',d=>d.scenarios.pop(),/missing required case/],
 ['false capability',d=>d.capabilities.witnesses[0].profiles=['rhizomatic.command/999'],/unsupported profile/],
 ['missing stage',d=>d.capabilities.witnesses[0].stages.pop(),/stage capability/],
 ['unknown stage',d=>d.capabilities.witnesses[0].stages[0]='unknown/1',/stage capability/],
 ['duplicate stage case',d=>{const v=Object.values(d.capabilities.witnesses[0].stage_evidence)[0];v[1]=v[0]},/executed stage case/],
 ['missing stage case',d=>Object.values(d.capabilities.witnesses[0].stage_evidence)[0].pop(),/executed stage case/],
 ['unsupported stage',d=>d.capabilities.witnesses[0].state='not_implemented',/unsupported stage/],
 ['unknown capability state',d=>d.capabilities.witnesses[0].state='unknown',/unknown capability state/],
 ['missing API semantics',d=>delete d.api.contracts[0].semantics,/API semantic/],
 ['unknown API owner',d=>d.api.contracts[0].owners.push('unknown'),/API semantic/],
 ['unknown coverage state',d=>d.coverage[0].state='unknown',/coverage state/],
 ['missing required witness',d=>d.coverage[0].required_witnesses.pop(),/coverage witness/],
 ['unknown coverage requirement',d=>d.coverage[0].requirements.push('R-99'),/coverage requirement/],
 ['missing API contract',d=>d.api.contracts.shift(),/missing API stage contract/],
 ['duplicate API contract',d=>d.api.contracts.push(d.api.contracts[0]),/duplicate API contract/],
 ['missing profile evidence contract',d=>delete d.capabilities.witnesses[0].profile_evidence,/external executed evidence/],
 ['missing profile acceptance case',d=>d.capabilities.witnesses[0].profile_evidence['rhizomatic.command/1'].required_cases.pop(),/acceptance case inventory/],
 ['duplicate profile acceptance case',d=>{const ids=d.capabilities.witnesses[0].profile_evidence['rhizomatic.command/1'].required_cases;ids[1]=ids[0]},/acceptance case inventory/],
 ['missing exact commit requirement',d=>d.capabilities.witnesses[0].profile_evidence['rhizomatic.command/1'].requires_exact_commit=false,/external profile acceptance condition/],
 ['missing independent review requirement',d=>d.capabilities.witnesses[0].profile_evidence['rhizomatic.command/1'].requires_independent_review=false,/external profile acceptance condition/],
 ['missing existing conformance requirement',d=>d.capabilities.witnesses[0].profile_evidence['rhizomatic.command/1'].requires_existing_conformance.pop(),/external profile acceptance condition/],
 ['static profile pass claim',d=>d.capabilities.witnesses[0].profile_evidence['rhizomatic.command/1'].status='passed',/self-certification/],
]){const broken=structuredClone(data);mutate(broken);let refused=false;try{validate(broken)}catch(e){if(!pattern.test(e.message))throw e;refused=true;}if(!refused)throw Error(`negative checker fixture accepted: ${name}`);console.log(`command-contract-case:${name}`);}
const inventory=spawnSync(process.execPath,[join(root,'tools/command-inventory.mjs'),...(process.argv.includes('--self-test')?['--self-test']:[])],{encoding:'utf8'});if(inventory.status!==0)throw Error(inventory.stderr);process.stdout.write(inventory.stdout);
console.log(`Command M0 contracts: ${data.cards.length} owners; ${data.scenarios.length} frozen cases; four stage capabilities; prospective profile requires external exact-source acceptance.`);

const vectors=JSON.parse(readFileSync(join(root,'vectors/command/descriptions.json'),'utf8'));
const fixtureIds=new Set(vectors.cases.map(c=>c.id));if(fixtureIds.size!==vectors.cases.length)throw Error('duplicate fixture ID');
for(const scenario of data.coverage.filter(c=>c.milestone==='M1')){
 const expected=vectors.cases.filter(c=>c.scenario===scenario.id).map(c=>'command-description-vectors:'+c.id).sort();
 if(!expected.length||JSON.stringify([...scenario.tests].sort())!==JSON.stringify(expected))throw Error(`dangling or missing executable fixture reference: ${scenario.id}`);
}
