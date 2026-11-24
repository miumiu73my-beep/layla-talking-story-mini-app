import test from 'node:test';
import assert from 'node:assert/strict';
import {makeRuntime} from '../src/runtime.js';

test('missing Layla SDK initializes safe read-only browser host',()=>{
  const host=makeRuntime({sdk:null});
  assert.equal(host.sdk,null);
  assert.equal(host.db,null);
  assert.equal(host.utils,null);
  assert.equal(host.available(),false);
  assert.throws(()=>host.generate({messages:[],params:{},onText:()=>{}}),/ブリッジ/);
});
