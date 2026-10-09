// Narrow measurement runner. Instrumentation is confined to disposable build copies/artifacts.
// Verifier equations, validated bytes and independent semantic oracles remain unchanged.
// The instrumented crate copy builds into the shared Cargo target directory: Cargo keys its
// artifacts by package path, so the copy shares every dependency build and `cargo clean` removes it.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,cpSync,readdirSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=resolve(process.env.M2_ARTIFACT_DIR??join(root,'artifacts/materialization-m2'));
const fixtures=join(out,'measurement-fixtures'),build=join(out,'measurement-build');mkdirSync(build,{recursive:true});
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const run=(cmd,args,options={})=>{const p=spawnSync(cmd,args,{cwd:root,encoding:'utf8',maxBuffer:100*1024*1024,...options});assert.equal(p.status,0,p.stdout+'\n'+p.stderr);return p;};
run(join(root,'implementations/ts/node_modules/.bin/tsx'),['implementations/ts/tools/gen-materialization-command-vectors.ts'],{env:{...process.env,M2_MEASUREMENT_DIR:fixtures}});
const require=createRequire(join(root,'implementations/ts/package.json')),esbuild=require('esbuild');
const tsBinary=join(build,'ts-measure.mjs'),tsFixture=join(build,'ts-fixture.mjs');
await esbuild.build({entryPoints:[join(root,'implementations/ts/tools/materialization-fixture.ts')],outfile:tsFixture,bundle:true,platform:'node',format:'esm'});
await esbuild.build({entryPoints:[join(root,'implementations/ts/tools/materialization-measure.ts')],outfile:tsBinary,bundle:true,platform:'node',format:'esm',plugins:[{name:'strict-verification-counter',setup(b){b.onLoad({filter:/\/delta\/sign\.ts$/},args=>{
 let source=readFileSync(args.path,'utf8');const marker='export function verifySigStrict(sig: Uint8Array, msg: Uint8Array, pub: Uint8Array): boolean {';
 assert.equal(source.split(marker).length,2,'unique real strict verifier');source=source.replace(marker,marker+'\n measurementCalls++;');
 source+='\nlet measurementCalls=0;export function measurementReset(){measurementCalls=0}export function measurementCount(){return measurementCalls}\n';
 return {contents:source,loader:'ts'};
});}}]});
const rustCopy=join(build,'rust');mkdirSync(rustCopy,{recursive:true});
for(const name of ['src','examples','tests','Cargo.toml','Cargo.lock'])cpSync(join(root,'implementations/rust',name),join(rustCopy,name),{recursive:true});
mkdirSync(join(rustCopy,'examples'),{recursive:true});cpSync(join(root,'tools/materialization-measure-rust.rs'),join(rustCopy,'examples/materialization_measure.rs'));
const signPath=join(rustCopy,'src/sign.rs');let sign=readFileSync(signPath,'utf8');const marker='pub(crate) fn verify_sig_strict(sig: &[u8], msg: &[u8], pubkey: &[u8]) -> bool {';
assert.equal(sign.split(marker).length,2,'unique real Rust strict verifier');sign=sign.replace(marker,marker+'\n MEASUREMENT_CALLS.with(|c|c.set(c.get()+1));');
sign+='\nstd::thread_local!{static MEASUREMENT_CALLS:std::cell::Cell<usize>=const{std::cell::Cell::new(0)};}\npub fn measurement_reset(){MEASUREMENT_CALLS.with(|c|c.set(0));}pub fn measurement_count()->usize{MEASUREMENT_CALLS.with(std::cell::Cell::get)}\n';writeFileSync(signPath,sign);
const cargo=run(process.env.CARGO??'cargo',['build','--locked','--release','--manifest-path',join(rustCopy,'Cargo.toml'),'--example','materialization_measure','--example','materialization_fixture','--message-format=json'],{env:{...process.env,CARGO_TARGET_DIR:resolve(process.env.CARGO_TARGET_DIR??join(root,'implementations/rust/target'))}});
const artifact=cargo.stdout.trim().split('\n').map(JSON.parse).filter(m=>m.reason==='compiler-artifact'&&m.target?.name==='materialization_measure'&&m.executable);assert.equal(artifact.length,1);
const fixtureArtifact=cargo.stdout.trim().split('\n').map(JSON.parse).filter(m=>m.reason==='compiler-artifact'&&m.target?.name==='materialization_fixture'&&m.executable);assert.equal(fixtureArtifact.length,1);
const rows=[];
for(const file of readdirSync(fixtures).filter(f=>f.endsWith('.json')).sort()){
 const input=readFileSync(join(fixtures,file),'utf8'),metadata=JSON.parse(input);
 const pair=[];
 for(const [witness,cmd,args]of [['ts',process.execPath,[tsBinary]],['rust',artifact[0].executable,[]]]){
  const p=run('/usr/bin/time',['-f','materialization-peak-kib:%M',cmd,...args],{input});
  const actual=JSON.parse(p.stdout);assert.equal(actual.status,metadata.expectedStatus);
  const peak=/materialization-peak-kib:(\d+)/.exec(p.stderr);assert.ok(peak);actual.peakProcessRssKiB=Number(peak[1]);
  actual.inputSha256=hash(join(fixtures,file));pair.push(actual);
  writeFileSync(join(out,`measurement-${witness}-${file}`),JSON.stringify(actual,null,2)+'\n');
 }
 assert.deepEqual(pair[0].lengths,pair[1].lengths,'canonical byte accounting between real witness ports');
 assert.deepEqual(Object.keys(pair[0].phases).sort(),Object.keys(pair[1].phases).sort());
 // Native loops may differ, and counts are measured rather than substituted from expectations.
 const n=metadata.selectedAppearances;
 if(metadata.fixture.id.startsWith('source_')&&n<=4096)for(const measured of pair){
  assert.equal(measured.phases.gather.strictSignatureVerifications,2*n+11,'one source decode + generated envelope per gather');
  assert.equal(measured.phases['gather-readback'].strictSignatureVerifications,2*n+24,'independent source decode + envelope per readback');
  assert.equal(measured.phases.resolve.strictSignatureVerifications,n+15,'resolve unchanged');
  assert.equal(measured.phases['resolve-readback'].strictSignatureVerifications,2*n+25,'independent source decode + envelope per readback');
 }
 const endpointRefusals=[];
 if(n===4097){
  const {expected,...fixture}=metadata.fixture;
  for(const [witness,cmd,args]of [['ts',process.execPath,[tsFixture]],['rust-release',fixtureArtifact[0].executable,[]]]){
   const input=JSON.stringify({mode:'gather',fixture,upstream:{request:fixture.request,delivery:fixture.delivery},measureEndpoint:true});
   const p=run(cmd,args,{input});const actual=JSON.parse(p.stdout);
   assert.deepEqual(actual.outcome,expected.gather,'oversized opaque snapshot reaches real serialized endpoint');
   assert.deepEqual(actual.preflight,{status:'over-input-limit',code:'resource-limit'});assert.deepEqual(actual.calls,[]);
   endpointRefusals.push({witness,...actual.measurements,outcome:actual.outcome,preflight:actual.preflight,currentChecks:actual.calls.length});
  }
 }
 rows.push({id:metadata.fixture.id,fixture:{...metadata,fixture:undefined},measurements:pair,...(endpointRefusals.length?{serializedEndpointRefusals:endpointRefusals}:{})});
 console.log(`M2 measurement ${metadata.fixture.id}: ${metadata.selectedAppearances} full source appearances; ${metadata.expectedStatus}`);
}
const git=args=>run('git',args).stdout.trim();
const report={format:'rhizomatic.materialization-m2-measurement/1',source:{commit:git(['rev-parse','HEAD']),tree:git(['rev-parse','HEAD^{tree}']),clean:git(['status','--porcelain','--untracked-files=normal'])===''},peakRssScope:'Whole fresh child process, including parsed fixtures/goldens/carriers, runtime/GC, phase inputs/results and scalar counters; parent bundler/compiler excluded. No per-phase attribution.',verificationBoundaries:{capture:'Two snapshot decoder invocations plus capture metadata checks.',gather:'One snapshot decoder invocation plus one generated-envelope encoder invocation and small appearance/program/output checks.',resolve:'One supplied-envelope decoder invocation plus original Basis/program checks.',readback:'One snapshot decoder invocation plus one envelope decoder invocation and context/definition/outcome checks.',cache:'M1 per-distinct-full-appearance cache is per codec invocation; separate decoder calls are independent. No cross-call/global cache.'},scope:'M2 batch only. Fixture-native frozen-artifact capture validation; no Loam/storage I/O, generic native capturer, M3 lifecycle or performance promise.',signatureCounting:'One increment at entry to the exact real strict signature verifier in an ephemeral TS bundle/Rust source copy, same inputs and complete independent signed output/body goldens. No alternative verifier or production hooks.',builds:{ts:hash(tsBinary),rust:hash(artifact[0].executable),originalTsVerifier:hash(join(root,'implementations/ts/src/delta/sign.ts')),originalRustVerifier:hash(join(root,'implementations/rust/src/sign.rs'))},rows,deferred:['M3 install','M3 replacement','M3 fresh restore/read','M5 actual Loam route'],thresholds:[]};
writeFileSync(join(out,'MEASUREMENTS.json'),JSON.stringify(report,null,2)+'\n');
