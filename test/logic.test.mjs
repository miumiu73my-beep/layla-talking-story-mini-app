import test from 'node:test';
import assert from 'node:assert/strict';
import {FORMAT,VERSION,BODY_LIMIT,LIMITS,freshState,cleanState,warningsForState,buildRequest,buildMessages,
  samplerParams,parseImport,readableText,compactBackup,acceptTurn,undoTurn} from '../src/logic.js';

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


test('short body never wastes 40 percent of budget on nonexistent prose',()=>{
  const bare=freshState();bare.prefs.contextTokens=4096;
  bare.characters='キ'.repeat(1800);bare.rules='ル'.repeat(900);
  const without=buildRequest(bare,'続けて');
  const withShort=buildRequest({...bare,body:'短'.repeat(100)},'続けて');
  const omitted=m=>m.meta.omitted.reduce((n,v)=>n+v.omitted,0);
  assert.ok(omitted(withShort)-omitted(without)<260);
  assert.equal(withShort.meta.bodyOmitted,0);
});

test('optional input-to-body preserves verbatim user action without changing old backups',()=>{
  let s=freshState();
  assert.equal(s.prefs.recordInputInBody,false);
  s.prefs.recordInputInBody=true;
  s=acceptTurn(s,{user:'明日、屋上で会おう',text:'一歌は頷いた。',sourceDraft:'明日、屋上で会おう'});
  assert.equal(s.body,'【あなたの入力】\n明日、屋上で会おう\n\n一歌は頷いた。');
  assert.equal(s.turns[0].userPrelude,'【あなたの入力】\n明日、屋上で会おう\n\n');
  assert.equal(cleanState(JSON.parse(JSON.stringify(s))).turns[0].userPrelude,s.turns[0].userPrelude);
  assert.equal(parseImport('v1.json',JSON.stringify(s),freshState()).state.body,s.body);
  const lite=compactBackup(s);
  assert.equal(parseImport('v2.json',lite,freshState()).state.body,s.body);
  assert.equal(readableText(s,'txt').includes('明日、屋上で会おう'),true);
});
test('synthetic auto-continue prompt is never recorded as a user action',()=>{
  let s=freshState();s.prefs.recordInputInBody=true;
  s=acceptTurn(s,{user:'この場面を自然に続きを進める',text:'窓辺で話が続いた。',sourceDraft:''});
  assert.equal(s.body,'窓辺で話が続いた。');
  assert.equal(s.turns[0].userPrelude,undefined);
});
test('max_tokens stays within context and explicit small values stay small',()=>{
  const s=freshState();s.prefs.contextTokens=2048;s.prefs.targetChars=1000;
  s.prefs.max_tokens=8000;
  const request=buildRequest(s,'続ける');
  assert.equal(request.meta.outputTokens,1024);
  assert.equal(request.meta.outputCapped,true);
  s.prefs.max_tokens=40;
  assert.equal(buildRequest(s,'続ける').meta.outputTokens,40);
  assert.equal(buildRequest(s,'続ける').meta.outputTooShort,true);
});

test('legacy 768 migrates once but explicit new 768 survives',()=>{
  const old=freshState();delete old.prefs.maxTokensVersion;old.prefs.max_tokens='768';old.prefs.targetChars=1000;
  const migrated=cleanState(old);assert.equal(migrated.prefs.max_tokens,'');
  assert.equal(buildRequest(migrated,'続ける').meta.outputTokens,2328);
  migrated.prefs.max_tokens=768;assert.equal(cleanState(migrated).prefs.max_tokens,768);
});
test('long input is never silently truncated',()=>{
  const s=freshState();s.prefs.contextTokens=32768;const input='あ'.repeat(6000);
  assert.ok(buildRequest(s,input).messages[1].content.includes(input));
  assert.throws(()=>buildRequest(s,input+'い'),/送信上限/);
});
test('early diverging siblings compress, legacy v2 reads and invalid forward refs fail',()=>{
  const s=freshState();s.body='A'.repeat(100000);const prefix='別'.repeat(80000);
  s.branches=[0,1,2].map(i=>({id:'b'+i,name:'分岐'+i,parentId:'main',forkTurn:1,body:prefix+'😀'+i,prefs:{max_tokens:768},modelNote:'旧メモ'}));
  const lite=compactBackup(s),v=JSON.parse(lite);
  assert.ok(lite.length<JSON.stringify(s).length*0.7);
  const restored=parseImport('x.json',lite,s).state;
  assert.equal(restored.branches[2].body,s.branches[2].body);
  assert.equal(restored.branches[0].prefs,undefined);assert.equal(restored.branches[0].modelNote,undefined);
  const old={schema:FORMAT,version:2,kind:'shared-prefix',baseBody:'共通',payload:{...freshState(),body:{prefix:2,suffix:'本文'},branches:[]}};
  assert.equal(parseImport('old.json',JSON.stringify(old),s).state.body,'共通本文');
  v.entries[0].base=1;assert.throws(()=>parseImport('bad.json',JSON.stringify(v),s),/参照/);
});
