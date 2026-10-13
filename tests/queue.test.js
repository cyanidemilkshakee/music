import test from 'node:test';
import assert from 'node:assert/strict';
import { createEntries, shuffled, moveEntry, nextIndex } from '../public/modules/queue-model.js';
test('shuffle preserves duplicate occurrences and pins the selected occurrence',()=>{
  const entries=createEntries(['a','b','a','c']);
  const result=shuffled(entries,entries[2].key,()=>0);
  assert.equal(result[0].key,entries[2].key);
  assert.deepEqual(result.map(e=>e.id).sort(),['a','a','b','c']);
  assert.equal(new Set(result.map(e=>e.key)).size,4);
});
test('queue movement preserves occurrence identity and original input',()=>{
  const entries=createEntries(['a','b','a']);
  assert.equal(moveEntry(entries,2,0)[0].key,entries[2].key);
  assert.deepEqual(entries.map(e=>e.id),['a','b','a']);
  assert.deepEqual(moveEntry(entries,-1,2),entries);
});
test('repeat-one affects natural end, while manual Next advances',()=>{
  assert.equal(nextIndex(1,3,'one',true),1);
  assert.equal(nextIndex(1,3,'one',false),2);
  assert.equal(nextIndex(2,3,'none',true),-1);
  assert.equal(nextIndex(2,3,'all',true),0);
  assert.equal(nextIndex(-1,0,'all'),-1);
});
test('10000-track shuffle remains complete and efficient',()=>{
  const entries=createEntries(Array.from({length:10000},(_,i)=>'track-'+i));
  const start=performance.now();const result=shuffled(entries,entries[9999].key);
  assert.equal(result.length,10000);assert.equal(new Set(result.map(e=>e.key)).size,10000);
  assert.ok(performance.now()-start<150);
});
