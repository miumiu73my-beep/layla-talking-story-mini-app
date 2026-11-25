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

test('unrecognized SQL rows format throws instead of silently opening blank story',()=>{
  assert.throws(()=>sqlRows({unexpected:[]}),/想定外/);
  assert.throws(()=>sqlRows({rows:[['v']]}),/名前付き/);
});
test('corrupt archived branch leaves active text rescue visible in read-only mode',async()=>{
  const sql=fakeSql(),s=freshState();s.body='大切な本編';
  s.branches=[{id:'bad',name:'壊れた分岐',body:34}];
  seed(sql,s);
  const st=await openStore({db:sql},()=>{},{idbFactory:fakeIdb().factory});
  assert.equal(st.initial.body,'大切な本編');
  assert.equal(st.initial.branches.length,0);
  assert.equal(st.readOnly,true);
  await assert.rejects(st.save(st.initial));
});
test('corrupt ACTIVE can be preserved and explicitly replaced using imported v1 JSON',async()=>{
  const sql=fakeSql(),db=fakeIdb();sql.map.set('active','INVALID');
  const st=await openStore({db:sql},()=>{},{idbFactory:db.factory});
  assert.equal(st.readOnly,true);
  await st.allowImportRecovery();
  const valid=freshState();valid.body='復旧した原稿';
  await st.save(valid);
  assert.ok([...sql.map.keys()].some(k=>k.startsWith('corrupt-backup/')));
  const again=await openStore({db:sql},()=>{},{idbFactory:db.factory});
  assert.equal(again.initial.body,valid.body);
  assert.equal(again.readOnly,false);
});


test('initial SQLite SELECT failure NEVER allows a blind SQLite reconnect and GC',async()=>{
  const sql=fakeSql(),original=freshState();original.body='絶対に失ってはいけない原稿';
  seed(sql,original,{rev:55});
  const currentManifest=sql.map.get('active');
  const originalKeys=[...sql.map.keys()];
  const execute=sql.executeSql.bind(sql);
  let failOnce=true;
  sql.executeSql=async(query,args=[])=>{
    if(failOnce&&query.startsWith('SELECT v FROM')&&args[0]==='active'){
      failOnce=false;throw Error('Initial SQLite SELECT timeout');
    }
    return execute(query,args);
  };
  const idb=fakeIdb();
  const st=await openStore({db:sql},()=>{},{idbFactory:idb.factory});
  const replacement=freshState();replacement.body='この内容で上書きしてはいけない';
  await st.save(replacement);
  assert.equal(st.mode(),'IndexedDB（未同期退避）');
  assert.equal(sql.map.get('active'),currentManifest);
  for(const key of originalKeys)assert.ok(sql.map.has(key),'lost key '+key);
  assert.equal((await idb.data.get('latest')).state.body,replacement.body);
});

test('malformed pending IDB fork never fast-forwards healthy SQLite',async()=>{
  const sql=fakeSql(),original=freshState();original.body='SQLite本編';
  seed(sql,original,{rev:17});
  const previous=sql.map.get('active');
  const damaged={...original,body:'IDB変更版',branches:[{
    id:'broken',name:'壊れたアーカイブ',body:42,turns:[],draft:'',prefs:original.prefs
  }]};
  const idb=fakeIdb({latest:{state:damaged,rev:18,baseRev:17,pending:true,at:200}});
  const st=await openStore({db:sql},()=>{},{idbFactory:idb.factory});
  assert.equal(st.initial.body,'SQLite本編');
  assert.equal(st.recoveryRequired,false);
  assert.equal(sql.map.get('active'),previous);
  await assert.rejects(st.chooseRecovery('idb'),/必要ありません/);
});

test('checkpoint list is metadata-only and a selected large entry is loaded lazily',async()=>{
  const sql=fakeSql(),idb=fakeIdb(),host={db:sql};
  const st=await openStore(host,()=>{},{idbFactory:idb.factory});
  const s=freshState();s.body='お'.repeat(250000);
  await st.checkpoint(s,'長編の編集中');
  let partsRead=0;
  const orig=sql.executeSql.bind(sql);
  sql.executeSql=async(q,args=[])=>{
    if(q.startsWith('SELECT v FROM')&&String(args[0]).includes('/part/'))partsRead++;
    return orig(q,args);
  };
  const options=await st.checkpointList();
  assert.equal(partsRead,0);
  const selected=options.find(x=>x.reason==='長編の編集中');
  assert.ok(selected);assert.equal(selected.data,undefined);
  const restored=await st.loadCheckpoint(selected.id);
  assert.equal(restored.body,s.body);
  assert.ok(partsRead>=6);
});

test('checkpoint pruning deletes orphaned parts and uses metadata date order',async()=>{
  const sql=fakeSql(),st=await openStore({db:sql},()=>{},{idbFactory:fakeIdb().factory});
  sql.map.set('checkpoint/orphan/part/0','孤立行');
  const s=freshState();s.body='記録';
  await st.checkpoint(s,'ガベージ回収');
  assert.equal(sql.map.has('checkpoint/orphan/part/0'),false);
});

test('SQLite corrupt manifest recovery works even without IndexedDB',async()=>{
  const sql=fakeSql();sql.map.set('active','NOT_JSON');
  const st=await openStore({db:sql},()=>{},{idbFactory:async()=>{throw Error('IDB disabled');}});
  assert.equal(st.readOnly,true);
  await st.allowImportRecovery();
  const manuscript=freshState();manuscript.body='IDBなしで復旧した原稿';
  await st.save(manuscript);
  const reopened=await openStore({db:sql},()=>{},{idbFactory:async()=>{throw Error('IDB disabled');}});
  assert.equal(reopened.initial.body,manuscript.body);
});

