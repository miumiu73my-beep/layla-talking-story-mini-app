import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore,splitChunks,checksum,sqlRows} from '../src/persistence.js';
import {freshState,cleanState} from '../src/logic.js';

function fakeSql(){
  const map=new Map();
  let failWrite=false;
  return {
    map,setFailWrite(x){failWrite=x;},
    async executeSql(query,params=[]){
      if(query.startsWith('CREATE TABLE'))return {rows:[]};
      if(query.startsWith('SELECT v FROM')){
        return {rows:map.has(params[0])?[{v:map.get(params[0])}]:[]};
      }
      if(query.startsWith('SELECT k,v FROM'))return {rows:[...map].map(([k,v])=>({k,v}))};
      if(query.startsWith('SELECT k FROM'))return {rows:[...map.keys()].map(k=>({k}))};
      if(query.startsWith('INSERT')){
        if(failWrite)throw Error('SQLite temporarily unavailable');
        map.set(params[0],params[1]);return {rows:[]};
      }
      if(query.startsWith('DELETE')){map.delete(params[0]);return {rows:[]};}
      throw Error('Unimplemented SQL: '+query);
    }
  };
}
function fakeIdb(initial={}){
  const data=new Map(Object.entries(initial));
  return {data,factory:async()=>({get:async key=>data.get(key)||null,put:async(key,val)=>{data.set(key,val);}})};
}
function seed(db,state,{at=1000,rev=1}={}){
  const raw=JSON.stringify(state),parts=splitChunks(raw);
  const keys=parts.map((p,i)=>'gold/'+i);
  parts.forEach((p,i)=>db.map.set(keys[i],p));
  db.map.set('active',JSON.stringify({version:1,parts:keys,at,rev,hash:checksum(raw),size:raw.length}));
}
test('splitChunks never splits an emoji pair and reassembles',()=>{
  const raw='x'.repeat(39999)+'😀'+'z';
  const parts=splitChunks(raw);
  assert.equal(parts.join(''),raw);
  assert.equal(parts[0].length,39999);
  assert.equal(parts[1].charCodeAt(0)>=0xd800,true);
});
test('sqlRows handles both array and WebSQL item()',()=>{
  assert.deepEqual(sqlRows({rows:[{v:'hi'}]}),[{v:'hi'}]);
  assert.deepEqual(sqlRows({rows:{length:1,item:()=>({v:'hi'})}}),[{v:'hi'}]);
});
test('SQLite save, restart, previous generation and checkpoints',async()=>{
  const sql=fakeSql(),idb=fakeIdb(),host={db:sql};
  const store=await openStore(host,()=>{},{idbFactory:idb.factory});
  const state=freshState();state.body='a😀'.repeat(15000);
  await store.save(state);
  assert.equal(store.mode(),'SQLite');
  await store.checkpoint(state);
  const edited={...state,body:state.body+'次の文'};
  await store.save(edited);
  const reopened=await openStore(host,()=>{},{idbFactory:idb.factory});
  assert.equal(reopened.initial.body,edited.body);
  assert.ok((await reopened.checkpoints()).length>=2);
});
test('invalid pending fallback cannot overwrite valid SQLite',async()=>{
  const sql=fakeSql(),s=freshState();s.body='正しい本文';seed(sql,s);
  const idb=fakeIdb({latest:{state:{...s,body:1},rev:200,pending:true,at:3000}});
  const previous=sql.map.get('active');
  const st=await openStore({db:sql},()=>{},{idbFactory:idb.factory,validator:cleanState});
  assert.equal(st.initial.body,'正しい本文');
  assert.equal(st.recoveryRequired,false);
  assert.equal(sql.map.get('active'),previous);
});
test('pending fallback with older device clock requires explicit choice',async()=>{
  const sql=fakeSql(),s=freshState();s.body='SQLite旧版';seed(sql,s,{at:30000,rev:9});
  const newer={...s,body:'IndexedDB新編集'};
  const idb=fakeIdb({latest:{state:newer,rev:10,pending:true,at:100}});
  const store=await openStore({db:sql},()=>{},{idbFactory:idb.factory});
  assert.equal(store.initial.body,newer.body);
  assert.equal(store.recoveryRequired,true);
  await assert.rejects(store.save(newer));
  const recovered=await store.chooseRecovery('idb');
  assert.equal(recovered.body,newer.body);
  const again=await openStore({db:sql},()=>{},{idbFactory:idb.factory});
  assert.equal(again.initial.body,newer.body);
});
test('fallback to IndexedDB is explicit; no false SQLite success',async()=>{
  const idb=fakeIdb();
  const store=await openStore({},()=>{},{idbFactory:idb.factory});
  assert.equal(store.mode(),'IndexedDB（退避）');
  const s=freshState();s.body='編集した';
  await store.save(s);
  const recovered=await openStore({},()=>{},{idbFactory:idb.factory});
  assert.equal(recovered.initial.body,'編集した');
  assert.equal(recovered.mode(),'IndexedDB（退避）');
});
test('both storage channels unavailable are reported as unavailable',async()=>{
  const store=await openStore({},()=>{},{idbFactory:async()=>{throw Error('no idb');}});
  assert.equal(store.hasStorage,false);assert.equal(store.mode(),'保存不可');
  await assert.rejects(store.save(freshState()));
});
test('broken sqlite manifest is kept read-only and raw dump is retrievable',async()=>{
  const sql=fakeSql();sql.map.set('active','{"version":1,"parts":["missing"]}');
  const st=await openStore({db:sql},()=>{},{idbFactory:fakeIdb().factory});
  assert.equal(st.corrupt,true);assert.equal(st.readOnly,true);
  assert.match(await st.rawDump(),/missing/);
  await assert.rejects(st.save(freshState()));
});
test('queued latest saves settle and final state wins',async()=>{
  const sql=fakeSql(),store=await openStore({db:sql},()=>{},{idbFactory:fakeIdb().factory});
  const s=freshState();
  const pending=[];
  for(let i=0;i<12;i++)pending.push(store.save({...s,body:'version '+i}));
  await Promise.all(pending);
  const reopened=await openStore({db:sql},()=>{},{idbFactory:fakeIdb().factory});
  assert.equal(reopened.initial.body,'version 11');
});

