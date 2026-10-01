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
 }
}
const path=join(root,'contracts/command/ts-exports.json');
if(process.argv.includes('--adopt')){
 const old=(()=>{try{return JSON.parse(readFileSync(path,'utf8')).exports}catch{return[]}})();
 const known=new Map(old.map(e=>[e.id,e]));
 const exports=actual.map(e=>known.get(e.id)??({...e,contract:`rhizomatic.${e.owner}/native-api/1`,classification:e.source!==e.definition?'compatibility_reexport':['federation','principal','derivation','reactor'].includes(e.owner)?'native_extension':'declared_intrinsic',semantics:e.source!==e.definition?`Reexports ${e.symbol} from ${e.definition}; interpretation remains with ${e.owner}.`:`Existing ${e.owner} API ${e.symbol}; native arguments select its documented SPEC behavior. Its existence does not advertise command or later ecosystem portability.`}));
 writeFileSync(path,JSON.stringify({format:'rhizomatic-semantic-api-inventory/1',witness:'ts',exports},null,2)+'\n');
}
const cards=JSON.parse(readFileSync(join(root,'contracts/command/BOUNDARIES.json'),'utf8'));
const owners=new Set(cards.cards.map(c=>c.id));
const contracts=new Set(cards.cards.map(c=>`rhizomatic.${c.id}/native-api/1`));
contracts.add('rhizomatic.aggregate/native-api/1');
const inventory=JSON.parse(readFileSync(path,'utf8')).exports;
function validateInventory(entries){
const known=new Map(entries.map(e=>[e.id,e]));
if(known.size!==entries.length)throw Error('duplicate export inventory entry');
for(const e of entries)if(!contracts.has(e.contract)||!cards.export_classifications.includes(e.classification)||!e.semantics||(!owners.has(e.owner)&&e.owner!=='aggregate'))throw Error(`invalid export contract/classification: ${e.id}`);
for(const e of actual){const k=known.get(e.id);if(!k)throw Error(`unclassified public export: ${e.id}`);if(!k.semantics||k.owner!==e.owner||k.definition!==e.definition)throw Error(`invalid export classification: ${e.id}`);known.delete(e.id);}
if(known.size)throw Error(`removed or changed exports: ${[...known.keys()].join(', ')}`);
}
validateInventory(inventory);
if(process.argv.includes("--self-test"))for(const mutate of [es=>es.pop(),es=>delete es[0].classification,es=>delete es[0].contract,es=>es[0].contract="unknown",es=>es[1]=es[0]]){const broken=structuredClone(inventory);mutate(broken);let failed=false;try{validateInventory(broken)}catch{failed=true;}if(!failed)throw Error("inventory negative accepted");}
console.log(`TS semantic inventory: ${actual.length} classified exported symbols (compiler-resolved aliases included).`);
