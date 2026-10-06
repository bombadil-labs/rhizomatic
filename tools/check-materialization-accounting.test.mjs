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
