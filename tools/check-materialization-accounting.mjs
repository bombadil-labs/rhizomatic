// Executed receipts supplement semantic assertions and review; counts alone prove no arbitrary semantics.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

export function expectedMaterializationAssertions(corpora,witness){
 const expected=[];
 for(const [corpus,bytes] of Object.entries(corpora)){
  const v=JSON.parse(bytes),corpusId=createHash('sha256').update(bytes).digest('hex');
  for(const group of ['positives','negatives','resultRejections'])for(const f of v[group]??[]){
   let assertions=1;
   if(group==='positives') assertions=corpus==='command-descriptions'?(witness==='ts'?5:3):corpus==='source-snapshot'?7+(f.expected.excludedId?1:0):(witness==='ts'?12:16)+(f.id==='supplied_testimony'?1:0);
   if(corpus==='commands'&&group==='negatives') assertions=2+(f.first||f.actions?.includes('success-then-revoke')?1:0);
   expected.push({corpus,corpusId,group,id:f.id,assertions});
  }
 }
 return expected;
}
export function materializationAssertionReceipts(log){return [...log.matchAll(/materialization-m2-assertion:(\{[^\n]+\})/g)].map(m=>JSON.parse(m[1]));}
export function validateMaterializationAssertions(expected,actual){
 const key=v=>JSON.stringify([v.corpus,v.group,v.id]);
 assert.equal(actual.length,expected.length,'missing/extra executed assertion evidence');
 const rows=new Map(actual.map(v=>[key(v),v]));assert.equal(rows.size,actual.length,'duplicate executed assertion evidence');
 for(const e of expected)assert.deepEqual(rows.get(key(e)),e,'wrong vector identity, corpus commitment or executed assertion count');
}
export function materializationAccountingSensitivity(expected){
 assert.throws(()=>validateMaterializationAssertions(expected,expected.slice(1)),/assertion evidence/);
 const noAssertions=structuredClone(expected);noAssertions[0].assertions=0;
 assert.throws(()=>validateMaterializationAssertions(expected,noAssertions),/assertion count/);
 const wrongId=structuredClone(expected);wrongId[0].id+='-absent';
 assert.throws(()=>validateMaterializationAssertions(expected,wrongId),/vector identity/);
 const wrongCorpus=structuredClone(expected);wrongCorpus[0].corpusId='00'.repeat(32);
 assert.throws(()=>validateMaterializationAssertions(expected,wrongCorpus),/corpus commitment/);
 return ['missing-assertion-evidence','missing-executed-assertions','wrong-vector-identity','wrong-corpus-commitment'];
}
