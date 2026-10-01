import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const base=join(root,'contracts/command');
const read=name=>JSON.parse(readFileSync(join(base,name+'.json'),'utf8'));
function validate({cards,scenarios,plan,coverage,capabilities,bootstrap}){
 const unique=(items,label)=>{if(new Set(items).size!==items.length)throw Error(`duplicate ${label}`);};
 unique(cards.map(c=>c.id),'owner');const owners=new Set(cards.map(c=>c.id)); if(owners.size!==14)throw Error('missing semantic owner');
 for(const c of cards){for(const k of ['responsibility','lower_binding','upper_affordance','bootstrap_and_capabilities','observable_state_and_reconstruction','forbidden_semantics','first_delivery_success','later_portability_success'])if(typeof c[k]!=='string'||!c[k])throw Error(`missing contract ${c.id}.${k}`);for(const d of c.allowed_dependencies)if(!owners.has(d))throw Error('unknown dependency');for(const r of c.requirements)if(!/^R-(0[1-9]|[12][0-9]|3[0-4])$/.test(r))throw Error('unknown spec reference');}
 unique(scenarios.map(s=>s.id),'scenario');unique(coverage.map(c=>c.id),'coverage');
 const frozen=new Map(plan.flatMap(m=>m.required_cases.map(id=>[id,m.id])));
 if(frozen.size!==scenarios.length||scenarios.some(s=>frozen.get(s.id)!==s.milestone))throw Error('missing required case or changed allocation');
 if(coverage.length!==frozen.size||coverage.some(c=>frozen.get(c.id)!==c.milestone||!c.owners.length||c.owners.some(o=>!owners.has(o))))throw Error('missing coverage owner/case');
 for(const name of ['HyperSchemaSchema','SchemaSchema'])if(!/^1e20[0-9a-f]{64}$/.test(bootstrap.canonical_pins[name]))throw Error('invalid bootstrap pin');
 unique(capabilities.witnesses.map(w=>w.id),'witness');if(capabilities.witnesses.length!==4||['ts','rust','elixir','haskell'].some(id=>!capabilities.witnesses.some(w=>w.id===id)))throw Error('missing required witness');
 for(const w of capabilities.witnesses){if(w.profiles.length||w.stages.length)throw Error('capability needs executed evidence before advertisement');if(['elixir','haskell'].includes(w.id)&&w.conformance_level!==0)throw Error('lower witness level changed');}
}
const data={cards:read('BOUNDARIES').cards,scenarios:read('ACCEPTANCE').scenarios,plan:read('MILESTONES').milestones,coverage:read('coverage').scenarios,capabilities:read('capabilities'),bootstrap:read('bootstrap')};
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
 ['false capability',d=>d.capabilities.witnesses[0].profiles.push('rhizomatic.command/1'),/executed evidence/],
]){const broken=structuredClone(data);mutate(broken);let refused=false;try{validate(broken)}catch(e){if(!pattern.test(e.message))throw e;refused=true;}if(!refused)throw Error(`negative checker fixture accepted: ${name}`);}
const inventory=spawnSync(process.execPath,[join(root,'tools/command-inventory.mjs'),...(process.argv.includes('--self-test')?['--self-test']:[])],{encoding:'utf8'});if(inventory.status!==0)throw Error(inventory.stderr);process.stdout.write(inventory.stdout);
console.log(`Command M0 contracts: ${data.cards.length} owners; ${data.scenarios.length} frozen cases; no runtime capability claim.`);
