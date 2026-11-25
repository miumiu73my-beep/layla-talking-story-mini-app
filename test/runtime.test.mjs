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

test('optional finish reason passes through and plain text remains compatible',async()=>{
  const listeners={};let result='途中の文章';
  const raw={on:(name,cb)=>{listeners[name]=cb;},finalContent:async()=>result,abort:()=>{}};
  const host=makeRuntime({sdk:{chat:{completions:{stream:()=>raw}}}});
  const stream=host.generate({messages:[],params:{},onText:()=>{}});
  listeners.chunk({choices:[{finish_reason:'length'}]});
  assert.deepEqual(await stream.final(),{text:'途中の文章',finishReason:'length'});
  result='通常の文章';
  const next=host.generate({messages:[],params:{},onText:()=>{}});
  assert.deepEqual(await next.final(),{text:'通常の文章',finishReason:null});
});