test('raw dump contains bounded raw active manuscript even when checksum fails',async()=>{
  const sql=fakeSql(),s=freshState();s.body='救出すべき原稿';
  seed(sql,s,{rev:4});
  const active=JSON.parse(sql.map.get('active'));
  active.hash='wrong_hash';sql.map.set('active',JSON.stringify(active));
  const st=await openStore({db:sql},()=>{},{idbFactory:fakeIdb().factory});
  assert.equal(st.readOnly,true);
  const dump=JSON.parse(await st.rawDump());
  assert.ok(dump.activeRootRawPrefix.includes('救出すべき原稿'));
  assert.ok(dump.activeRootRawPrefix.length<=2000000);
});

test('legacy IndexedDB checkpoints remain selectable after new metadata index exists',async()=>{
  const original=freshState();original.body='旧復元点に残った原稿';
  const older={at:100,title:original.title,chars:original.body.length,data:JSON.stringify(original)};
  const idb=fakeIdb({checkpoints:[older]});
  const st=await openStore({},()=>{},{idbFactory:idb.factory});
  const updated={...original,body:'現在の原稿'};
  await st.checkpoint(updated,'新式チェックポイント');
  const list=await st.checkpointList();
  assert.ok(list.some(x=>x.id==='legacy-idb/0'));
  assert.ok(list.some(x=>x.reason==='新式チェックポイント'));
  const restored=await st.loadCheckpoint('legacy-idb/0');
  assert.equal(restored.body,original.body);
});

test('checkpoint shared-prefix encoding restores every branch without full duplicate bodies',async()=>{
  const sql=fakeSql(),st=await openStore({db:sql},()=>{},{idbFactory:fakeIdb().factory});
  const s=freshState();const base='共通本文'.repeat(30000);s.body=base+'本編';
  s.branches=[{id:'fork',name:'分岐',body:base+'別の展開'}];
  const expected=cleanState(s);
  await st.checkpoint(s,'共有本文の復元点');
  const selected=(await st.checkpointList()).find(x=>x.reason==='共有本文の復元点');
  const meta=JSON.parse(sql.map.get(selected.id));
  assert.equal(meta.format,'shared-prefix-v2');
  assert.ok(meta.size<JSON.stringify(expected).length*0.75);
  assert.deepEqual(await st.loadCheckpoint(selected.id),expected);
});
test('concurrent checkpoints never delete each others in-progress chunks',async()=>{
  const sql=fakeSql(),st=await openStore({db:sql},()=>{},{idbFactory:fakeIdb().factory});
  const a=freshState(),b=freshState();a.body='あ'.repeat(90000);b.body='い'.repeat(90000);
  await Promise.all([st.checkpoint(a,'並列A'),st.checkpoint(b,'並列B')]);
  const list=await st.checkpointList();
  assert.equal((await st.loadCheckpoint(list.find(x=>x.reason==='並列A').id)).body,a.body);
  assert.equal((await st.loadCheckpoint(list.find(x=>x.reason==='並列B').id)).body,b.body);
});
test('partial checkpoint write is reclaimed, unreadable parent chunks are preserved',async()=>{
  const sql=fakeSql(),idb=fakeIdb(),st=await openStore({db:sql},()=>{},{idbFactory:idb.factory});
  sql.map.set('checkpoint/broken','not JSON');
  sql.map.set('checkpoint/broken/part/0','救出できる本文');
  const original=sql.executeSql.bind(sql);let failed=false;
  sql.executeSql=async(q,args=[])=>{
    if(!failed&&q.startsWith('INSERT')&&String(args[0]).endsWith('/part/1')){
      failed=true;throw Error('interrupted checkpoint');
    }
    return original(q,args);
  };
  const s=freshState();s.body='あ'.repeat(120000);
  await st.checkpoint(s,'退避');
  assert.equal(failed,true);
  assert.deepEqual([...sql.map.keys()].filter(k=>k.includes('/part/')),['checkpoint/broken/part/0']);
  await st.checkpoint(s,'正常');
  assert.equal(sql.map.get('checkpoint/broken/part/0'),'救出できる本文');
  const list=await st.checkpointList();
  assert.equal((await st.loadCheckpoint(list.find(x=>x.reason==='退避').id)).body,s.body);
});
test('checkpoint rotation uses dates rather than mixed legacy key names',async()=>{
  const sql=fakeSql(),st=await openStore({db:sql},()=>{},{idbFactory:fakeIdb().factory});
  const s=freshState();s.body='保存内容';
  for(let i=0;i<8;i++){
    const key=i===0?'checkpoint/zzzz':'checkpoint/17'+i;
    sql.map.set(key,JSON.stringify({at:1000+i,title:s.title,chars:s.body.length,data:JSON.stringify(s)}));
  }
  await st.checkpoint(s,'最新');
  assert.equal(sql.map.has('checkpoint/zzzz'),false);
  assert.equal(sql.map.has('checkpoint/177'),true);
  assert.equal((await st.checkpointList()).length,8);
});

