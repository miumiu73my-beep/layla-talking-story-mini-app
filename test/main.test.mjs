import test from 'node:test';
import assert from 'node:assert/strict';
import {freshState,cleanState,archiveReference,compactBackup} from '../src/logic.js';
import {runImport,regenerateTurn,stoppedCandidate,waitForStop,exportPlan} from '../src/ui-flows.js';

function harness({hasStorage=true,corrupt=false,blocked=!hasStorage,choices=['replace'],checkpoint=true}={}){
  const calls=[],questions=[];
  const branch=archiveReference({id:'old-branch',name:'既存分岐',chars:300,turnCount:1});
  const old=cleanState({...freshState(),body:'original',draft:'draft',activeBranch:{id:'old-active',name:'現在'},branches:[branch]});
  let state=old;
  const store={hasStorage,corrupt,allowImportRecovery:async()=>{calls.push('recovery');}};
  const deps={store,getState:()=>state,isSaveBlocked:()=>blocked,modal:async(q,options)=>{questions.push({q,options});calls.push('modal');return choices.shift();},
    beforeDestructive:async(reason,options)=>{calls.push({reason,...options});return checkpoint;},
    unlockRecovery:()=>{blocked=false;},apply:async next=>{state=next;calls.push('apply');}};
  const incoming=cleanState({...freshState(),body:'imported',activeBranch:{id:'old-branch',name:'別作品'}});
  const file=(raw=JSON.stringify(incoming),name='test.json')=>({name,size:raw.length,text:async()=>{calls.push('file read');return raw;}});
  return {calls,questions,old,branch,incoming,file,run:(f)=>runImport(f??file(),deps),state:()=>state};
}
test('main-only JSON explicitly reports both branch counts and preserves lazy references and active ID',async()=>{
  const h=harness({choices:['keep']});
  assert.equal(await h.run(),true);
  assert.match(h.questions[0].q,/ファイルの保存済み分岐 0 件／現在の保存済み分岐 1 件/);
  assert.equal(h.state().body,'imported');assert.equal(h.state().activeBranch.id,'old-active');
  assert.equal(h.state().branches[0],h.branch);
  assert.deepEqual(h.calls,['file read','modal',{reason:'本編読み込前',scope:'active'},'apply']);
});
test('full replace requires explicit choice and full checkpoint',async()=>{
  const h=harness();await h.run();assert.equal(h.state().branches.length,0);
  assert.equal(h.state().activeBranch.id,'old-branch');
  assert.deepEqual(h.calls,['file read','modal',{reason:'import',scope:'full'},'apply']);
});
test('compact backup counts incoming archives but keep ignores them',async()=>{
  const h=harness({choices:['keep']});
  const raw=compactBackup(cleanState({...h.incoming,branches:[{id:'incoming',body:'分岐本文'}]}));
  await h.run(h.file(raw));
  assert.match(h.questions[0].q,/ファイルの保存済み分岐 1 件/);assert.equal(h.state().branches.length,1);assert.equal(h.state().branches[0],h.branch);
});
test('cancel or failed checkpoint never replaces current state',async()=>{
  for(const opts of [{choices:['cancel']},{choices:['keep'],checkpoint:false},{choices:['replace'],checkpoint:false}]){
    const h=harness(opts);assert.equal(await h.run(),false);assert.equal(h.state(),h.old);assert.ok(!h.calls.includes('apply'));
  }
});
test('unavailable storage refuses import before reading',async()=>{
  const h=harness({hasStorage:false});
  await assert.rejects(h.run(),/ファイルを読み込めません/);
  assert.equal(h.state(),h.old);assert.deepEqual(h.calls,[]);
});
test('corrupt storage requires explicit recovery, cannot retain unverified archive references',async()=>{
  const h=harness({hasStorage:false,corrupt:true,choices:['replace','yes']});
  await h.run();assert.equal(h.state().body,'imported');
  assert.ok(!h.questions[0].options.some(([key])=>key==='keep'));
  assert.deepEqual(h.calls,['file read','modal','modal','recovery','apply']);
  const no=harness({hasStorage:false,corrupt:true,choices:['keep']});assert.equal(await no.run(),false);assert.equal(no.state(),no.old);
});
test('text import retains archive reference and checkpoints active work only',async()=>{
  const h=harness({choices:['yes']});await h.run(h.file('新しい本文','test.txt'));
  assert.equal(h.state().body,'新しい本文');assert.equal(h.state().branches[0],h.branch);
  assert.equal(h.calls[2].scope,'active');
});
test('latest regeneration preserves draft and scrolls only to prompt',async()=>{
  const calls=[],state={turns:[{}],draft:'draft'};
  const args={index:0,turn:{user:'original input'},state,modal:async()=>{calls.push('modal');return 'yes';},applyStoryChange:async()=>true,regenerateAt(){},
    showMain:opts=>calls.push(opts),scrollPrompt:()=>calls.push('prompt'),startGeneration:async opts=>calls.push(opts)};
  await regenerateTurn(args);
  assert.deepEqual(calls,['modal',{scroll:false},'prompt',{inputOverride:'original input',preserveDraft:true}]);
  calls.length=0;await regenerateTurn({...args,applyStoryChange:async()=>false});assert.deepEqual(calls,['modal']);
});
test('stopping preserves partial output or restores prior candidate',()=>{
  const prior={text:'前の候補',note:'旧'},partial={text:'途中'};
  assert.equal(stoppedCandidate(partial,prior),partial);
  assert.match(partial.note,/途中まで/);
  assert.equal(stoppedCandidate({text:' '},prior),prior);assert.match(prior.note,/前の候補/);
  assert.equal(stoppedCandidate(null,null),null);
});
test('stop confirmation wins once, timeout and stale generation are handled',async()=>{
  const jobs=[],released=[];let current=true;
  const options={requestedAt:100,isCurrent:()=>current,onRelease:x=>released.push(x),now:()=>100,schedule:(fn,delay)=>jobs.push({fn,delay})};
  waitForStop({...options,finalizing:Promise.resolve()});await Promise.resolve();
  jobs.find(x=>x.delay===750).fn();jobs.find(x=>x.delay===5000).fn();assert.deepEqual(released,[true]);
  jobs.length=0;released.length=0;waitForStop(options);jobs[0].fn();assert.deepEqual(released,[false]);
  jobs.length=0;released.length=0;waitForStop(options);current=false;jobs[0].fn();assert.deepEqual(released,[]);
});
test('export plan distinguishes large all-branch backup, main-only and text',()=>{
  const state={body:'a',branches:[{chars:5000001}]};
  assert.equal(exportPlan('json',state).large,true);assert.equal(exportPlan('compact-json',state).large,true);
  assert.deepEqual(exportPlan('main-json',state),{light:false,mainOnly:true,json:true,large:false,mime:'application/json',suffix:'_本編のみ'});
  assert.equal(exportPlan('md',state).mime,'text/markdown');
});
