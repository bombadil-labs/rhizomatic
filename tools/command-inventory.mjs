import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { resolve, relative, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const ts=createRequire(join(root,'implementations/ts/package.json'))('typescript');
const src=join(root,'implementations/ts/src');
const walk=d=>readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(d,e.name)):e.name.endsWith('.ts')?[join(d,e.name)]:[]);
const files=walk(src).sort();
const program=ts.createProgram(files,{module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,target:ts.ScriptTarget.ES2022,skipLibCheck:true});
const checker=program.getTypeChecker();
const actual=[];
for(const file of files){
 const source=program.getSourceFile(file), mod=checker.getSymbolAtLocation(source);
 if(!mod)continue;
 for(const symbol of checker.getExportsOfModule(mod)){
  const original=symbol.flags&ts.SymbolFlags.Alias?checker.getAliasedSymbol(symbol):symbol;
  const declaration=original.declarations?.find(d=>d.getSourceFile().fileName.startsWith(src));
  const ownerFile=declaration?relative(src,declaration.getSourceFile().fileName):relative(src,file);
  const owner=ownerFile.split('/')[0];
  actual.push({id:`ts:${relative(src,file)}:${symbol.name}`,owner:ownerFile.includes('/')?owner:'aggregate',symbol:symbol.name,source:relative(root,file),definition:declaration?relative(root,declaration.getSourceFile().fileName):relative(root,file)});
  if(declaration && (ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration))) {
   // getProperties on a union returns only common members. Every branch is public API.
   const properties=type=>type.isUnionOrIntersection()?type.types.flatMap(properties):type.getProperties();
   const type=checker.getTypeAtLocation(declaration);
   const members=ts.isTypeAliasDeclaration(declaration)?[...new Map(properties(type).map(m=>[m.name,m])).values()]:type.getProperties();
   for(const member of members){
    const memberDeclaration=member.declarations?.find(d=>d.getSourceFile().fileName.startsWith(src));
    if(!memberDeclaration || memberDeclaration.modifiers?.some(m=>[ts.SyntaxKind.PrivateKeyword,ts.SyntaxKind.ProtectedKeyword].includes(m.kind)))continue;
    const name=memberDeclaration.name&&ts.isComputedPropertyName(memberDeclaration.name)?memberDeclaration.name.getText():member.name;
    actual.push({id:`ts:${relative(src,file)}:${symbol.name}#${name}`,owner:ownerFile.includes('/')?owner:'aggregate',symbol:`${symbol.name}.${name}`,source:relative(root,file),definition:relative(root,memberDeclaration.getSourceFile().fileName)});
   }
   if(ts.isClassDeclaration(declaration))for(const member of declaration.members){
    if(!member.name || !member.modifiers?.some(m=>m.kind===ts.SyntaxKind.StaticKeyword) || member.modifiers?.some(m=>[ts.SyntaxKind.PrivateKeyword,ts.SyntaxKind.ProtectedKeyword].includes(m.kind)))continue;
    const name=member.name.getText();
    actual.push({id:`ts:${relative(src,file)}:${symbol.name}#static:${name}`,owner:ownerFile.includes('/')?owner:'aggregate',symbol:`${symbol.name}.${name}`,source:relative(root,file),definition:relative(root,declaration.getSourceFile().fileName)});
   }
  }
 }
}
const path=join(root,'contracts/command/ts-exports.json');
const api=JSON.parse(readFileSync(join(root,'contracts/command/API.json'),'utf8')).contracts;
const documents={delta:'SPEC-1 Delta identity/JSON/CBOR; SPEC-8 container-neutral membership',syntax:'SPEC-2 serializable grammar and explicit binding rules',algebra:'SPEC-2 HView algebra',schema:'SPEC-3 registry name/hash lookup',resolve:'SPEC-2 evaluation and explicit governance', 'resolve-kernel':'SPEC-5 resolution policies and canonical View', 'schema-load':'SPEC-3 self-hosted definition loading',reactor:'SPEC-4 explicit reactor/materialization lifecycle',principal:'SPEC-14 explicit principal evidence/suppression',federation:'SPEC-6 explicit admission/durability/transport capabilities',storage:'SPEC-8 physical pack representation',derivation:'SPEC-13 caller-selected derivation/binding functions','command-data':'SPEC-15 closed signed description grammar',command:'SPEC-15 selected endpoint invocation'};
function classification(e){
 let contract;
 if(e.definition.endsWith('/command-data/codec.ts'))contract=['writeCommandDescription','commandDescriptionClaims'].includes(e.symbol)?'rhizomatic.command/1/request-construction':'rhizomatic.command/1/description-validation';
 if(e.definition.endsWith('/command/read-result.ts'))contract='rhizomatic.command/1/outcome-readback';
 if(e.definition.endsWith('/command/endpoint.ts'))contract=(e.symbol.startsWith('CommandBoot')||e.symbol.startsWith('CommandSigner'))?'rhizomatic.command/1/host-boot':'rhizomatic.command/1';
 if(e.symbol==='decodeView')contract='rhizomatic.resolve-kernel/view-codec/1';
 if(e.symbol==='verifyCanonicalDelta')contract='rhizomatic.delta/canonical-appearance/1';
 if(e.definition.endsWith('/schema-load/command-definitions.ts'))contract='rhizomatic.schema-load/exact-definition/1';
 if(e.definition.endsWith('/schema/command-program.ts'))contract='rhizomatic.schema/selected-program/1';
 if(['captureOrdinaryJournalSource','OrdinaryJournalCapture'].includes(e.symbol))contract='rhizomatic.federation/coherent-source/1';
 if(e.definition.endsWith('/syntax/reading-appearance.ts') || ['EvidenceCodecError','EvidenceCodecError.code','ReadingAppearanceLimits','ReadingAppearanceLimits.artifactBytes','ReadingAppearanceLimits.syntaxDepth','ReadingAppearanceLimits.syntaxNodes','DEFAULT_READING_APPEARANCE_LIMITS'].includes(e.symbol))contract='rhizomatic.syntax/reading-appearance/1';
 if(e.definition.endsWith('/algebra/hview-envelope.ts'))contract=e.symbol==='encodeHViewEnvelope'?'rhizomatic.hview-envelope/1/encode':e.symbol==='decodeHViewEnvelope'?'rhizomatic.hview-envelope/1/decode':'rhizomatic.hview-envelope/1';
 const reexport=e.source!==e.definition;
 const named=api.find(c=>c.id===contract);
 return {...e,contract:contract??`rhizomatic.${e.owner}/native-api/1`,classification:reexport?'compatibility_reexport':contract==='rhizomatic.command/1/host-boot'?'host_capability':named?'portable_contract':'native_extension',semantics:named?`${e.symbol}: ${named.semantics} ${named.requirements.join(', ')}; definition ${e.definition}.`:`Native ${e.owner} API ${e.symbol} implements ${documents[e.owner]??'aggregate owner-preserving exports'} at ${e.definition}. Native callbacks/options remain explicit caller inputs; this symbol does not advertise an additional serialized portable contract.${reexport?' Reexport preserves the defining owner.':''}`};
}
if(process.argv.includes('--adopt')){
 const old=(()=>{try{return JSON.parse(readFileSync(path,'utf8')).exports}catch{return[]}})();
 const known=new Map(old.map(e=>[e.id,e]));
 const live=new Map(actual.map(e=>[e.id,e]));
 const ordered=[...old.filter(e=>live.has(e.id)).map(e=>live.get(e.id)),...actual.filter(e=>!known.has(e.id))];
 const exports=ordered.map(classification);
 writeFileSync(path,JSON.stringify({format:'rhizomatic-semantic-api-inventory/1',witness:'ts',exports},null,2)+'\n');
}
const cards=JSON.parse(readFileSync(join(root,'contracts/command/BOUNDARIES.json'),'utf8'));
const owners=new Set(cards.cards.map(c=>c.id));
const contracts=new Set(cards.cards.map(c=>`rhizomatic.${c.id}/native-api/1`));
contracts.add('rhizomatic.aggregate/native-api/1');
for(const c of api)contracts.add(c.id);
const inventory=JSON.parse(readFileSync(path,'utf8')).exports;
function validateInventory(entries){
const known=new Map(entries.map(e=>[e.id,e]));
if(known.size!==entries.length)throw Error('duplicate export inventory entry');
for(const e of entries)if(!contracts.has(e.contract)||!cards.export_classifications.includes(e.classification)||!e.semantics||(!owners.has(e.owner)&&e.owner!=='aggregate')|| (e.contract!==`rhizomatic.${e.owner}/native-api/1`&&!api.find(c=>c.id===e.contract)?.owners.includes(e.owner)))throw Error(`invalid export contract/classification: ${e.id}`);
for(const e of actual){const k=known.get(e.id);if(!k)throw Error(`unclassified public export: ${e.id}`);if(!k.semantics||k.owner!==e.owner||k.definition!==e.definition)throw Error(`invalid export classification: ${e.id}`);known.delete(e.id);}
if(known.size)throw Error(`removed or changed exports: ${[...known.keys()].join(', ')}`);
}
validateInventory(inventory);
if(process.argv.includes("--self-test"))for(const [name,mutate] of [
 ['missing export',es=>es.pop()],['missing classification',es=>delete es[0].classification],
 ['missing contract',es=>delete es[0].contract],['unknown contract',es=>es[0].contract="unknown"],
 ['duplicate export',es=>es[1]=es[0]],['wrong contract owner',es=>es[0].contract='rhizomatic.command/1'],
 ['missing semantics',es=>delete es[0].semantics],
]){const broken=structuredClone(inventory);mutate(broken);let failed=false;try{validateInventory(broken)}catch{failed=true;}if(!failed)throw Error(`inventory negative accepted: ${name}`);console.log(`command-inventory-case:${name}`);}
console.log(`TS semantic inventory: ${actual.length} classified exported symbols (compiler-resolved aliases included).`);