test('raw rescue identifies missing chunk positions and retains later readable text',async()=>{
  const sql=fakeSql(),s=freshState();s.body='A'.repeat(90000)+'後半の救出原稿';
  seed(sql,s);
  const active=JSON.parse(sql.map.get('active'));
  sql.map.delete(active.parts[1]);
  const st=await openStore({db:sql},()=>{},{idbFactory:fakeIdb().factory});
  const dump=JSON.parse(await st.rawDump());
  assert.equal(dump.activeRootComplete,false);
  assert.equal(dump.chunkErrors[0].index,1);
  assert.ok(dump.activeRootRawPrefix.includes('後半の救出原稿'));
  assert.equal(dump.chunkRanges[1].index,2);
  assert.ok(dump.activeRootRawPrefix.length<=2000000);
});
test('raw rescue can read ACTIVE after startup SELECT failure without changing write permissions',async()=>{
  const sql=fakeSql(),s=freshState();s.body='読込再試行で救出する原稿';seed(sql,s);
  const original=sql.executeSql.bind(sql);let failed=false;
  sql.executeSql=async(q,args)=>{
    if(!failed&&q.startsWith('SELECT v FROM')&&args[0]==='active'){failed=true;throw Error('temporary');}
    return original(q,args);
  };
  const active=sql.map.get('active');
  const st=await openStore({db:sql},()=>{},{idbFactory:fakeIdb().factory});
  const dump=JSON.parse(await st.rawDump());
  assert.ok(dump.activeRootRawPrefix.includes(s.body));
  assert.equal(st.mode(),'IndexedDB（退避）');
  await st.save({...freshState(),body:'別原稿'});
  assert.equal(sql.map.get('active'),active);
});

test('startup CREATE failure and malformed ACTIVE result keep SQLite untouched after retry deadline',async()=>{
  const scenarios=[
    {label:'CREATE',fail:(q)=>q.startsWith('CREATE TABLE'),response:()=>{throw Error('CREATE timeout');}},
    ...[{}, {rows:[{}]}, {rows:{length:-1}}, {rows:{length:NaN}}, {rows:[['v']]}, {rows:[{v:3}]}].map((bad,i)=>({label:'malformed '+i,fail:(q,a)=>q.startsWith('SELECT v FROM')&&a[0]==='active',response:()=>bad}))
  ];
  for(const scenario of scenarios){
    const sql=fakeSql(),host={db:sql},idb=fakeIdb();
    const original=freshState();original.body='既存原稿';
    const initial=await openStore(host,()=>{},{idbFactory:idb.factory});
    await initial.save(original);
    const snapshot=[...sql.map];
    const execute=sql.executeSql.bind(sql);let once=true,sqlWrites=0;
    sql.executeSql=async(q,a=[])=>{
      if(once&&scenario.fail(q,a)){once=false;return scenario.response();}
      if(/^(INSERT|DELETE)/.test(q))sqlWrites++;
      return execute(q,a);
    };
    const fallback=await openStore(host,()=>{},{idbFactory:idb.factory});
    const realNow=Date.now;
    try{
      Date.now=()=>realNow()+60000;
      await fallback.save({...original,body:'退避編集1'});
      await fallback.save({...original,body:'退避編集2'});
    }finally{Date.now=realNow;}
    assert.equal(sqlWrites,0,scenario.label);
    assert.deepEqual([...sql.map],snapshot,scenario.label);
    assert.equal(idb.data.get('latest').baseRev,null,scenario.label);
    assert.equal(idb.data.get('latest').state.body,'退避編集2',scenario.label);
    const reopened=await openStore(host,()=>{},{idbFactory:idb.factory});
    assert.equal(reopened.recoveryRequired,true,scenario.label);
    assert.deepEqual([...sql.map],snapshot,scenario.label);
  }
});
test('unknown startup base revision never fast-forwards a legacy revision-zero SQLite on restart',async()=>{
  const sql=fakeSql(),original=freshState();original.body='旧形式の原稿';
  seed(sql,original,{rev:0});
  const idb=fakeIdb(),before=[...sql.map],execute=sql.executeSql.bind(sql);
  let once=true;
  sql.executeSql=async(q,a=[])=>{
    if(once&&q.startsWith('SELECT v FROM')&&a[0]==='active'){once=false;throw Error('timeout');}
    return execute(q,a);
  };
  const st=await openStore({db:sql},()=>{},{idbFactory:idb.factory});
  await st.save({...original,body:'未知の基準で編集'});
  assert.equal(idb.data.get('latest').baseRev,null);
  const reopened=await openStore({db:sql},()=>{},{idbFactory:idb.factory});
  assert.equal(reopened.recoveryRequired,true);
  assert.deepEqual([...sql.map],before);
  // Older app versions recorded unknown bases as zero. Fail closed for these too.
  idb.data.get('latest').baseRev=0;
  const legacy=await openStore({db:sql},()=>{},{idbFactory:idb.factory});
  assert.equal(legacy.recoveryRequired,true);
  assert.deepEqual([...sql.map],before);
});
test('failed startup read without IndexedDB rejects save and retains all SQLite rows',async()=>{
  const sql=fakeSql(),original=freshState();original.body='保存済み';
  seed(sql,original,{rev:12});const before=[...sql.map];
  const execute=sql.executeSql.bind(sql);let once=true;
  sql.executeSql=async(q,a=[])=>{
    if(once&&q.startsWith('SELECT v FROM')&&a[0]==='active'){once=false;throw Error('timeout');}
    return execute(q,a);
  };
  const st=await openStore({db:sql},()=>{},{idbFactory:async()=>{throw Error('IDB unavailable');}});
  await assert.rejects(st.save({...original,body:'上書き不可'}),/保存できません/);
  assert.deepEqual([...sql.map],before);
});

