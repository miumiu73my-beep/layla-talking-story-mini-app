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
