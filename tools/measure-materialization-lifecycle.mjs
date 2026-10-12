// M4 lifecycle measurement runner: the fixed nested Bed fixture and the source-size sweep through
// install, replace, fresh restore and fresh read, in both witnesses. Instrumentation is confined to disposable build copies: a
// counter is inserted into each witness's exact strict signature verifier and nothing else.
// Outcomes and images are checked against the generator's goldens inside each host; canonical
// byte lengths must agree between the witnesses. No timing threshold, raised limit or shortcut.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,cpSync,readdirSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=resolve(process.env.M4_ARTIFACT_DIR??join(root,'artifacts/materialization-m4'));
const fixtures=join(out,'lifecycle-measurement-fixtures'),build=join(out,'lifecycle-measurement-build');mkdirSync(build,{recursive:true});
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const run=(cmd,args,options={})=>{const p=spawnSync(cmd,args,{cwd:root,encoding:'utf8',maxBuffer:200*1024*1024,...options});assert.equal(p.status,0,p.stdout+'\n'+p.stderr);return p;};
run(join(root,'implementations/ts/node_modules/.bin/tsx'),['implementations/ts/tools/gen-materialization-command-vectors.ts'],{env:{...process.env,M4_MEASUREMENT_DIR:fixtures}});
assert.equal(run('git',['status','--porcelain','vectors']).stdout.trim(),'','the measurement run leaves the committed vectors unchanged');
const require=createRequire(join(root,'implementations/ts/package.json')),esbuild=require('esbuild');
const tsBinary=join(build,'ts-measure-lifecycle.mjs');
await esbuild.build({entryPoints:[join(root,'implementations/ts/tools/materialization-measure-lifecycle.ts')],outfile:tsBinary,bundle:true,platform:'node',format:'esm',plugins:[{name:'strict-verification-counter',setup(b){b.onLoad({filter:/\/delta\/sign\.ts$/},args=>{
 let source=readFileSync(args.path,'utf8');const marker='export function verifySigStrict(sig: Uint8Array, msg: Uint8Array, pub: Uint8Array): boolean {';
 assert.equal(source.split(marker).length,2,'unique real strict verifier');source=source.replace(marker,marker+'\n measurementCalls++;');
 source+='\nlet measurementCalls=0;export function measurementReset(){measurementCalls=0}export function measurementCount(){return measurementCalls}\n';
 return {contents:source,loader:'ts'};
});}}]});
const rustCopy=join(build,'rust');mkdirSync(rustCopy,{recursive:true});
for(const name of ['src','examples','tests','Cargo.toml','Cargo.lock'])cpSync(join(root,'implementations/rust',name),join(rustCopy,name),{recursive:true});
cpSync(join(root,'tools/materialization-measure-lifecycle-rust.rs'),join(rustCopy,'examples/materialization_measure_lifecycle.rs'));
const signPath=join(rustCopy,'src/sign.rs');let sign=readFileSync(signPath,'utf8');const marker='pub(crate) fn verify_sig_strict(sig: &[u8], msg: &[u8], pubkey: &[u8]) -> bool {';
assert.equal(sign.split(marker).length,2,'unique real Rust strict verifier');sign=sign.replace(marker,marker+'\n MEASUREMENT_CALLS.with(|c|c.set(c.get()+1));');
sign+='\nstd::thread_local!{static MEASUREMENT_CALLS:std::cell::Cell<usize>=const{std::cell::Cell::new(0)};}\npub fn measurement_reset(){MEASUREMENT_CALLS.with(|c|c.set(0));}pub fn measurement_count()->usize{MEASUREMENT_CALLS.with(std::cell::Cell::get)}\n';writeFileSync(signPath,sign);
const cargo=run(process.env.CARGO??'cargo',['build','--locked','--release','--manifest-path',join(rustCopy,'Cargo.toml'),'--example','materialization_measure_lifecycle','--message-format=json'],{env:{...process.env,CARGO_TARGET_DIR:join(resolve(process.env.CARGO_TARGET_DIR??join(root,'implementations/rust/target')),'materialization-measurement')}});
const artifact=cargo.stdout.trim().split('\n').map(JSON.parse).filter(m=>m.reason==='compiler-artifact'&&m.target?.name==='materialization_measure_lifecycle'&&m.executable);assert.equal(artifact.length,1);
// Each size of the source sweep, then the fixed nested Bed fixture, in that order.
const sweepFiles=readdirSync(fixtures).filter(f=>/^lifecycle_\d+\.json$/.test(f)).sort((a,b)=>Number(a.match(/\d+/))-Number(b.match(/\d+/)));
const rows=[],nested=[];
for(const file of [...sweepFiles,'lifecycle_bed_32x4_two_levels.json']){
 const input=readFileSync(join(fixtures,file),'utf8'),metadata=JSON.parse(input);
 const pair=[];
 for(const [witness,cmd,args]of [['ts',process.execPath,[tsBinary]],['rust',artifact[0].executable,[]]]){
  const p=run('/usr/bin/time',['-f','materialization-peak-kib:%M',cmd,...args],{input});
  const actual=JSON.parse(p.stdout);
  const peak=/materialization-peak-kib:(\d+)/.exec(p.stderr);assert.ok(peak);actual.peakProcessRssKiB=Number(peak[1]);
  actual.inputSha256=hash(join(fixtures,file));pair.push(actual);
  writeFileSync(join(out,`lifecycle-measurement-${witness}-${file}`),JSON.stringify(actual,null,2)+'\n');
 }
 // Byte accounting and the step sequence must agree between the real witness ports.
 assert.deepEqual(pair[0].steps.map(s=>[s.phase,s.status,s.lengths]),pair[1].steps.map(s=>[s.phase,s.status,s.lengths]),'canonical byte accounting between witnesses');
 const phases=pair[0].steps.map(s=>s.phase);
 if(metadata.expectedStatus==='refused'){
  assert.deepEqual(phases,['install'],'an over-limit source is refused at install');
  for(const m of pair){assert.equal(m.steps[0].status,'refused');assert.equal(m.steps[0].currentChecks,0,'refused before any source check');}
 }else{
  assert.deepEqual(phases,metadata.selectedAppearances===0?['install','restore','read']:['install','replace','restore','read']);
  for(const m of pair)assert.ok(m.steps.every(x=>x.status==='completed'),metadata.id+' every phase completes');
 }
 (metadata.fixture?nested:rows).push({id:metadata.id,...(metadata.fixture?{fixture:metadata.fixture,nested:metadata.nested}:{}),selectedAppearances:metadata.selectedAppearances,expectedStatus:metadata.expectedStatus,measurements:pair});
 console.log(`M4 lifecycle measurement ${metadata.id}: ${metadata.selectedAppearances} source appearances; ${phases.join(', ')}; ${metadata.expectedStatus}`);
}
assert.deepEqual(rows.map(r=>r.selectedAppearances),[0,128,1024,4096,4097]);assert.deepEqual(nested.map(r=>r.fixture),['bed_32x4_two_levels']);
// The exact and one-over byte boundaries are shared vectors that both witness suites execute;
// this report names them beside the sweep rather than re-deriving their bytes.
const commands=JSON.parse(readFileSync(join(root,'vectors/materialization/commands.json'))),lifecycle=JSON.parse(readFileSync(join(root,'vectors/materialization/lifecycle.json')));
// Each pair is one limit at its exact value (completes) and one under it (refuses). The artifact
// limit's exact value is the largest of the snapshot payload and the bodies; its over vector sets
// it one byte below the snapshot payload. Delivery bytes count signed carrier overhead.
const boundaries={pairs:[{limit:'deliveryBytes',exact:'delivery_bytes_exact',over:'delivery_bytes_over'},{limit:'artifactBytes',exact:'artifact_bytes_exact',over:'snapshot_bytes_over'},{limit:'requestPointers',exact:'request_pointers_exact',over:'request_pointers_over'}],
 overOnly:['snapshot_appearances_over','output_aggregate_bytes_over','definition_appearance_bytes_over','resolve_outer_bytes_over'],
 lifecycleOver:['limits_install_64_roots_over_body_bytes','limits_replace_64_roots_over_body_bytes','limits_advance_64_roots_over_body_bytes','limits_install_fat_descriptor_over_image_bytes']};