test('draft-only save reuses exact SQLite root chunks and frozen archives',async()=>{
  const sql=fakeSql(),idb=fakeIdb(),st=await openStore({db:sql},()=>{},{idbFactory:idb.factory});
  let state=freshState();state.body='あ'.repeat(250000);
  state.branches=[{id:'fork',name:'分岐',body:'い'.repeat(250000)}];
  state=cleanState(state);
  const archive=state.branches[0];
  assert.equal(cleanState(state).branches[0],archive);
  assert.ok(Object.isFrozen(archive)&&Object.isFrozen(archive.turns));
  await st.save(state);
  const before=JSON.parse(sql.map.get('active'));
  state.draft='入力のみ';
  await st.save(state);
  const after=JSON.parse(sql.map.get('active'));
  assert.ok(after.parts.filter(k=>before.parts.includes(k)).length>=5);
  assert.deepEqual(after.branchParts,before.branchParts);
  const reopened=await openStore({db:sql},()=>{},{idbFactory:idb.factory});
  assert.equal(reopened.initial.body,state.body);
  assert.equal(reopened.initial.draft,'入力のみ');
  assert.equal(reopened.initial.branches[0].body,archive.body);
});
test('queued saves capture mutable active fields before asynchronous writes',async()=>{
  const sql=fakeSql(),st=await openStore({db:sql},()=>{},{idbFactory:fakeIdb().factory});
  const state=freshState();state.body='保存対象';state.draft='最初';
  const saving=st.save(state);state.body='未保存の変更';state.draft='後から変更';
  await saving;
  const reopened=await openStore({db:sql},()=>{},{idbFactory:fakeIdb().factory});
  assert.equal(reopened.initial.body,'保存対象');assert.equal(reopened.initial.draft,'最初');
});

test('lazy split store keeps only metadata and does not read or write archived bodies on a draft save',async()=>{
  const sql=fakeSql(),idb=fakeIdb(),host={db:sql},opts={idbFactory:idb.factory,lazyArchives:true};
  const st=await openStore(host,()=>{},opts);
  let state=cleanState({...freshState(),body:'本'.repeat(1000000),
    branches:Array.from({length:30},(_,i)=>({id:'fork'+i,name:'分岐'+i,body:'枝'.repeat(1000000)+i}))});
  await st.save(state);state=st.compactState(state);
  assert.equal(state.branches.length,30);
  assert.equal(state.branches[0].body,undefined);
  assert.equal(state.branches[0].chars,1000001);
  assert.throws(()=>JSON.stringify(state),/分岐/);
  const sqlBefore=JSON.parse(sql.map.get('active')),idbBefore=idb.data.get('latest');
  assert.equal(idbBefore.format,2);
  assert.equal(idbBefore.state.body,undefined);
  assert.equal(idbBefore.archives.length,30);
  const writes=[],reads=[],execute=sql.executeSql.bind(sql);
  sql.executeSql=async(q,a=[])=>{if(q.startsWith('INSERT'))writes.push(a[0]);if(q.startsWith('SELECT v FROM'))reads.push(a[0]);return execute(q,a);};
  state.draft='下書きのみ';state.updatedAt='updated';
  await st.save(state);
  const sqlAfter=JSON.parse(sql.map.get('active')),idbAfter=idb.data.get('latest');
  assert.deepEqual(sqlAfter.parts,sqlBefore.parts);
  assert.deepEqual(sqlAfter.branchParts,sqlBefore.branchParts);
  assert.deepEqual(idbAfter.core,idbBefore.core);
  assert.deepEqual(idbAfter.archives,idbBefore.archives);
  assert.deepEqual(writes,['active']);assert.equal(reads.length,0);
  reads.length=0;
  const idbReads=[],readFactory=async()=>{const db=await idb.factory();return {...db,get:async key=>{idbReads.push(key);return db.get(key);}};};
  const reopened=await openStore(host,()=>{},{...opts,idbFactory:readFactory});
  assert.equal(reads.filter(k=>k.includes('/branch/')).length,0);
  assert.equal(idbReads.filter(k=>k.includes('/branch/')).length,0);
  assert.equal(reopened.initial.draft,'下書きのみ');
  assert.equal(reopened.initial.branches[29].body,undefined);
  const selected=await reopened.materialize(reopened.initial,'fork29');
  assert.equal(selected.branches[29].body,'枝'.repeat(1000000)+'29');
  assert.equal(selected.branches[0].body,undefined);
  const restartedBefore=JSON.parse(sql.map.get('active'));
  writes.length=0;reads.length=0;
  const next={...reopened.initial,draft:'再起動後の下書き',prefs:{...reopened.initial.prefs,targetChars:600}};
  await reopened.save(next);
  assert.deepEqual(JSON.parse(sql.map.get('active')).parts,restartedBefore.parts);
  assert.deepEqual(writes,['active']);assert.equal(reads.length,0);
  const fallback=await openStore({},()=>{},opts);
  assert.equal(fallback.initial.body,state.body);
  assert.equal((await fallback.materialize(fallback.initial,'fork0')).branches[0].body,'枝'.repeat(1000000)+'0');
});
test('lazy archive remains available after SQLite fails and IDB becomes primary',async()=>{
  const sql=fakeSql(),idb=fakeIdb(),opts={idbFactory:idb.factory,lazyArchives:true};
  let st=await openStore({db:sql},()=>{},opts);
  let state=cleanState({...freshState(),body:'本編',branches:[{id:'fork',name:'分岐',body:'分岐本文'}]});
  await st.save(state);state=st.compactState(state);
  const idbBefore=idb.data.get('latest');
  sql.setFailWrite(true);state.draft='退避中';await st.save(state);
  assert.equal(st.mode(),'IndexedDB（未同期退避）');
  assert.deepEqual(idb.data.get('latest').archives,idbBefore.archives);
  const fallback=await openStore({},()=>{},opts);
  assert.equal(fallback.initial.draft,'退避中');
  assert.equal((await fallback.materialize(fallback.initial)).branches[0].body,'分岐本文');
  sql.setFailWrite(false);st=await openStore({db:sql},()=>{},opts);
  assert.equal(st.initial.draft,'退避中');
  assert.equal((await st.materialize(st.initial)).branches[0].body,'分岐本文');
});
test('lazy branch switch and rename materialize only selected archive and keep other refs',async()=>{
  const {switchBranch,renameBranch}=await import('../src/branches.js');
  const sql=fakeSql(),idb=fakeIdb(),opts={idbFactory:idb.factory,lazyArchives:true};
  const st=await openStore({db:sql},()=>{},opts);
  let state=cleanState({...freshState(),body:'本編',branches:[{id:'one',name:'一',body:'一本文'},{id:'two',name:'二',body:'二本文'}]});
  await st.save(state);state=st.compactState(state);
  state=renameBranch(await st.materialize(state,'one'),'one','改名');
  await st.save(state);state=st.compactState(state);
  assert.equal(state.branches[0].name,'改名');assert.equal(state.branches[0].body,undefined);
  state=switchBranch(await st.materialize(state,'one'),'one');
  await st.save(state);state=st.compactState(state);
  assert.equal(state.body,'一本文');assert.equal(state.branches.find(b=>b.id==='two').body,undefined);
  assert.equal((await st.materialize(state)).branches.find(b=>b.id==='main').body,'本編');
});

