import test from 'node:test';
import assert from 'node:assert/strict';
import {FORMAT,VERSION,BODY_LIMIT,LIMITS,freshState,cleanState,warningsForState,buildRequest,buildMessages,
  samplerParams,parseImport,readableText,acceptTurn,undoTurn} from '../src/logic.js';

test('existing character-book notation and plain Japanese are preserved',()=>{
  const s=freshState();s.characters='[海:名称≡<虎田海>]\n優しい人物。';
  s.memory='昨日の約束。';s.body='ここは確定本文。';s.turns=[{user:'旧発言',reply:'古い返答',at:'2026'}];
  const x=buildRequest(s,'おはよう');
  assert.ok(x.messages[0].content.includes('[海:名称≡<虎田海>]'));
  assert.ok(x.messages[0].content.includes('昨日の約束'));
  assert.ok(x.messages[0].content.includes('ここは確定本文'));
  assert.equal(x.messages[0].content.includes('古い返答'),false);
  assert.deepEqual(x.messages.map(m=>m.role),['system','user']);
  assert.ok(x.messages[1].content.includes('おはよう'));
});
test('legacy oversized state is never silently clipped or blocked from JSON export',()=>{
  const s=freshState();s.memory='A'.repeat(LIMITS.memory+1);s.body='X'.repeat(BODY_LIMIT+1);
  const parsed=cleanState(JSON.parse(JSON.stringify(s)));
  assert.equal(parsed.memory.length,LIMITS.memory+1);assert.equal(parsed.body.length,BODY_LIMIT+1);
  assert.ok(warningsForState(parsed).length>=2);
  assert.equal(JSON.parse(JSON.stringify(parsed)).body,s.body);
  assert.throws(()=>cleanState({...s,body:42}));
  assert.equal(cleanState({...s,characters:null}).characters,'');
});
test('prompt budget reports omitted fields and keeps newest memory tail',()=>{
  const s=freshState();s.prefs.contextTokens=2048;s.prefs.contextChars=12000;
  s.characters='a'.repeat(30000);s.memory='old'.repeat(3000)+'最新の約束';
  s.body='body'.repeat(5000);
  const x=buildRequest(s,'移動する');
  assert.ok(x.meta.omitted.some(t=>t.key==='memory'));
  assert.ok(x.messages[0].content.includes('最新の約束'));
  assert.ok(x.meta.bodyOmitted>0);
  assert.ok(x.meta.estimatedTokens>=0);
});
test('accept and undo do not duplicate full body in turns',()=>{
  const s=freshState();s.body='昔の出来事';
  const a=acceptTurn(s,{user:'笑う',text:'彼は笑い返した。',sourceDraft:''});
  assert.ok(a.body.includes('彼は笑い返した。'));
  assert.equal(a.turns[0].reply,undefined);
  assert.equal(a.turns[0].preview,'彼は笑い返した。');
  assert.equal(a.undo.beforeBody,undefined);
  assert.equal(undoTurn(a).body,'昔の出来事');
  assert.throws(()=>undoTurn({...a,body:'改稿'+a.body.slice(2)}));
});
test('legacy full reply is preserved in v1 JSON',()=>{
  const s=freshState();s.turns=[{user:'発言',reply:'長い古い返答',at:'date'}];
  const x=parseImport('old.json',JSON.stringify(s),freshState());
  assert.equal(x.state.turns[0].reply,'長い古い返答');
  assert.equal(x.state.schema,FORMAT);assert.equal(x.state.version,VERSION);
});
test('marked TXT and Markdown round-trip without polluting body',()=>{
  for(const ext of ['txt','md']){
    const s=freshState();s.title='';s.body='作品：偶然の見出し\n\n冒頭。\n続き。';
    const x=parseImport('story.'+ext,readableText(s,ext),freshState());
    assert.equal(x.state.title,'無題の作品');assert.equal(x.state.body,s.body);
    const plain=parseImport('plain.'+ext,s.body,freshState());
    assert.equal(plain.state.body,s.body);
  }
});
test('sampler validates ranges and accepts optional fields',()=>{
  assert.deepEqual(samplerParams({temperature:'',max_tokens:'',top_k:1}),{top_k:1});
  assert.throws(()=>samplerParams({temperature:5}));
  assert.throws(()=>samplerParams({repeat_last_n:-2}));
});
test('invalid import does not modify existing state',()=>{
  const s=freshState();s.memory='重要メモ';
  assert.throws(()=>parseImport('bad.json','{}',s));
  assert.equal(s.memory,'重要メモ');
});

