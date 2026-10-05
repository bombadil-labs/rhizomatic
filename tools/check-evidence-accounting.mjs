// Receipts supplement passing tests; they do not prove arbitrary assertion semantics.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
export function expectedVectorEvidence(bytes,witness){
 const vectors=JSON.parse(bytes),corpusId=createHash('sha256').update(bytes).digest('hex');
 const result=[];
 for(const group of ['positives','negative','nativeReject','readingFixtures','syntaxBudgets'])for(const v of vectors[group]){
  const assertions=group==='positives'?6+(['legacy','annotations','bound'].includes(v.variant)?1:0):group==='negative'?1+(v.native!==undefined?1:0):group==='nativeReject'?2:group==='readingFixtures'?3:3+(v.valid?(witness==='ts'?4:1):0);
  result.push({group,id:v.id??null,variant:v.variant,corpusId,assertions});
 }
 return result;
}
export function readAssertionEvidence(log){return [...log.matchAll(/materialization-assertion:(\{[^\n]+\})/g)].map(m=>JSON.parse(m[1]));}
export function validateAssertionEvidence(expected,received){
 const key=v=>JSON.stringify([v.group,v.id,v.variant]);
 assert.equal(received.length,expected.length,'missing/extra assertion evidence');
 const rows=new Map(received.map(v=>[key(v),v]));assert.equal(rows.size,received.length,'duplicate assertion evidence');
 for(const v of expected)assert.deepEqual(rows.get(key(v)),v,'wrong/missing vector identity, corpus or assertion count');
}
export function accountingSensitivity(expected){
 assert.throws(()=>validateAssertionEvidence(expected,expected.slice(1)),/assertion evidence/);
 const altered=structuredClone(expected);altered[0].assertions=0;assert.throws(()=>validateAssertionEvidence(expected,altered),/assertion count/);
 const wrong=structuredClone(expected);wrong[0].variant+='-wrong';assert.throws(()=>validateAssertionEvidence(expected,wrong),/vector identity/);
 return ['missing-assertion-evidence','missing-assertion-count','wrong-vector-identity'];
}