test('lazy overlay candidate and preferences survive restart and previous-generation restore',async()=>{
  const sql=fakeSql(),idb=fakeIdb(),opts={idbFactory:idb.factory,lazyArchives:true};
  const st=await openStore({db:sql},()=>{},opts);
  let state=cleanState({...freshState(),body:'本文',draft:'旧下書き',branches:[{id:'one',name:'分岐',body:'分岐本文'}]});
  await st.save(state);state=st.compactState(state);
  state.draft='新下書き';state.prefs.targetChars=700;
  state.pendingCandidate={user:'u',text:'候補',sourceDraft:'u',baseFingerprint:'fp',note:''};
  await st.save(state);
  const current=JSON.parse(sql.map.get('active'));
  assert.ok(current.overlayHash);assert.ok(current.previous.overlayHash);
  const reopened=await openStore({db:sql},()=>{},opts);
  assert.equal(reopened.initial.pendingCandidate.text,'候補');
  assert.equal(reopened.initial.prefs.targetChars,700);
  const entries=await reopened.checkpoints(),old=entries.map(x=>JSON.parse(x.data)).find(x=>x.draft==='旧下書き');
  assert.ok(old);assert.equal(old.branches[0].body,'分岐本文');
  await reopened.checkpoint(reopened.initial,'明示的な復元点');
  const restored=(await reopened.checkpoints()).map(x=>JSON.parse(x.data)).find(x=>x.draft==='新下書き');
  assert.ok(restored);assert.equal(restored.branches[0].body,'分岐本文');
});
test('corrupted split pending IDB archive cannot replace healthy SQLite',async()=>{
  const sql=fakeSql(),idb=fakeIdb(),opts={idbFactory:idb.factory,lazyArchives:true};
  const st=await openStore({db:sql},()=>{},opts);
  let state=cleanState({...freshState(),body:'SQLite本文',branches:[{id:'one',name:'分岐',body:'正しい分岐本文'}]});
  await st.save(state);state=st.compactState(state);
  const manifest=sql.map.get('active');
  sql.setFailWrite(true);state.draft='未同期';await st.save(state);sql.setFailWrite(false);
  const record=idb.data.get('latest');idb.data.set(record.archives[0].key,'broken');
  const reopened=await openStore({db:sql},()=>{},opts);
  assert.equal(reopened.initial.draft,'');
  assert.equal(sql.map.get('active'),manifest);
  assert.equal((await reopened.materialize(reopened.initial)).branches[0].body,'正しい分岐本文');
});


test('scoped checkpoints do not read or duplicate unrelated long archived branches',async()=>{
  const sql=fakeSql(),idb=fakeIdb(),st=await openStore({db:sql},()=>{},{idbFactory:idb.factory,lazyArchives:true});
  const s=freshState();s.body='本'.repeat(1000000);
  s.branches=Array.from({length:30},(_,i)=>({id:'archive'+i,name:'分岐'+i,body:'枝'.repeat(1000000)+i}));
  await st.save(s);
  const compact=st.compactState(cleanState(s));
  let reads=0;const original=sql.executeSql.bind(sql);
  sql.executeSql=async(q,a=[])=>{
    if(q.startsWith('SELECT v FROM')&&String(a[0]).includes('/branch/'))reads++;
    return original(q,a);
  };
  await st.checkpoint(compact,'本文を大きく削除する前');
  const entry=(await st.checkpointList()).find(x=>x.scope==='active');
  assert.ok(entry);assert.ok(entry.size<1100000);assert.equal(reads,0);
  const restored=await st.loadCheckpoint(entry.id,{...compact,body:'短縮'});
  assert.equal(restored.body,s.body);assert.equal(restored.branches.length,30);
  assert.equal(reads,0);
  await st.checkpoint(compact,'分岐削除前',{scope:'branch',branchId:'archive2'});
  const deleted=(await st.checkpointList()).find(x=>x.scope==='branch');
  assert.ok(deleted.size<1100000);
  const restoredBranch=await st.loadCheckpoint(deleted.id,{...compact,branches:compact.branches.filter(b=>b.id!=='archive2')});
  assert.equal(restoredBranch.body,s.body);
  assert.equal(restoredBranch.branches.find(b=>b.id==='archive2').body,'枝'.repeat(1000000)+'2');
  assert.equal(restoredBranch.branches.length,30);
  await assert.rejects(st.loadCheckpoint(deleted.id,compact));
});

