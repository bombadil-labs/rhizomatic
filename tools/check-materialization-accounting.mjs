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

// M3 receipts: the control-image and lifecycle corpora. Counts are identical in both witnesses.
const SERVING_VERBS=['install','replace-source','advance-time','read'];
function lifecycleVerbs(v){
 const role=s=>'rhizomatic.materialization.'+s,verbs=new Map();
 for(const d of v.boot.declarations){
  const ps=d.claims.pointers,kind=ps.find(p=>p.role===role('kind'))?.target,name=ps.find(p=>p.role===role('name'))?.target?.id;
  if(kind==='operation/1'&&typeof name==='string')verbs.set(d.id,name.slice(role('').length));
 }
 return step=>verbs.get(step.request.claims.pointers.find(p=>p.role===role('operation'))?.target?.delta);
}
export function expectedMaterializationM3Assertions(corpora){
 const expected=[];
 for(const [corpus,bytes] of Object.entries(corpora)){
  const v=JSON.parse(bytes),corpusId=createHash('sha256').update(bytes).digest('hex');
  if(corpus==='control-image'){
   for(const f of v.positives)expected.push({corpus,corpusId,group:'positives',id:f.id,assertions:7+f.expected.deltaKeys.length});
   for(const f of v.negatives)expected.push({corpus,corpusId,group:'negatives',id:f.id,assertions:1});
  }else if(corpus==='lifecycle'){
   const verbOf=lifecycleVerbs(v);
   for(const s of v.steps){
    expected.push({corpus,corpusId,group:'steps',id:s.id,assertions:6});
    const refused=s.expected.status==='refused',results=!refused&&SERVING_VERBS.includes(verbOf(s));
    expected.push({corpus,corpusId,group:'readback',id:s.id,assertions:refused?6:results?10:8});
   }
  }else throw Error('unknown M3 corpus '+corpus);
 }
 return expected;
}
export function materializationM3AssertionReceipts(log){return [...log.matchAll(/materialization-m3-assertion:(\{[^\n]+\})/g)].map(m=>JSON.parse(m[1]));}