test('temporary SQLite API failure is not mistaken for corrupted data',async()=>{
  const unavailable={db:{executeSql:async()=>{throw Error('temporary SQLite bridge timeout');}}};
  const fallback=fakeIdb(),out=[];
  const store=await openStore(unavailable,message=>out.push(message),{idbFactory:fallback.factory});
  assert.equal(store.corrupt,false);
  assert.equal(store.readOnly,false);
  assert.equal(store.mode(),'IndexedDB（退避）');
  const s=freshState();s.body='一時エラー中の編集';
  await store.save(s);
  const reopened=await openStore(unavailable,()=>{},{idbFactory:fallback.factory});
  assert.equal(reopened.initial.body,s.body);
});

test('checkpoints use small SQL rows and restore complete long manuscripts',async()=>{
  const sql=fakeSql(),idb=fakeIdb(),store=await openStore({db:sql},()=>{},{idbFactory:idb.factory});
  const s=freshState();s.body='長'.repeat(150000);
  await store.save(s);await store.checkpoint(s,'本文大幅削除前');
  const keys=[...sql.map.keys()].filter(k=>k.startsWith('checkpoint/')&&k.includes('/part/'));
  assert.ok(keys.length>=4);
  assert.ok(keys.every(k=>sql.map.get(k).length<=40000));
  const versions=await store.checkpoints();
  assert.equal(versions.find(v=>v.reason==='本文大幅削除前').data,JSON.stringify(s));
});
test('unchanged archived branches are not rewritten on each active edit',async()=>{
  const {rewindAfter}=await import('../src/branches.js');
  const sql=fakeSql(),idb=fakeIdb(),store=await openStore({db:sql},()=>{},{idbFactory:idb.factory});
  let s=freshState();s.body='A'.repeat(100000);
  s.turns=[{user:'hello',reply:s.body,bodyStart:0,bodyEnd:s.body.length}];
  s=rewindAfter(s,0); // Archives full original.
  await store.save(s);
  const count=()=>[...sql.map.keys()].filter(k=>k.includes('/branch/')).length;
  const before=count();assert.ok(before>0);
  await store.save({...s,draft:'編集された下書き'});
  assert.equal(count(),before);
  const reopened=await openStore({db:sql},()=>{},{idbFactory:idb.factory});
  assert.equal(reopened.initial.branches[0].body.length,100000);
});
test('pending IDB with same SQLite base revision fast-forwards safely',async()=>{
  const sql=fakeSql(),s=freshState();s.body='旧版';
  seed(sql,s,{rev:3});
  const newer={...s,body:'保存失敗中に書いた新版'};
  const idb=fakeIdb({latest:{state:newer,rev:4,baseRev:3,pending:true,at:10}});
  const st=await openStore({db:sql},()=>{},{idbFactory:idb.factory});
  assert.equal(st.recoveryRequired,false);
  assert.equal(st.mode(),'SQLite');
  assert.equal(st.initial.body,newer.body);
  const again=await openStore({db:sql},()=>{},{idbFactory:idb.factory});
  assert.equal(again.initial.body,newer.body);
});
test('a failed recovery checkpoint preserves retryable recovery selection',async()=>{
  const sql=fakeSql(),s=freshState();s.body='SQL';seed(sql,s,{rev:2});
  const newer={...s,body:'IDB'};
  let fail=true;
  const data=new Map([['latest',{state:newer,rev:3,pending:true,at:10}]]);
  const idbFactory=async()=>({
    get:async key=>data.get(key)||null,
    put:async(key,val)=>{if(fail)throw Error('No room for checkpoint');data.set(key,val);}
  });
  const st=await openStore({db:sql},()=>{},{idbFactory});
  sql.setFailWrite(true);
  await assert.rejects(st.chooseRecovery('idb'));
  assert.equal(st.recoveryRequired,true);
  fail=false;sql.setFailWrite(false);
  const recovered=await st.chooseRecovery('idb');
  assert.equal(recovered.body,'IDB');
  assert.equal(st.recoveryRequired,false);
});
test('flush waits for in-flight save completion',async()=>{
  const sql=fakeSql(),original=sql.executeSql.bind(sql);
  sql.executeSql=async(...args)=>{await new Promise(r=>setTimeout(r,2));return original(...args);};
  const store=await openStore({db:sql},()=>{},{idbFactory:fakeIdb().factory});
  const s=freshState();s.body='待機';
  const pending=store.save(s);
  await store.flush();await pending;
  const read=await openStore({db:sql},()=>{},{idbFactory:fakeIdb().factory});
  assert.equal(read.initial.body,'待機');
});
test('legacy single-row checkpoints remain readable after migration',async()=>{
  const sql=fakeSql(),store=await openStore({db:sql},()=>{},{idbFactory:fakeIdb().factory});
  const s=freshState();s.body='古い復元';
  sql.map.set('checkpoint/legacy',{...s} && JSON.stringify({at:1234,title:s.title,chars:s.body.length,data:JSON.stringify(s)}));
  const all=await store.checkpoints();
  assert.ok(all.some(x=>x.data===JSON.stringify(s)));
});