test('important checkpoints have independent quotas in SQLite and IndexedDB',async()=>{
  for(const host of [{db:fakeSql()},{}]){
    const st=await openStore(host,()=>{},{idbFactory:fakeIdb().factory,lazyArchives:true});
    const s=freshState();s.body='重要な原稿';
    for(const reason of ['import','reset','本文を大きく削除する前'])await st.checkpoint(s,reason);
    for(let i=0;i<10;i++)await st.checkpoint(s,'通常'+i);
    const list=await st.checkpointList();
    assert.equal(list.length,11);
    for(const reason of ['import','reset','本文を大きく削除する前'])assert.ok(list.some(x=>x.reason===reason));
    assert.ok(!list.some(x=>x.reason==='通常0'));
  }
});

test('corrupt generation rows survive repeated saves and restart and are exported by key',async()=>{
  const sql=fakeSql(),idb=fakeIdb(),host={db:sql};
  let st=await openStore(host,()=>{},{idbFactory:idb.factory,lazyArchives:true});
  const s=freshState();s.body='旧原稿'.repeat(30000);
  s.branches=[{id:'oldfork',name:'旧分岐',body:'分岐の救出本文'}];
  await st.save(s);
  const m=JSON.parse(sql.map.get('active'));
  sql.map.delete(m.parts[1]);
  const surviving=[...m.parts,...m.branchParts[0].parts].filter(k=>sql.map.has(k));
  st=await openStore(host,()=>{},{idbFactory:idb.factory,lazyArchives:true});
  assert.equal(st.readOnly,true);assert.equal(st.canRebuildFromIdb,true);
  const recovered=await st.rebuildFromIdb();
  assert.equal(recovered.body,s.body);assert.equal(st.mode(),'SQLite');
  await st.save({...freshState(),body:'新原稿1'});
  await st.save({...freshState(),body:'新原稿2'});
  st=await openStore(host,()=>{},{idbFactory:idb.factory,lazyArchives:true});
  await st.save({...freshState(),body:'新原稿3'});
  for(const key of surviving)assert.ok(sql.map.has(key));
  const keys=await st.rawRowKeys(),rows=[];
  for(let i=0;i<Math.ceil(keys.length/10);i++)rows.push(...JSON.parse(await st.rawRowPage(keys,i)).rows);
  assert.ok(rows.some(r=>r.value?.includes('分岐の救出本文')));
  assert.ok(rows.some(r=>r.key.startsWith('corrupt-backup/')));
});

test('failed corrupt protection does not authorize replacing the old ACTIVE',async()=>{
  const sql=fakeSql();const s=freshState();s.body='旧原稿';seed(sql,s);
  const m=JSON.parse(sql.map.get('active'));m.hash='broken';sql.map.set('active',JSON.stringify(m));
  const original=sql.map.get('active');
  const st=await openStore({db:sql},()=>{},{idbFactory:fakeIdb().factory});
  sql.setFailWrite(true);
  await assert.rejects(st.allowImportRecovery());
  assert.equal(st.readOnly,true);
  await assert.rejects(st.save(freshState()));
  assert.equal(sql.map.get('active'),original);
});


test('whole-work checkpoint archive pool deduplicates unchanged branches and survives rotation',async()=>{
  for(const sql of [fakeSql(),null]){
    const idb=fakeIdb(),host=sql?{db:sql}:{};
    const st=await openStore(host,()=>{},{idbFactory:idb.factory,lazyArchives:true});
    const s=freshState();s.body='本編';s.branches=[{id:'fork',name:'分岐',body:'枝'.repeat(120000)}];
    await st.save(s);
    const current=st.compactState(cleanState(s));
    await st.checkpoint(current,'reset');
    const map=sql?sql.map:idb.data;
    const poolKeys=()=>[...map.keys()].filter(k=>k.startsWith('checkpoint-archive/')).sort();
    const first=poolKeys();assert.ok(first.length>0);
    await st.checkpoint({...current,body:'変更'},'import');
    assert.deepEqual(poolKeys(),first);
    for(let i=0;i<10;i++)await st.checkpoint(current,'通常'+i);
    const list=await st.checkpointList();
    const selected=list.find(x=>x.reason==='reset');
    assert.ok(selected);assert.ok(selected.size<10000);
    const restored=await st.loadCheckpoint(selected.id);
    assert.equal(restored.body,'本編');
    assert.equal(restored.branches[0].body,'枝'.repeat(120000));
    // Replace the entire work and reopen; the checkpoint has its own retained archive.
    await st.save({...freshState(),body:'新作品'});
    const reopened=await openStore(host,()=>{},{idbFactory:idb.factory,lazyArchives:true});
    assert.equal((await reopened.loadCheckpoint(selected.id)).branches[0].body,'枝'.repeat(120000));
  }
});

