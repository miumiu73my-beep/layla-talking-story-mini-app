import test from 'node:test';import assert from 'node:assert/strict';
import {freshState,cleanState,buildMessages,samplerParams,parseImport,readableText,FORMAT} from '../src/logic.js';
test('book notation and prose are kept in instructions',()=>{
 const s=freshState();s.characters='[海:名称≡<虎田海>]\n優しい人物。';s.memory='約束を覚える';s.body='x'.repeat(8000);
 const m=buildMessages(s,'ここにいる');
 assert.ok(m[0].content.includes('[海:名称≡<虎田海>]'));
 assert.ok(m[0].content.includes('約束を覚える'));
 assert.equal(m[0].content.includes('ここにいる'),false);
 assert.ok(m.at(-1).content.includes('ここにいる'));
 assert.ok(m[0].content.includes('x'.repeat(3600)));
});
test('JSON preserves full state and free memory',()=>{
 const s=freshState();s.memory='章を区切らないメモ';s.body='本文';
 const loaded=parseImport('test.json',JSON.stringify(s),freshState());
 assert.equal(loaded.state.memory,'章を区切らないメモ');
 assert.equal(loaded.state.body,'本文');assert.equal(loaded.state.schema,FORMAT);
});
test('TXT keeps settings while replacing body',()=>{
 const s=freshState();s.rules='規則';const r=parseImport('x.txt','差し替え本文',s);
 assert.equal(r.state.rules,'規則');assert.equal(r.state.body,'差し替え本文');
 assert.equal(readableText(r.state,'txt'),'作品：新しい物語\n\n差し替え本文');
});
test('invalid files and sampler limits are rejected',()=>{
 assert.throws(()=>parseImport('backup.json','{}',freshState()));
 assert.throws(()=>samplerParams({temperature:7}));assert.throws(()=>cleanState({body:6}));
});