test('legacy unmarked TXT produced by previous version still imports',()=>{
  const s=freshState();
  const result=parseImport('old_2026-11-23.txt','作品：旧作\n\n旧本文',s);
  assert.equal(result.state.title,'旧作');assert.equal(result.state.body,'旧本文');
});

test('previous USER intentions survive without duplicating assistant replies',()=>{
  const s=freshState();s.body='一歌は「うん」と答えた。';
  s.turns=[{user:'明日屋上で会おう',preview:'一歌は「うん」と答えた。'}];
  s.prefs.includeInput=false;
  const msg=buildRequest(s,'その翌日。');
  assert.ok(msg.messages[0].content.includes('明日屋上で会おう'));
  assert.equal((msg.messages[0].content.match(/一歌は「うん」と答えた。/g)||[]).length,1);
  assert.deepEqual(msg.messages.map(m=>m.role),['system','user']);
});
test('contextChars strictly bounds body even with large n_ctx',()=>{
  const s=freshState();s.prefs.contextTokens=32768;s.prefs.contextChars=1000;
  s.body='B'.repeat(20000);
  const x=buildRequest(s,'続ける');
  assert.ok(x.messages[0].content.includes('B'.repeat(900)));
  assert.ok(!x.messages[0].content.includes('B'.repeat(1001)));
});
test('water filling reallocates unused budget to character book',()=>{
  const s=freshState();s.prefs.contextTokens=8192;s.characters='C'.repeat(2500);
  s.world='世界観';s.synopsis='短い説明';
  const x=buildRequest(s,'続ける');
  assert.equal(x.meta.omitted.some(o=>o.key==='characters'),false);
  assert.ok(x.messages[0].content.includes(s.characters));
});
test('blank targetChars uses default outputTokens rather than 128',()=>{
  const s=freshState();s.prefs.targetChars='';s.prefs.max_tokens='';
  assert.equal(buildRequest(s,'test').meta.outputTokens,788);
});
test('turn limit rejects the 20001st accepted turn before modifying body',()=>{
  const s=freshState();s.turns=Array.from({length:20000},(_,i)=>({user:'turn'+i}));
  assert.throws(()=>acceptTurn(s,{user:'next',text:'reply',sourceDraft:''}),/20,000/);
  assert.equal(s.body,'');
});
test('compact shared-prefix JSON round trips with legacy format retained',async()=>{
  const {compactBackup}=await import('../src/logic.js');
  const s=freshState();s.body='A'.repeat(90000)+'現行';
  s.branches=Array.from({length:4},(_,i)=>({
    ...s,title:'分岐'+i,id:'b'+i,name:'branch'+i,body:'A'.repeat(90000)+'旧展開'+i,
    branches:undefined,activeBranch:undefined
  })).map(b=>{delete b.branches;delete b.activeBranch;return b;});
  const full=JSON.stringify(s),lite=compactBackup(s);
  assert.ok(lite.length<full.length/2);
  const reloaded=parseImport('lite.json',lite,freshState()).state;
  assert.equal(reloaded.body,s.body);
  assert.equal(reloaded.branches.length,4);
  assert.equal(reloaded.branches[3].body,s.branches[3].body);
  assert.equal(parseImport('old.json',full,freshState()).state.body,s.body);
});