test('cumulative deletion checkpoint restores original body after autosaves and rotation',async()=>{
  const {makeBodyRecovery}=await import('../src/branches.js');
  for(const host of [{db:fakeSql()},{}]){
    const idb=fakeIdb(),st=await openStore(host,()=>{},{idbFactory:idb.factory,lazyArchives:true});
    let s=freshState();s.body='原稿'.repeat(5000);
    s.branches=[{id:'archive',name:'旧分岐',body:'保存済み分岐'}];
    const original=s.body;
    await st.save(s);s=st.compactState(cleanState(s));
    const r=makeBodyRecovery();
    await st.checkpoint(s,'セッション開始時の自動復元点',{scope:'active'});r.seed(s);
    for(const length of [6000,3600,2160]){
      const plan=r.plan(s,length);
      if(plan){
        await st.checkpoint(plan.snapshot,plan.reason,{scope:'active'});
      }
      s={...s,body:s.body.slice(0,length)};
      if(plan)r.completed(plan,s);
      await st.save(s);s=st.compactState(s);
    }
    for(let i=0;i<10;i++)await st.checkpoint(s,'日次自動復元点',{scope:'active'});
    const reopened=await openStore(host,()=>{},{idbFactory:idb.factory,lazyArchives:true});
    const item=(await reopened.checkpointList()).find(x=>x.reason==='本文の累積・大幅削除前');
    assert.ok(item);
    const restored=await reopened.loadCheckpoint(item.id,reopened.initial);
    assert.equal(restored.body,original);
    assert.equal(restored.branches.length,1);
    assert.equal(restored.branches[0].id,'archive');
  }
});


test('stream partial candidate and reply trash survive SQLite and IDB-only restart',async()=>{
  const {acceptTurn,updateStreamText,restoreReplyCandidate}=await import('../src/logic.js');
  const {rewindLastWithoutFork}=await import('../src/branches.js');
  for(const withSql of [true,false]){
    const sql=fakeSql(),idb=fakeIdb(),host=withSql?{db:sql}:{};
    const opts={idbFactory:idb.factory,validator:cleanState,lazyArchives:true};
    let store=await openStore(host,()=>{},opts);
    let s=acceptTurn(freshState(),{user:'入力',text:'前の返信',sourceDraft:''});
    s=rewindLastWithoutFork(s);
    s.pendingCandidate=restoreReplyCandidate(s,0);
    s.pendingCandidate.note='生成中…';s.pendingCandidate.text='';
    await store.save(s);
    assert.equal(updateStreamText(s.pendingCandidate,'途中'),true);
    const saving=store.save(s);
    updateStreamText(s.pendingCandidate,'途中まで');
    await saving;
    store=await openStore(host,()=>{},opts);
    assert.equal(store.initial.pendingCandidate.text,'途中'); // immutable save snapshot
    await store.save(s);
    const reopened=await openStore(host,()=>{},opts);
    assert.equal(reopened.initial.pendingCandidate.text,'途中まで');
    assert.deepEqual(reopened.initial.replyTrash,['前の返信']);
    assert.equal(reopened.initial.branches.length,0);
  }
});

test('lazy split missing SQL archive preserves root and other archives without IDB',async()=>{
  const sql=fakeSql(),host={db:sql},opts={lazyArchives:true,idbFactory:async()=>{throw Error('no IDB');}};
  let st=await openStore(host,()=>{},opts);
  const state=cleanState({...freshState(),body:'救出する本編',branches:[
    {id:'bad',name:'破損分岐',body:'枝'.repeat(90000)},
    {id:'good',name:'健全分岐',body:'正常な分岐本文'}]});
  await st.save(state);
  const manifest=sql.map.get('active'),m=JSON.parse(manifest);
  sql.map.delete(m.branchParts[0].parts[0]);
  const surviving=[...sql.map.keys()];
  st=await openStore(host,()=>{},opts);
  assert.equal(st.initial.body,state.body);
  assert.equal(st.initial.branches.length,2);
  assert.match(st.archiveIssue(st.initial.branches[0]),/欠落/);
  assert.equal(st.archiveIssue(st.initial.branches[1]),'');
  assert.equal(st.readOnly,true);
  assert.equal((await st.materialize(st.initial,'good')).branches[1].body,'正常な分岐本文');
  await assert.rejects(st.materialize(st.initial,'bad'),/読み込めません/);
  await assert.rejects(st.save({...st.initial,draft:'上書き禁止'}),/上書き禁止/);
  assert.equal(sql.map.get('active'),manifest);
  assert.deepEqual([...sql.map.keys()],surviving);
});

test('lazy archive checksum failure is deferred until selected and prevents later writes',async()=>{
  for(const withSql of [true,false]){
    const sql=fakeSql(),idb=fakeIdb(),host=withSql?{db:sql}:{};
    const opts={lazyArchives:true,idbFactory:idb.factory};
    let st=await openStore(host,()=>{},opts);
    await st.save(cleanState({...freshState(),body:'本編',branches:[{id:'one',name:'破損候補',body:'原文'}]}));
    const rec=idb.data.get('latest');
    idb.data.set(rec.archives[0].key,'broken');
    if(withSql){const m=JSON.parse(sql.map.get('active'));sql.map.set(m.branchParts[0].parts[0],'broken');}
    st=await openStore(host,()=>{},opts);
    assert.equal(st.initial.body,'本編');
    assert.equal(st.readOnly,false);
    await assert.rejects(st.materialize(st.initial,'one'),/読み込めません/);
    assert.match(st.archiveIssue(st.initial.branches[0]),/読み込めません/);
    assert.equal(st.readOnly,true);
    await assert.rejects(st.save(st.initial),/上書き禁止/);
  }
});

