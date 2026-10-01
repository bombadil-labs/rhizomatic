import { homedir } from 'node:os';
import { delimiter } from 'node:path';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const fixture=JSON.parse(readFileSync(join(root,'vectors/command/transport.json'),'utf8'));
const rust=spawnSync('cargo',['build','--quiet','--example','command_fixture'],{cwd:join(root,'implementations/rust'),env:{...process.env,PATH:join(homedir(),'.cargo/bin')+delimiter+process.env.PATH},encoding:'utf8'});if(rust.status!==0)throw Error(rust.stderr);
const rawAdapter=(w,input)=>{const command=w==='ts'?[process.execPath,[join(root,'implementations/ts/node_modules/tsx/dist/cli.mjs'),join(root,'implementations/ts/tools/command-fixture.ts')]]:[join(root,'implementations/rust/target/debug/examples/command_fixture'),[]];const result=spawnSync(command[0],command[1],{input:JSON.stringify(input),encoding:'utf8'});return result;};
const adapter=(w,input)=>{const result=rawAdapter(w,input);if(result.status!==0)throw Error(`${w} ${input.mode}: ${result.stderr}`);return JSON.parse(result.stdout);};
for(const [producer,consumer]of [['ts','rust'],['rust','ts']]){
 const constructed=adapter(producer,{mode:'construct',scenario:'description_roundtrip',context:fixture.context});
 if(!isDeepStrictEqual(constructed.artifact,fixture.expectedArtifact))throw Error(`${producer} construction differs from independently authored artifact`);
 const validated=adapter(consumer,{mode:'validate',scenario:'description_roundtrip',context:fixture.context,artifact:constructed.artifact});
 if(!validated.verdict.valid||!isDeepStrictEqual(validated.artifact,constructed.artifact))throw Error(`${consumer} description validation failed`);
 const result=adapter(producer,{mode:'read-result',scenario:'description_roundtrip',context:fixture.context,artifact:validated.artifact,outcome:fixture.outcome});
 if(!isDeepStrictEqual(result,fixture.expectedResult))throw Error(`${producer} outcome readback differs from fixed oracle`);
 console.log(`${producer} construction -> ${consumer} validation -> ${producer} result readback: passed signed serialized descriptions (M1, no execution).`);
}

for(const witness of ['ts','rust'])for(const c of fixture.readResults){
 const run=rawAdapter(witness,{mode:'read-result',scenario:c.scenario,context:fixture.context,artifact:c.artifact,outcome:c.outcome});
 if(c.expected.valid){if(run.status!==0)throw Error(`${witness} ${c.id} valid readback refused: ${run.stderr}`);if(!isDeepStrictEqual(JSON.parse(run.stdout),c.expected.result))throw Error(`${witness} ${c.id} differs from independent result oracle`);}
 else if(run.status!==1)throw Error(`${witness} ${c.id} invalid readback accepted or panicked: ${run.status}`);
}
console.log(`Complete result readback: ${fixture.readResults.length} shared positive/negative transport cases passed independently in TS and Rust.`);
