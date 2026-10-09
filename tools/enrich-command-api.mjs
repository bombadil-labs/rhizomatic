// Reviewed semantic annotations are separate from the Rust AST's structural inventory.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const path=join(root,'contracts/command/rust-exports.json');
const inventory=JSON.parse(readFileSync(path,'utf8'));
const api=JSON.parse(readFileSync(join(root,'contracts/command/API.json'),'utf8')).contracts;
const specs={delta:'SPEC-1 identity/canonical codecs and SPEC-8 neutral membership',syntax:'SPEC-2 serializable grammar/explicit variables',algebra:'SPEC-2 HView data algebra',schema:'SPEC-3 registry identities and closure',resolve:'SPEC-2 pure term evaluation','resolve-kernel':'SPEC-5 resolution policies/View','schema-load':'SPEC-3 signed definition selection',reactor:'SPEC-4 explicit ingest/materialization lifecycle',principal:'SPEC-14 explicit principal roots/time/suppression',federation:'SPEC-6 receiver admission/durable state/host transport',storage:'SPEC-8 physical pack encoding',derivation:'SPEC-13 explicit binding/derivation callbacks',command:'SPEC-15 exact installed invocation','command-data':'SPEC-15 closed descriptions'};
for(const e of inventory.exports){
 const module=e.id.split(':')[1],symbol=e.symbol;
 let contract;
 if(module==='command_data')contract=/^(configuration_pointers|operation_pointers|request_pointers|outcome_pointers|write_)/.test(symbol)?'rhizomatic.command/1/request-construction':'rhizomatic.command/1/description-validation';
 if(module==='command')contract=['read_result','CommandResult','ReadResultContext'].includes(symbol)?'rhizomatic.command/1/outcome-readback':symbol==='ResponseSigner'?'rhizomatic.command/1/host-boot':'rhizomatic.command/1';
 if(module==='resolution'&&symbol==='decode_view')contract='rhizomatic.resolve-kernel/view-codec/1';
 if(module==='sign'&&symbol==='verify_canonical_delta')contract='rhizomatic.delta/canonical-appearance/1';
 if(module==='schema_deltas'&&['read_exact_definition','ExactDefinition'].includes(symbol))contract='rhizomatic.schema-load/exact-definition/1';
 if(module==='schema'&&['select_program','ProgramSelection','SelectedProgram','ProgramSelectionError','ProgramInspection','ProgramReference','ProgramSort','inspect_program_term','inspect_program_reading'].includes(symbol))contract='rhizomatic.schema/selected-program/1';
 if(module==='ordinary_journal_peer'&&['capture_existing_ordinary_source','OrdinarySourceCapture'].includes(symbol))contract='rhizomatic.federation/coherent-source/1';
 if(module==='reading_appearance'||module==='evidence_codec')contract='rhizomatic.syntax/reading-appearance/1';
 if(module==='hview_envelope')contract=symbol==='encode_hview_envelope'?'rhizomatic.hview-envelope/1/encode':symbol==='decode_hview_envelope'?'rhizomatic.hview-envelope/1/decode':'rhizomatic.hview-envelope/1';

 if(module==='materialization_data')contract='rhizomatic.materialization/1/description';
 if(module==='materialization_control')contract='rhizomatic.materialization-control/1';
 if(module==='materialization_lifecycle')contract='rhizomatic.materialization/1/control-execute';
 if(module==='materialization_store')contract='rhizomatic.materialization/1/control-store';
 if(module==='materialization_source')contract='rhizomatic.materialization/1/capture';
 if(module==='materialization_input'||module==='materialization_values')contract='rhizomatic.materialization/1/input-preflight';
 if(module==='materialization_result'||module==='materialization_basis'||module==='materialization_evidence')contract='rhizomatic.materialization/1/outcome-readback';
 if(module==='materialization_command')contract=symbol==='preflight_materialization_input'||symbol==='MaterializationInputPreflight'?'rhizomatic.materialization/1/input-preflight':symbol==='MaterializationEndpoint::invoke'?'rhizomatic.materialization/gather/1':'rhizomatic.materialization/1/host-boot';
 if((module==='schema_deltas'&&symbol==='read_materialization_definitions')||(module==='schema'&&symbol==='select_materialization_program'))contract='rhizomatic.materialization/gather/1';
 if(module==='evaluation_budget'||(module==='eval'&&symbol==='eval_materialization_term_at'))contract='rhizomatic.materialization/gather/1';
 const named=api.find(c=>c.id===contract);
 if(named&&!named.owners.includes(e.owner))throw Error('named semantic owner mismatch');
 const reexport=e.classification==='compatibility_reexport'||e.definition==='reexport';
 const host=contract==='rhizomatic.materialization/1/host-boot'||symbol==='MaterializationSourceCapability'||module==='wasm'||symbol==='ResponseSigner'||(e.owner==='federation'&&(/Store/.test(symbol)||['serve_peer','pull_from_url','write_durable_peer_state','read_durable_peer_state','write_peer_state','read_peer_state','admit_signed_loose_ordinary_transfer'].includes(symbol)));
 e.contract=contract??`rhizomatic.${e.owner}/native-api/1`;
 e.classification=reexport?'compatibility_reexport':host?'host_capability':named?'portable_contract':'native_extension';
 e.semantics=named?`${module}::${symbol}: ${named.semantics} ${named.requirements.join(', ')}.`:`Native ${module}::${symbol} implements ${specs[e.owner]??'owner-preserving aggregate exports'}. Native callbacks/options are explicit caller inputs; no additional serialized portability is inferred.${host?' This interface observes only explicitly passed host capabilities.':''}${reexport?' The reexport preserves its defining owner.':''}`;
}
writeFileSync(path,JSON.stringify(inventory,null,2)+'\n');
console.log(`Rust semantic annotations: ${inventory.exports.length} exports bound to declared owner contracts.`);