test('legacy split archives acquire summaries on next save',async()=>{
  const sql=fakeSql(),idb=fakeIdb(),host={db:sql},opts={lazyArchives:true,idbFactory:idb.factory};
  let st=await openStore(host,()=>{},opts);
  await st.save(cleanState({...freshState(),body:'旧形式',branches:[{id:'one',name:'旧分岐',body:'旧本文'}]}));
  const m=JSON.parse(sql.map.get('active')),record=idb.data.get('latest');
  for(const e of [...m.branchParts,...record.archives]){delete e.summary;delete e.summaryHash;}
  sql.map.set('active',JSON.stringify(m));idb.data.set('latest',record);
  st=await openStore(host,()=>{},opts);
  assert.equal(st.initial.branches[0].name,'旧分岐');
  await st.save({...st.initial,draft:'移行'});
  assert.equal(JSON.parse(sql.map.get('active')).branchParts[0].summary.name,'旧分岐');
  assert.equal(idb.data.get('latest').archives[0].summary.name,'旧分岐');
});

test('lazy root sections isolate settings, body and history writes across restart',async()=>{
  const sql=fakeSql(),idb=fakeIdb(),opts={idbFactory:idb.factory,lazyArchives:true};
  const host={db:sql};
  let st=await openStore(host,()=>{},opts);
  let state=cleanState({...freshState(),body:'本'.repeat(1000000),
    turns:Array.from({length:1000},(_,i)=>({user:'履歴'.repeat(30)+i,at:''}))});
  await st.save(state);
  const before=JSON.parse(sql.map.get('active')),mirrorBefore=idb.data.get('latest');
  assert.equal(before.rootSections.length,4);
  assert.equal(mirrorBefore.coreParts.length,3);
  const writes=[],scans=[],execute=sql.executeSql.bind(sql);
  sql.executeSql=async(q,a=[])=>{
    if(q.startsWith('INSERT'))writes.push(a[0]);
    if(q.startsWith('SELECT k FROM'))scans.push(q);
    return execute(q,a);
  };
  st=await openStore(host,()=>{},opts);
  state=st.initial;
  state.title+='設定';
  await st.save(state);
  const edited=JSON.parse(sql.map.get('active')),mirrorEdited=idb.data.get('latest');
  const section=(m,i)=>m.parts.slice(m.rootSections.slice(0,i).reduce((a,b)=>a+b,0),
    m.rootSections.slice(0,i+1).reduce((a,b)=>a+b,0));
  assert.deepEqual(section(edited,1),section(before,1));
  assert.deepEqual(section(edited,2),section(before,2));
  assert.deepEqual(mirrorEdited.coreParts,mirrorBefore.coreParts);
  assert.ok(writes.length<=3);
  writes.length=0;scans.length=0;
  state.body+='追加';
  await st.save(state);
  const appended=JSON.parse(sql.map.get('active')),mirrorAppended=idb.data.get('latest');
  assert.deepEqual(section(appended,2),section(edited,2));
  assert.deepEqual(mirrorAppended.coreParts.slice(1),mirrorEdited.coreParts.slice(1));
  assert.ok(writes.length<=3);
  assert.equal(scans.length,0);
  const sqlRestored=await openStore(host,()=>{},opts);
  const idbRestored=await openStore({},()=>{},opts);
  for(const restored of [sqlRestored,idbRestored]){
    assert.equal(restored.initial.body,state.body);
    assert.equal(restored.initial.title,state.title);
    assert.deepEqual(restored.initial.turns,state.turns);
  }
});


test('daily checkpoints keep three distinct dates and never evict manual or important points',async()=>{
  const realNow=Date.now;
  try{
    for(const host of [{db:fakeSql()},{}]){
      const idb=fakeIdb(),opts={idbFactory:idb.factory,lazyArchives:true};
      let st=await openStore(host,()=>{},opts);
      const s=freshState();s.body='自動復元の原稿';
      const day0=new Date(2026,10,20,12).getTime();
      Date.now=()=>day0;
      for(let i=0;i<8;i++)await st.checkpoint(s,'通常'+i);
      for(const reason of ['import','reset','本文の累積・大幅削除前'])await st.checkpoint(s,reason);
      for(let day=0;day<5;day++){
        Date.now=()=>day0+day*86400000;
        await st.checkpoint(s,'日次自動復元点',{scope:'active'});
        for(let restart=0;restart<5;restart++){
          st=await openStore(host,()=>{},opts);
          const last=await st.latestAutomaticCheckpointAt();
          assert.equal(new Date(last).toDateString(),new Date(Date.now()).toDateString());
        }
        await st.checkpoint(s,'日次自動復元点',{scope:'active'});
      }
      const list=await st.checkpointList();
      assert.equal(list.filter(e=>e.reason==='日次自動復元点').length,3);
      assert.equal(list.filter(e=>/^通常/.test(e.reason)).length,8);
      for(const reason of ['import','reset','本文の累積・大幅削除前'])assert.ok(list.some(e=>e.reason===reason));
    }
  }finally{Date.now=realNow;}
});