for(const {exact,over}of boundaries.pairs){assert.ok(commands.positives.some(v=>v.id===exact),'shared exact vector '+exact);assert.equal(commands.negatives.find(v=>v.id===over)?.expected.code,'resource-limit','shared over vector '+over);}
for(const id of boundaries.overOnly)assert.equal(commands.negatives.find(v=>v.id===id)?.expected.code,'resource-limit','shared over vector '+id);
for(const id of boundaries.lifecycleOver)assert.equal(lifecycle.steps.find(s=>s.id===id)?.expected.code,'resource-limit','lifecycle boundary '+id);
const git=args=>run('git',args).stdout.trim();
const report={format:'rhizomatic.materialization-m4-lifecycle-measurement/1',source:{commit:git(['rev-parse','HEAD']),tree:git(['rev-parse','HEAD^{tree}']),clean:git(['status','--porcelain','--untracked-files=normal'])===''},
 scope:'M4 lifecycle baseline: install, equal-size replacement, fresh restore and fresh read for the fixed nested Bed fixture (32 plants, four buckets each, 128 signed facts, a bytes leaf, two expansion levels) and at 0, 128, 1024, 4096 and 4097 source appearances. Each step is a cold boot from its stored image over an in-memory store. No Loam or storage I/O, no performance promise.',
 peakRssScope:'Whole fresh child process per size, including parsed fixtures and goldens; parent bundler and compiler excluded.',
 signatureCounting:'Every call of each witness\'s exact strict verifier, counted in a disposable build copy.',
 boundaries,
 deferred:['M5 journal-backed published Plant and Bed source counts and bytes'],
 thresholds:[],builds:{ts:hash(tsBinary),rust:hash(artifact[0].executable)},rows,nested};
writeFileSync(join(out,'MEASUREMENTS-LIFECYCLE.json'),JSON.stringify(report,null,2)+'\n');
