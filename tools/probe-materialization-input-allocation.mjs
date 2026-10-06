// Deterministic Rust non-entry evidence and sensitivity probe, confined to disposable copies.
// The actual native ports, shared corpus, Delta parser and canonical encoder execute unchanged;
// counters observe real entry points. No production counters, wall-time thresholds or fake codec.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,cpSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const out=resolve(process.env.M2_ARTIFACT_DIR??join(root,'artifacts/materialization-m2'));
const copy=join(out,'allocation-probe-build/rust');mkdirSync(copy,{recursive:true});
for(const name of ['src','examples','Cargo.toml','Cargo.lock'])cpSync(join(root,'implementations/rust',name),join(copy,name),{recursive:true});
cpSync(join(root,'tools/materialization-allocation-probe.rs'),join(copy,'examples/materialization_allocation_probe.rs'));
for(const [file,marker,increment]of [
 ['b64u.rs','pub fn decode(s: &str) -> Result<Vec<u8>, String> {','ALLOCATION_CALLS.with(|c|c.set(c.get()+1));'],
 ['delta.rs','pub fn canonical_bytes(claims: &Claims) -> Result<Vec<u8>, String> {','if claims.pointers.iter().any(|p|matches!(&p.target,crate::types::Target::Bytes{value,..} if value.len()>=16384)){ALLOCATION_CALLS.with(|c|c.set(c.get()+1));}'],
]) {
 const path=join(copy,'src',file);let text=readFileSync(path,'utf8');assert.equal(text.split(marker).length,2);text=text.replace(marker,marker+'\n'+increment);
 text+='\nstd::thread_local!{static ALLOCATION_CALLS:std::cell::Cell<usize>=const{std::cell::Cell::new(0)};}\npub fn allocation_probe_reset(){ALLOCATION_CALLS.with(|c|c.set(0));}pub fn allocation_probe_count()->usize{ALLOCATION_CALLS.with(std::cell::Cell::get)}\n';writeFileSync(path,text);
}
const run=(cmd,args,options={})=>spawnSync(cmd,args,{cwd:root,encoding:'utf8',maxBuffer:20*1024*1024,...options});
const cargo=process.env.CARGO??'cargo',env={...process.env,CARGO_TARGET_DIR:join(resolve(process.env.CARGO_TARGET_DIR??join(root,'implementations/rust/target')),'materialization-allocation-probe')};
function build() {
 const p=run(cargo,['build','--locked','--manifest-path',join(copy,'Cargo.toml'),'--example','materialization_allocation_probe','--message-format=json'],{env});assert.equal(p.status,0,p.stdout+p.stderr);
 const artifacts=p.stdout.trim().split('\n').map(JSON.parse).filter(m=>m.reason==='compiler-artifact'&&m.target?.name==='materialization_allocation_probe'&&m.executable);assert.equal(artifacts.length,1);return artifacts[0].executable;
}
const binary=build(),corpus=join(root,'vectors/materialization/commands.json');
const p=run(binary,[corpus]);assert.equal(p.status,0,p.stdout+p.stderr);const actual=JSON.parse(p.stdout);
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');const buildSha256=hash(binary);cpSync(binary,join(out,'allocation-probe-original'));
// Deliberate bypass of pre-allocation gate in the disposable copy must make the rail fail.
const input=join(copy,'src/materialization_input.rs');let text=readFileSync(input,'utf8');const marker='    check_delivery_counts(appearances, &c.limits)?;';assert.equal(text.split(marker).length,2);
text=text.replace(marker,marker+'\n let _=appearances.iter().map(parse_delta).collect::<std::result::Result<Vec<_>,_>>();');writeFileSync(input,text);
const mutant=build(),negative=run(mutant,[corpus]);assert.notEqual(negative.status,0,'pre-allocation bypass must fail non-entry rail');assert.match(negative.stderr,/offered decoder entered/);
writeFileSync(join(out,'ALLOCATION-PROBE.json'),JSON.stringify({format:'rhizomatic.materialization-input-allocation-probe/1',source:{commit:run('git',['rev-parse','HEAD']).stdout.trim(),tree:run('git',['rev-parse','HEAD^{tree}']).stdout.trim(),clean:run('git',['status','--porcelain','--untracked-files=normal']).stdout.trim()===''},scope:'Rust invoke/preflight; TS executes corresponding spies in materialization-input-allocation.test.ts',instrumentation:'Counters at real decoder entry and canonical_bytes for 16KiB offered carrier; disposable source copy only.',corpusSha256:hash(corpus),buildSha256,records:actual.records,sensitivity:{id:'preallocation_decode_bypass',passed:true},notClaimed:['caller JSON storage bounded','total scan CPU bounded','sandboxed getters/proxies','canonical-byte performance promise']},null,2)+'\n');
console.log('M2 allocation probe:6 Rust route schedules,zero decoder/carrier canonical entries; pre-allocation bypass red.');
