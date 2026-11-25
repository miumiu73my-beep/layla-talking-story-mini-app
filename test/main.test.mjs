import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Isolate actual UI functions without starting Layla or the full DOM.
const source=readFileSync(new URL('../src/main.js',import.meta.url),'utf8');
function section(from,to){
  const start=source.indexOf(from),end=source.indexOf(to,start+from.length);
  assert.ok(start>=0&&end>start);
  return source.slice(start,end);
}
function harness({hasStorage=true,corrupt=false}={}){
  const calls=[],elements=new Map();
  const el=id=>{
    if(!elements.has(id))elements.set(id,{hidden:false,classList:{add(){},remove(){}},scrollIntoView:()=>calls.push('prompt'),focus:()=>calls.push('focus')});
    return elements.get(id);
  };
  const store={hasStorage,corrupt,allowImportRecovery:async()=>{calls.push('recovery');}};
  const old={body:'original',turns:[{}],draft:'draft'};
  const code=section('function showMain(','function showSettings(')+
    section('async function handleImport(','async function resetStory(')+
    section('async function actOnTurn(','\nasync function branchAction(');
  const setup=`
    let state=old,ready=true,busy=false,branchBusy=false,bodyBackupBusy=false,exporting=false,saveBlocked=!store.hasStorage,candidate=null,fullBody=false,editRev=0,savedRev=0;
    const window={scrollTo:()=>calls.push('top')};
    const commitPendingBodyEdit=()=>{},paint=()=>{},rebuildSettings=()=>{},resetBodyRecovery=()=>{};
    const status=(message,error)=>calls.push({message,error});
    const TRANSFER_MAX_BYTES=50000000;
    const parseImport=()=>({full:true,state:{body:'imported',pendingCandidate:null}});
    const modal=async()=>{calls.push('modal');return 'yes';};
    const beforeDestructive=async()=>{calls.push('checkpoint');return true;};
    const saveNow=async()=>{calls.push('save');return true;};
    const timelineAt=()=>({user:'original input'});
    const applyStoryChange=async()=>true;
    const startGeneration=async opts=>calls.push(opts);
  `;
  const ui=new Function('calls','el','store','old',setup+code+';return {showMain,handleImport,actOnTurn,state:()=>state};')(calls,el,store,old);
  return {ui,calls,old};
}
test('navigation scrolls to top by default but regeneration scrolls only to prompt',async()=>{
  const {ui,calls}=harness();
  ui.showMain();assert.deepEqual(calls,['top']);
  calls.length=0;
  await ui.actOnTurn(0,'regenerate');
  assert.deepEqual(calls,['modal','prompt',{inputOverride:'original input',preserveDraft:true}]);
});
test('unavailable storage refuses import before reading, preserving the original',async()=>{
  const {ui,calls,old}=harness({hasStorage:false});
  await ui.handleImport({name:'test.json',size:10,text:async()=>{calls.push('file read');return '{}';}});
  assert.equal(ui.state(),old);assert.equal(calls.length,1);
  assert.equal(calls[0].error,true);
  assert.match(calls[0].message,/ファイルを読み込めません/);
});
test('recoverable corrupt storage still follows confirmed recovery path',async()=>{
  const {ui,calls}=harness({hasStorage:false,corrupt:true});
  await ui.handleImport({name:'test.json',size:10,text:async()=>{calls.push('file read');return '{}';}});
  assert.equal(ui.state().body,'imported');
  assert.deepEqual(calls.slice(0,5),['file read','modal','modal','recovery','save']);
});
test('healthy storage still checkpoints before importing',async()=>{
  const {ui,calls}=harness();
  await ui.handleImport({name:'test.json',size:10,text:async()=>{calls.push('file read');return '{}';}});
  assert.equal(ui.state().body,'imported');
  assert.deepEqual(calls.slice(0,4),['file read','modal','checkpoint','save']);
});
