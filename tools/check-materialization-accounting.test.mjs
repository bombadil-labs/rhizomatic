import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {expectedMaterializationAssertions,validateMaterializationAssertions,materializationAssertionReceipts,materializationAccountingSensitivity} from './check-materialization-accounting.mjs';
const corpora=Object.fromEntries(['commands','command-descriptions','source-snapshot'].map(c=>[c,readFileSync(new URL('../vectors/materialization/'+c+'.json',import.meta.url))]));
for(const witness of ['ts','rust'])test(witness+' actual corpus identity/assertion receipts and missing evidence sensitivity',()=>{
 const expected=expectedMaterializationAssertions(corpora,witness);
 assert.ok(expected.length>150);
 const log=expected.map(e=>'materialization-m2-assertion:'+JSON.stringify(e)).join('\n');
 validateMaterializationAssertions(expected,materializationAssertionReceipts(log));
 assert.equal(materializationAccountingSensitivity(expected).length,4);
});
test('M2 stable batch IDs are mapped once and lifecycle remains M3',()=>{
 const cases=JSON.parse(readFileSync(new URL('../contracts/materialization/M2-CASES.json',import.meta.url))).cases;
 const variants=JSON.parse(readFileSync(new URL('../contracts/materialization/M2-VARIANTS.json',import.meta.url))).cases.flatMap(c=>c.variants);
 assert.equal(cases.length,27);assert.equal(new Set(cases.map(c=>c.id)).size,27);
 assert.deepEqual(cases.map(c=>c.id).sort(),variants.filter(v=>v.milestone==='M2').map(v=>v.id).sort());
 assert.equal(variants.filter(v=>v.milestone==='M3').length,6);
 for(const c of cases)for(const r of c.vector_assertions){
  const corpus=JSON.parse(corpora[r.corpus]);assert.ok(corpus[r.group].some(v=>v.id===r.id),c.id+' missing fixture '+r.id);
 }
});
import {expectedMaterializationM3Assertions,materializationM3AssertionReceipts} from './check-materialization-accounting.mjs';
const m3Corpora=Object.fromEntries(['control-image','lifecycle'].map(c=>[c,readFileSync(new URL('../vectors/materialization/'+c+'.json',import.meta.url))]));
test('M3 corpus identity/assertion receipts and missing evidence sensitivity',()=>{
 const expected=expectedMaterializationM3Assertions(m3Corpora);
 assert.equal(expected.length,3+21+2*JSON.parse(m3Corpora.lifecycle).steps.length);
 assert.deepEqual([...new Set(expected.filter(e=>e.group==='readback').map(e=>e.assertions))].sort(),[10,6,8]);
 const log=expected.map(e=>'materialization-m3-assertion:'+JSON.stringify(e)).join('\n');
 validateMaterializationAssertions(expected,materializationM3AssertionReceipts(log));
 assert.equal(materializationAccountingSensitivity(expected).length,4);
});
test('M3 required cases and variants are each allocated once with executable references',()=>{
 const m3=JSON.parse(readFileSync(new URL('../contracts/materialization/M3-CASES.json',import.meta.url)));
 const required=JSON.parse(readFileSync(new URL('../contracts/materialization/MILESTONES.json',import.meta.url))).milestones.find(m=>m.id==='M3');
 assert.deepEqual(m3.cases.map(c=>c.id).sort(),[...required.required_cases].sort());
 assert.deepEqual(m3.variants.map(c=>c.id).sort(),[...required.required_variants].sort());
 const all={...corpora,...m3Corpora};
 for(const c of [...m3.cases,...m3.variants]){
  assert.ok(['executed','partial','specified'].includes(c.state),c.id+' state');
  assert.equal(c.state==='specified',c.vector_assertions.length===0&&c.native_evidence.length===0&&c.tower_evidence.length===0,c.id+' specified cases carry no evidence');
  if(c.state!=='executed')assert.ok(c.remaining.length>0,c.id+' names what remains');
  for(const r of c.vector_assertions){
   const corpus=JSON.parse(all[r.corpus]),group=r.corpus==='lifecycle'?'steps':r.group;
   assert.ok((corpus[group]??[]).some(v=>v.id===r.id),c.id+' missing fixture '+r.group+'/'+r.id);
  }
 }
});
