// Layla SQLite is the primary store; IndexedDB is an outage fallback.
// Compatible with the legacy talking_story_data_v1 ACTIVE {version:1,parts,at} format.
// Immutable chunks -> single manifest switch; retain the previous generation.
// Never auto-overwrite healthy SQLite with unvalidated/different pending IDB data.
import {cleanState,checksum,compactBackup,expandCompactBackup,archiveReference,isArchiveReference} from './logic.js';
import {snapshot as branchSnapshot,MAX_ARCHIVED_BRANCHES} from './branches.js';

const TABLE='talking_story_data_v1',ACTIVE='active',DBNAME='talking-story-fallback-v1';
export function splitChunks(src,limit=40000){
  const chunks=[];let pos=0;
  while(pos<src.length){
    let end=Math.min(src.length,pos+limit);
    const ch=src.charCodeAt(end-1);
    if(end<src.length&&ch>=0xd800&&ch<=0xdbff)end--;
    if(end<=pos)end=Math.min(src.length,pos+2);
    chunks.push(src.slice(pos,end));pos=end;
  }
  return chunks.length?chunks:[''];
}
export {checksum} from './logic.js';
export function sqlRows(result){
  const rows=result?.rows;
  if(rows===undefined||rows===null)
    throw Error('Layla SQLiteのSELECT結果が想定外の形式です。上書きを停止します。');
  let entries=null;
  if(Array.isArray(rows))entries=Array.from(rows);
  else if(typeof rows==='object'&&Number.isSafeInteger(rows.length)&&rows.length>=0){
    entries=typeof rows.item==='function'
      ?Array.from({length:rows.length},(_,i)=>rows.item(i)):Array.from(rows);
  }
  if(!entries)throw Error('Layla SQLiteの行データ形式が不明です。');
  if(entries.some(row=>!row||typeof row!=='object'||Array.isArray(row)))
    throw Error('SQLiteの行が名前付きフィールドを含みません。');
  return entries;
}
function browserIdb(){
  return new Promise((resolve,reject)=>{
    if(typeof indexedDB==='undefined')return reject(Error('IndexedDB非対応'));
    const req=indexedDB.open(DBNAME,1);
    req.onupgradeneeded=()=>req.result.createObjectStore('snapshots');
    req.onsuccess=()=>{
      const db=req.result;
      resolve({
        get(key){return new Promise((ok,no)=>{const r=db.transaction('snapshots','readonly').objectStore('snapshots').get(key);r.onsuccess=()=>ok(r.result||null);r.onerror=()=>no(r.error);});},
        put(key,val){return new Promise((ok,no)=>{const t=db.transaction('snapshots','readwrite');t.objectStore('snapshots').put(val,key);t.oncomplete=ok;t.onerror=()=>no(t.error);t.onabort=()=>no(t.error);});},
        delete(key){return new Promise((ok,no)=>{const t=db.transaction('snapshots','readwrite');t.objectStore('snapshots').delete(key);t.oncomplete=ok;t.onerror=()=>no(t.error);t.onabort=()=>no(t.error);});}
      });
    };
    req.onerror=()=>reject(req.error);
  });
}
function validate(raw,validator){
  try{return {value:validator(raw),error:null};}
  catch(e){
    if(raw&&Array.isArray(raw.branches)&&raw.branches.length){
      try{
        const base=validator({...raw,branches:[]}),valid=[];
        for(const b of raw.branches){
          try{
            const candidate=validator({...raw,branches:[b]});
            if(candidate.branches[0]&&!valid.some(v=>v.id===candidate.branches[0].id))
              valid.push(candidate.branches[0]);
          }catch{/* Unreadable fork stays in raw evidence, not in the rescue view. */}
        }
        return {value:{...base,branches:valid},error:e,rescued:true,
          lost:raw.branches.length-valid.length};
      }catch{}
    }
    return {value:null,error:e};
  }
}
export async function openStore(host,notify=()=>{},{idbFactory=browserIdb,validator=cleanState,lazyArchives=false}={}){
  let idb=null,fallback=null,sqlAvailable=false,sqlProblem='',rawEvidence=null,sqliteCorrupt=false;
  let sqlSnapshot=null,manifest=null,readOnly=false,recoveryRequired=false;
  let preferred=null,mode='保存不可',seq=0,backupWarning='',nextSqlRetry=0,rebuildPending=false;
  // A session must never overwrite SQLite it failed to fully read on startup.
  let sqlInitialized=false,sqlRetryBlocked=false;
  const branchCache=new WeakMap();
  let rootCache=null,idbRootCache=null,idbLatest=null;
  const refData=new WeakMap(),storedRefs=new WeakMap();
  // The app opts into lazy storage; legacy callers still receive full snapshots.
  const lazy=lazyArchives&&validator===cleanState;
  const meta=b=>({id:b.id,name:b.name,createdAt:b.createdAt,parentId:b.parentId,forkTurn:b.forkTurn,
    chars:b.body.length,turnCount:b.turns.length});
  const coreOf=state=>{
    const {draft,pendingCandidate,prefs,updatedAt,branches,...core}=state;
    return {core:{...core,branches:[]},overlay:{draft,pendingCandidate,prefs,updatedAt}};
  };
  const coreSignature=core=>JSON.stringify({...core,body:''});
  function checkOverlay(overlay,hash){
    if(hash!==undefined&&checksum(JSON.stringify(overlay))!==hash)
      throw Error('下書き・生成設定のチェックサムが一致しません。');
    return overlay||{};
  }
  const sameCore=(cache,core,signature)=>cache&&cache.body===core.body&&cache.signature===signature;
  function reference(b,source,entry){
    let ref=isArchiveReference(b)?b:storedRefs.get(b);
    if(!ref){ref=archiveReference(meta(b));storedRefs.set(b,ref);refData.set(ref,{});}
    const data=refData.get(ref);
    if(!data)throw Error('別の保存先の分岐参照です。');
    data[source]=entry;
    return ref;
  }
  function compactState(state){
    if(!lazy)return state;
    return {...state,branches:state.branches.map(b=>storedRefs.get(b)||b)};
  }
  function validatedArchive(raw,id){
    if(!raw||raw.id!==id)throw Error('分岐IDが一致しません。');
    // Validate one archive independently, using a distinct active ID.
    const activeId=id==='archive-validation'?'archive-validation-2':'archive-validation';
    return cleanState({activeBranch:{id:activeId},branches:[raw]}).branches[0];
  }
  function checkedJson(raw,entry){
    if(typeof raw!=='string'||(entry.hash&&checksum(raw)!==entry.hash)||
      (entry.size!==undefined&&raw.length!==entry.size))throw Error('保存チャンクの内容が一致しません。');
    return JSON.parse(raw);
  }
  async function readArchive(b){
    if(!isArchiveReference(b))return b;
    const source=refData.get(b);
    if(!source)throw Error('保存済み分岐の参照がありません。');
    let failure=null;
    for(const type of ['idb','sql']){
      const entry=source[type];if(!entry)continue;
      try{
        const raw=type==='idb'?await idb.get(entry.key):await readParts(entry.parts,entry.hash,entry.size);
        const full=validatedArchive(checkedJson(raw,entry),b.id);
        if(JSON.stringify(meta(full))!==JSON.stringify({...b,kind:undefined}))
          throw Error('分岐の要約情報が一致しません。');
        return full;
      }catch(e){failure=e;}
    }
    throw Error('分岐「'+b.name+'」を読み込めません: '+(failure?.message||'保存先なし'));
  }
  async function materialize(state,onlyId=null){
    const branches=[];
    for(const b of state.branches||[])branches.push(onlyId===null||b.id===onlyId?await readArchive(b):b);
    return {...state,branches};
  }
  function archiveSignature(state){
    return JSON.stringify({...state,branches:state.branches.map(b=>{
      if(isArchiveReference(b)){const e=refData.get(b)?.sql||refData.get(b)?.idb;return [b.id,e?.hash,e?.size];}
      const raw=JSON.stringify(b);return [b.id,checksum(raw),raw.length];
    })});
  }
  function linkMirrors(sqlState,idbState){
    if(!lazy||!sqlState||!idbState)return;
    for(const b of sqlState.branches){
      if(!isArchiveReference(b))continue;
      const other=idbState.branches.find(x=>x.id===b.id);
      if(!isArchiveReference(other))continue;
      const a=refData.get(b),c=refData.get(other);
      if(a?.sql&&c?.idb&&a.sql.hash===c.idb.hash&&a.sql.size===c.idb.size&&
        b.name===other.name&&b.chars===other.chars&&b.turnCount===other.turnCount){
        a.idb=c.idb;c.sql=a.sql;
      }
    }
  }
  async function readSplitIdb(record){
    const rootRaw=await idb.get(record.core.key);
    const core=checkedJson(rootRaw,record.core);
    if(!Array.isArray(record.archives)||record.archives.length>30)throw Error('IndexedDB分岐目録が不正です。');
    const branches=[];
    for(const entry of record.archives){
      const full=validatedArchive(checkedJson(await idb.get(entry.key),entry),entry.id);
      branches.push(lazy?reference(full,'idb',entry):full);
    }
    if(lazy)idbRootCache={entry:record.core,body:core.body,signature:coreSignature(core)};
    return {...core,...checkOverlay(record.state,record.overlayHash),branches};
  }
  async function writeMirror(saved){
    if(!lazy){await idb.put('latest',saved);return;}
    const {state,...header}=saved,{core,overlay}=coreOf(state);
    const signature=coreSignature(core);
    const generation='snapshot/'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
    const previous=idbLatest?.format===2?idbLatest:null;
    const previousKeys=previous?[previous.core.key,...previous.archives.map(e=>e.key)]:[];
    const eligible=new Set([...previousKeys,...(previous?.previousKeys||[])]);
    const created=[];
    let coreEntry,archives=[];
    try{
      if(sameCore(idbRootCache,core,signature)&&eligible.has(idbRootCache.entry.key)){
        coreEntry=idbRootCache.entry;
      }else{
        const raw=JSON.stringify(core),key=generation+'/root';
        coreEntry={key,hash:checksum(raw),size:raw.length};
        created.push(key);await idb.put(key,raw);
      }
      for(const b of state.branches){
        const ref=isArchiveReference(b)?b:storedRefs.get(b);
        const existing=refData.get(ref)?.idb;
        let entry;
        if(existing&&eligible.has(existing.key))entry=existing;
        else{
          const full=await readArchive(b),raw=JSON.stringify(full),key=generation+'/branch/'+b.id;
          entry={id:b.id,key,hash:checksum(raw),size:raw.length};
          created.push(key);await idb.put(key,raw);
        }
        archives.push(entry);
      }
      const record={...header,format:2,state:overlay,overlayHash:checksum(JSON.stringify(overlay)),core:coreEntry,archives,previousKeys,generation};
      // Manifest last: interrupted writes cannot replace the last valid snapshot.
      await idb.put('latest',record);
      idbLatest=record;idbRootCache={entry:coreEntry,body:core.body,signature};
      for(let i=0;i<state.branches.length;i++)reference(state.branches[i],'idb',archives[i]);
      const keep=new Set([coreEntry.key,...archives.map(e=>e.key),...previousKeys]);
      for(const key of previous?.previousKeys||[])if(!keep.has(key)){
        try{await idb.delete?.(key);}catch{/* keep extra recovery data */}
      }
    }catch(e){
      // If the manifest write committed despite an SDK error, preserve its parts.
      try{
        const active=await idb.get('latest');
        if(active?.generation!==generation)
          for(const key of created)await idb.delete?.(key);
      }catch{/* uncertain storage state: do not destroy data */}
      throw e;
    }
  }
  const sql=host?.db?.executeSql;
  const run=async(q,args=[])=>host.db.executeSql(q,args);
  // An empty result is only safe if the returned row container is valid.
  async function readActiveRows(){
    const rows=sqlRows(await run('SELECT v FROM '+TABLE+' WHERE k=?',[ACTIVE]));
    if(rows.length>1||(rows.length===1&&typeof rows[0].v!=='string'))
      throw Error('SQLite ACTIVEのSELECT結果に有効なvフィールドがありません。上書きを停止します。');
    return rows;
  }
  let idbReadError=null;
  try{
    idb=await idbFactory();fallback=await idb.get('latest');
    if(fallback?.format===2){
      idbLatest=fallback;
      try{fallback={...fallback,state:await readSplitIdb(fallback)};}
      catch(e){idbReadError=e;}
    }
  }catch(e){notify('IndexedDBを利用できません: '+String(e.message||e));}
  if(typeof sql!=='function'){sqlProblem='SQLite API非対応（通常ブラウザ等）';}
  else{
    try{
      await run('CREATE TABLE IF NOT EXISTS '+TABLE+' (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
      sqlAvailable=true;
      const rows=await readActiveRows();
      if(rows.length){
        rawEvidence=rows[0].v;
        manifest=JSON.parse(String(rawEvidence));
        if(manifest.version!==1||!Array.isArray(manifest.parts)||manifest.parts.length>1200)
          throw Error('ACTIVEマニフェストの形式が不正');
        const loaded=await decodeGeneration(manifest,lazy);
        sqlSnapshot={state:loaded,validated:validate(loaded,validator),rev:Number(manifest.rev)||0};
        seq=Math.max(seq,sqlSnapshot.rev);
        if(sqlSnapshot.validated.error)throw Error('SQLite保存内容の検証失敗: '+sqlSnapshot.validated.error.message+
          (sqlSnapshot.validated.rescued?'。正常な本文と分岐を読取専用で救出しました。':'') );
        rawEvidence=null;
      }
      sqlInitialized=true;
    }catch(e){
      sqlProblem=String(e.message||e);
      // If the API/table itself fails before a manifest is read, this can be
      // transient unavailability, NOT corrupted saved data. Allow IDB fallback.
      sqliteCorrupt=rawEvidence!==null||manifest!==null;
      readOnly=sqliteCorrupt;sqlAvailable=false;nextSqlRetry=Date.now()+20000;
      sqlRetryBlocked=!sqlInitialized;
      notify(sqliteCorrupt?'SQLite保存を検証できません。上書きを停止しました: '+sqlProblem:'SQLiteを読み込めません。この起動中はSQLiteへ書き込まず、IndexedDBへ退避を試します。再起動後に保存元を確認してください: '+sqlProblem);
    }
  }
  let idbValid=null;
  if(idbReadError){idbValid={value:null,error:idbReadError};notify('IndexedDBの分割保存を検証できません: '+idbReadError.message,true);}
  else if(fallback?.state){
    idbValid=validate(fallback.state,validator);
    if(idbValid.error)notify('IndexedDBの退避データが不正です。SQLiteへ自動復旧しません: '+idbValid.error.message,true);
    else seq=Math.max(seq,Number(fallback.rev)||0);
  }
  const cleanIdb=Boolean(idbValid?.value&&!idbValid.error);
  if(cleanIdb&&!sqlSnapshot?.validated.error)linkMirrors(sqlSnapshot?.validated.value,idbValid.value);
  const different=Boolean(cleanIdb&&sqlSnapshot?.validated.value&&!sqlSnapshot.validated.error&&
    (lazy?fallback.pending&&archiveSignature(idbValid.value)!==archiveSignature(sqlSnapshot.validated.value):
      JSON.stringify(idbValid.value)!==JSON.stringify(sqlSnapshot.validated.value)));
  const safeFastForward=Boolean(cleanIdb&&fallback?.pending&&different&&sqlAvailable&&
    Number.isSafeInteger(fallback.baseRev)&&fallback.baseRev>0&&fallback.baseRev===sqlSnapshot?.rev);
  if(fallback?.pending&&cleanIdb&&different&&sqlAvailable&&!safeFastForward){
    recoveryRequired=true;readOnly=true;
    preferred=idbValid.value; // Display but do NOT write until explicit choice.
    notify('SQLiteとIndexedDBの未同期編集が異なります。復旧元を選ぶまで保存を停止します。');
  }else if(safeFastForward){
    preferred=idbValid.value;
  }else if(sqlSnapshot?.validated.value&&!sqlSnapshot.validated.error){
    preferred=sqlSnapshot.validated.value;
  }else if(idbValid?.value&&!idbValid.error){
    preferred=idbValid.value;
  }else if(sqlSnapshot?.validated.value){
    preferred=sqlSnapshot.validated.value;
  }else if(idbValid?.value){
    preferred=idbValid.value;
  }else if(idbValid?.error&&!sqlSnapshot){
    readOnly=true;
  }
  if(sqliteCorrupt)readOnly=true;
  if(!sqlAvailable&&!idb)mode='保存不可';
  else if(sqlAvailable)mode='SQLite';
  else mode=idb?'IndexedDB（退避）':'保存不可';

  async function readParts(parts,expectedHash,expectedSize){
    if(!Array.isArray(parts)||parts.length>1500)throw Error('保存部品数が不正です。');
    const chunks=[];
    for(const key of parts){
      const record=sqlRows(await run('SELECT v FROM '+TABLE+' WHERE k=?',[key]));
      if(typeof record[0]?.v!=='string')throw Error('保存チャンク欠落: '+key);
      chunks.push(record[0].v);
    }
    const raw=chunks.join('');
    if(expectedHash&&checksum(raw)!==expectedHash)throw Error('チェックサムが不一致');
    if(expectedSize!==undefined&&raw.length!==expectedSize)throw Error('保存文字数が不一致');
    return raw;
  }
  async function decodeGeneration(m,refs=false){
    if(!m||!Array.isArray(m.parts))throw Error('保存世代の情報がありません。');
    const raw=await readParts(m.parts,m.hash,m.size),core=JSON.parse(raw);
    const root={...core,...checkOverlay(m.overlay,m.overlayHash)};
    // A fresh session can reuse unchanged root chunks too. This layout is
    // produced by splitChunks; legacy roots are migrated on the next save.
    if(refs&&m===manifest&&m.overlay){
      const chunks=splitChunks(raw);
      if(chunks.length===m.parts.length)
        rootCache={manifest:m,chunks,body:core.body,signature:coreSignature(core)};
    }
    // Old v1 manifest contains ALL branches inside root; new v1 stores immutable
    // archived branch blobs independently to avoid rewriting them on every edit.
    if(Array.isArray(m.branchParts)){
      const branches=[];
      for(const b of m.branchParts){
        const data=await readParts(b.parts,b.hash,b.size);
        const branch=JSON.parse(data);
        if(branch.id!==b.id)throw Error('分岐IDが一致しません。');
        // Verify one archive at a time on startup; keep only its summary.
        branches.push(refs?reference(validatedArchive(branch,b.id),'sql',b):branch);
      }
      root.branches=branches;
    }
    return root;
  }
  async function readGeneration(m){return validator(await decodeGeneration(m));}
  async function writeSql(state){
    if(!sqlInitialized||sqlRetryBlocked||!sqlAvailable)
      throw Error('SQLiteの初期読込が未確認です。自動上書きを禁止します。');
    const generation='g'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
    const {core,overlay}=coreOf(state);
    const rootState=lazy?core:{...state,branches:[]};
    const signature=lazy?coreSignature(core):null;
    const reusable=lazy&&rootCache?.manifest===manifest&&sameCore(rootCache,core,signature);
    const rootJson=reusable?null:JSON.stringify(rootState);
    const chunks=reusable?rootCache.chunks:splitChunks(rootJson);
    if(chunks.length>1000)throw Error('SQLiteの容量上限（約4000万文字）を超えました。JSON保存を推奨します。');
    const keys=[];
    for(let i=0;i<chunks.length;i++){
      // Exact equality, not just a checksum: immutable chunks can be reused.
      if(rootCache?.manifest===manifest&&rootCache.chunks[i]===chunks[i]&&manifest.parts[i]){
        keys.push(manifest.parts[i]);continue;
      }
      const key=generation+'/root/'+i;keys.push(key);
      await run('INSERT INTO '+TABLE+' (k,v) VALUES (?,?)',[key,chunks[i]]);
    }
    const previousBranches=new Map((manifest?.branchParts||[]).map(b=>[b.id,b]));
    const branchParts=[];
    for(const b of state.branches||[]){
      const old=previousBranches.get(b.id);
      const ref=isArchiveReference(b)?b:storedRefs.get(b);
      if(old&&(branchCache.get(b)===old||refData.get(ref)?.sql===old)){branchParts.push(old);continue;}
      const full=lazy?await readArchive(b):b;
      const json=JSON.stringify(full),hash=checksum(json);
      if(old&&old.hash===hash&&old.size===json.length){
        branchParts.push(old);if(validator===cleanState)branchCache.set(b,old);continue;
      }
      const parts=splitChunks(json),bkeys=[];
      for(let i=0;i<parts.length;i++){
        const key=generation+'/branch/'+b.id+'/'+i;bkeys.push(key);
        await run('INSERT INTO '+TABLE+' (k,v) VALUES (?,?)',[key,parts[i]]);
      }
      const entry={id:b.id,parts:bkeys,hash,size:json.length};
      branchParts.push(entry);if(validator===cleanState)branchCache.set(b,entry);
    }
    const previous=manifest?{
      version:1,parts:manifest.parts,at:manifest.at,
      ...(manifest.hash?{hash:manifest.hash}:{}),
      ...(manifest.size!==undefined?{size:manifest.size}:{}),
      ...(manifest.branchParts?{branchParts:manifest.branchParts}:{}),
      ...(manifest.overlay?{overlay:manifest.overlay,...(manifest.overlayHash!==undefined?{overlayHash:manifest.overlayHash}:{})}:{}),
      rev:manifest.rev||0
    }:null;
    const next={version:1,parts:keys,branchParts,at:Date.now(),rev:++seq,
      hash:reusable?manifest.hash:checksum(rootJson),size:reusable?manifest.size:rootJson.length,previous,
      ...(lazy?{overlay,overlayHash:checksum(JSON.stringify(overlay))}:{})};
    await run('INSERT OR REPLACE INTO '+TABLE+' (k,v) VALUES (?,?)',[ACTIVE,JSON.stringify(next)]);
    manifest=next;rootCache={manifest:next,chunks,body:core.body,signature};rawEvidence=null;
    if(lazy)for(let i=0;i<state.branches.length;i++)reference(state.branches[i],'sql',branchParts[i]);
    // Retain active and previous immutable branches. GC only unreferenced
    // generations; never remove checkpoint chunks.
    try{
      const retain=new Set([ACTIVE,...keys,...(previous?.parts||[])]);
      for(const b of [...branchParts,...(previous?.branchParts||[])])for(const key of b.parts)retain.add(key);
      const all=sqlRows(await run('SELECT k FROM '+TABLE));
      // Recovery markers survive restart and protect every readable old generation row.
      for(const {k} of all){
        if(typeof k!=='string')continue;
        if(k.startsWith('corrupt-keep/'))retain.add(k.slice('corrupt-keep/'.length));
        if(k.startsWith('corrupt-backup/')&&!k.startsWith('corrupt-backup/v2-')){
          // Older versions saved only a manifest; conservatively retain all rows if unreadable.
          const raw=sqlRows(await run('SELECT v FROM '+TABLE+' WHERE k=?',[k]))[0]?.v;
          const old=JSON.parse(raw);
          if(!Array.isArray(old.parts))throw Error('旧破損目録を解析できません。清掃を保留します。');
          for(const generation of [old,old.previous])if(generation){
            for(const key of generation.parts||[])retain.add(key);
            for(const b of generation.branchParts||[])for(const key of b.parts||[])retain.add(key);
          }
        }
      }
      for(const row of all){
        const key=row.k;
        if(typeof key==='string'&&key.startsWith('g')&&!retain.has(key))
          await run('DELETE FROM '+TABLE+' WHERE k=?',[key]);
      }
    }catch(e){notify('保存世代の整理を次回へ延期しました: '+e.message,true);}
  }
  async function commit(state){
    if(readOnly)throw Error('読み取り専用です。復旧元を確認するかJSONバックアップを利用してください。');
    const saved={state,rev:seq+1,at:Date.now(),baseRev:sqlInitialized&&!sqlRetryBlocked?(manifest?.rev||0):null,pending:true};
    if(!sqlAvailable&&!sqliteCorrupt&&sqlInitialized&&!sqlRetryBlocked&&
       typeof sql==='function'&&Date.now()>=nextSqlRetry){
      try{
        await run('CREATE TABLE IF NOT EXISTS '+TABLE+' (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
        const rows=await readActiveRows();
        // The ACTIVE manifest must still be exactly the generation we read.
        // Never write into an unknown or concurrently changed SQLite database.
        if(rows.length){
          const current=JSON.parse(String(rows[0].v));
          if(!manifest||JSON.stringify(current)!==JSON.stringify(manifest))
            throw Error('SQLite保存世代が変化しています。自動上書きを禁止しました。');
          // A matching manifest is not sufficient if its chunks became unreadable.
          await readGeneration(current);
        }else if(manifest){
          throw Error('SQLiteの既存ACTIVEが見つかりません。自動上書きを禁止しました。');
        }
        sqlAvailable=true;
      }catch(e){
        sqlRetryBlocked=/自動上書きを禁止/.test(String(e.message||e));
        nextSqlRetry=Date.now()+20000;sqlProblem=String(e.message||e);
        notify('SQLite自動復旧を中止しました。IndexedDBへ退避: '+sqlProblem,true);
      }
    }
    if(sqlAvailable){
      try{
        await writeSql(state);
        mode='SQLite';
        let mirrorFailed=false;
        if(idb)await writeMirror({...saved,rev:seq,pending:false}).catch(()=>{mirrorFailed=true;});
        backupWarning=mirrorFailed?'SQLite保存済み。ただしIndexedDBミラー更新失敗。外部JSONバックアップ推奨。':'';
        notify(backupWarning||'保存済み（Layla SQLite）',mirrorFailed);
        return;
      }catch(e){
        const message=String(e.message||e);
        if(message.includes('容量上限')){notify(message);throw e;}
        sqlAvailable=false;sqlProblem=message;nextSqlRetry=Date.now()+20000;
        notify('SQLite書込失敗（IndexedDBへ退避）: '+message,true);
      }
    }
    if(idb){
      await writeMirror({...saved,rev:++seq,pending:true});
      mode='IndexedDB（未同期退避）';notify('IndexedDBへ退避しました。外部JSONバックアップも推奨します。');
      return;
    }
    mode='保存不可';notify('保存先がありません。JSON書き出しが必要です。');
    throw Error('SQLite・IndexedDBとも保存できませんでした。');
  }
  let queued=null,working=false,waiters=[];
  async function processQueue(){
    if(working)return;
    working=true;
    try{
      while(queued!==null){
        const raw=queued, listeners=waiters;
        queued=null;waiters=[];
        try{await commit(raw);listeners.forEach(w=>w.resolve());}
        catch(e){listeners.forEach(w=>w.reject(e));}
      }
    }finally{working=false;}
  }
  function save(state){
    if(readOnly)return Promise.reject(Error('復旧確認が必要なため上書き禁止です。'));
    // Snapshot active mutable fields now; share only canonical immutable archives.
    // Custom validators keep the previous defensive deep-copy contract.
    let raw;try{raw=validator===cleanState?cleanState(state):validator(JSON.parse(JSON.stringify(state)));}catch(e){return Promise.reject(e);}
    return new Promise((resolve,reject)=>{
      queued=raw;waiters.push({resolve,reject});
      if(!working)void processQueue();
    });
  }
  // A checkpoint's parent key holds small metadata; its data is in chunks.
  // Old single-row SQL and IDB checkpoints remain readable.
  let checkpointTail=Promise.resolve(),lastCheckpointAt=0;
  const protectedReason=reason=>/^(import|reset)$|取込|読み込|新規作成|新しい作品|本文.*(削除|大幅)/.test(reason||'');
  function retention(entries){
    const regular=entries.filter(e=>!protectedReason(e.reason)),important=entries.filter(e=>protectedReason(e.reason));
    // Independent quota: ordinary operations never evict the last three important points.
    return [...regular.slice(0,8),...important.slice(0,3)];
  }
  async function checkpoint(state,reason='操作前',{scope=lazy?'active':'full',branchId=null}={}){
    if(readOnly)throw Error('復旧中のため復元点を作成できません。');
    // Snapshot before waiting: the caller may continue editing the state.
    const snapshot=validator(state);
    // Replacing an entire work or resolving storage conflicts must preserve all
    // archives. Ordinary points preserve only the active branch.
    if(scope==='active'&&(/^(import|reset)$|復旧元|自動復旧前/.test(reason)))scope='full';
    let normalized,raw,format;
    if(scope==='branch'){
      const b=snapshot.branches.find(x=>x.id===branchId);
      if(!b)throw Error('削除する分岐が見つかりません。');
      const branch=await readArchive(b);
      normalized={title:branch.name,body:branch.body};
      raw=JSON.stringify({scope:'branch',branch});format='scoped-v1';
    }else if(scope==='active'){
      normalized=validator({...snapshot,branches:[]});
      raw=JSON.stringify({scope:'active',state:normalized});format='scoped-v1';
    }else if(scope==='full'){
      normalized=lazy?await materialize(snapshot):snapshot;
      const compact=Boolean(normalized.branches?.length);
      raw=compact?compactBackup(normalized):JSON.stringify(normalized);
      format=compact?'shared-prefix-v2':'v1';
    }else throw Error('復元点の範囲が不正です。');
    const at=lastCheckpointAt=Math.max(Date.now(),lastCheckpointAt+1);
    const id='checkpoint/'+at.toString(36)+'-'+Math.random().toString(36).slice(2,8);
    const entry={id,at,title:normalized.title,chars:normalized.body.length,reason,
      format,scope,hash:checksum(raw),size:raw.length};
    // A concurrent checkpoint must never prune another's unfinished chunks.
    const task=checkpointTail.then(()=>writeCheckpoint(entry,raw));
    checkpointTail=task.catch(()=>{});
    return task;
  }
  async function writeCheckpoint(entry,raw){
    if(readOnly)throw Error('復旧中のため復元点を作成できません。');
    const {id}=entry;
    let sqlFailure=null;
    if(sqlAvailable){
      try{
        const parts=splitChunks(raw),names=[];
        if(parts.length>1200)throw Error('復元点のチャンクが多すぎます。');
        for(let i=0;i<parts.length;i++){
          const key=id+'/part/'+i;
          await run('INSERT INTO '+TABLE+' (k,v) VALUES (?,?)',[key,parts[i]]);
          names.push(key);
        }
        await run('INSERT INTO '+TABLE+' (k,v) VALUES (?,?)',[id,JSON.stringify({...entry,parts:names})]);
        try{await pruneSqlCheckpoints(id);}catch(e){notify('古い復元点の整理は次回行います: '+e.message,true);}
        return;
      }catch(e){
        sqlFailure=e;
        // If the parent was actually committed despite an SDK error, do not
        // delete its data. Otherwise reclaim partial writes immediately.
        try{
          const parent=sqlRows(await run('SELECT v FROM '+TABLE+' WHERE k=?',[id]));
          if(!parent.length){
            const keys=sqlRows(await run('SELECT k FROM '+TABLE)).map(r=>r.k);
            for(const key of keys)if(typeof key==='string'&&key.startsWith(id+'/part/'))
              await run('DELETE FROM '+TABLE+' WHERE k=?',[key]);
          }
        }catch{/* A future successful checkpoint will collect orphan chunks. */}
        notify('SQLite復元点の作成に失敗しました。IndexedDBへ退避を試します: '+e.message,true);
      }
    }
    if(idb){
      // Only index metadata is read to show the restore picker.
      await idb.put('checkpoint-data/'+id,raw);
      const list=(await idb.get('checkpoint-index'))||[];
      const sorted=[entry,...list].sort((a,b)=>(Number(b.at)||0)-(Number(a.at)||0));
      const kept=retention(sorted),keepIds=new Set(kept.map(x=>x.id));
      try{await idb.put('checkpoint-index',kept);}
      catch(e){if(typeof idb.delete==='function')try{await idb.delete('checkpoint-data/'+id);}catch{}throw e;}
      for(const old of sorted.filter(x=>!keepIds.has(x.id)))if(typeof idb.delete==='function')
        try{await idb.delete('checkpoint-data/'+old.id);}catch(e){notify('古いIndexedDB復元点の清掃を延期します: '+e.message,true);}
      return;
    }
    throw sqlFailure||Error('復元点を保存できません。');
  }
  async function sqlCheckpointParents(){
    const keys=sqlRows(await run('SELECT k FROM '+TABLE)).map(r=>r.k)
      .filter(k=>typeof k==='string'&&/^checkpoint\/[^/]+$/.test(k));
    const parents=[];
    for(const key of keys){
      try{
        const row=sqlRows(await run('SELECT v FROM '+TABLE+' WHERE k=?',[key]))[0]?.v;
        if(typeof row!=='string')continue;
        const entry=JSON.parse(row);
        if(!entry||typeof entry!=='object'||(!Array.isArray(entry.parts)&&typeof entry.data!=='string'))throw Error('復元点の親情報が不正です。');
        parents.push({key,entry});
      }catch(e){notify('旧復元点のメタ情報を読めません: '+e.message,true);}
    }
    return parents;
  }
  async function pruneSqlCheckpoints(newId){
    const parents=await sqlCheckpointParents();
    parents.sort((a,b)=>(Number(b.entry.at)||0)-(Number(a.entry.at)||0)||
      Number(b.key===newId)-Number(a.key===newId)||b.key.localeCompare(a.key));
    const keepIds=new Set(retention(parents.map(p=>({...p.entry,id:p.key}))).map(e=>e.id));
    const keep=parents.filter(p=>keepIds.has(p.key)),drop=parents.filter(p=>!keepIds.has(p.key));
    // Include every committed parent part in the keep-set. Remove uncommitted
    // orphan /part rows as well as parts of evicted snapshots.
    const keptParts=new Set(keep.flatMap(p=>Array.isArray(p.entry.parts)?p.entry.parts:[]));
    const keys=sqlRows(await run('SELECT k FROM '+TABLE)).map(r=>r.k);
    const readable=new Set(parents.map(p=>p.key));
    const unknown=new Set(keys.filter(k=>typeof k==='string'&&/^checkpoint\/[^/]+$/.test(k)&&!readable.has(k)));
    // Preserve parts of unreadable parent rows for forensic recovery. Remove
    // evicted parents first, so an interrupted GC never leaves a broken parent.
    for(const p of drop)await run('DELETE FROM '+TABLE+' WHERE k=?',[p.key]);
    for(const key of keys){
      if(typeof key!=='string'||!key.startsWith('checkpoint/')||!key.includes('/part/'))continue;
      const owner=key.slice(0,key.indexOf('/part/'));
      if(!keptParts.has(key)&&!unknown.has(owner))
        await run('DELETE FROM '+TABLE+' WHERE k=?',[key]);
    }
  }
  let legacyMigration=null;
  function legacyCheckpointIndex(){
    if(!legacyMigration)legacyMigration=(async()=>{
      const existing=await idb.get('legacy-checkpoint-index');
      if(Array.isArray(existing))return existing;
      const legacy=await idb.get('checkpoints');
      if(!Array.isArray(legacy)||!legacy.length)return [];
      const entries=[];
      for(let i=0;i<legacy.length;i++){
        const entry=legacy[i];
        if(!entry||typeof entry.data!=='string')continue;
        const id='legacy-idb/'+i;
        await idb.put('legacy-checkpoint-data/'+i,entry.data);
        entries.push({id,at:entry.at,title:entry.title,chars:entry.chars,
          reason:entry.reason||'旧IndexedDB復元点'});
      }
      // Publish only after every valid entry is written. Retain unreadable
      // legacy evidence rather than deleting it if conversion was incomplete.
      await idb.put('legacy-checkpoint-index',entries);
      if(entries.length===legacy.length&&typeof idb.delete==='function')
        try{await idb.delete('checkpoints');}catch{}
      return entries;
    })().catch(e=>{legacyMigration=null;throw e;});
    return legacyMigration;
  }
  async function checkpointList(){
    const all=[];
    if(sqlAvailable){
      const parents=await sqlCheckpointParents();
      for(const {key,entry} of parents)
        all.push({id:key,at:Number(entry.at)||0,title:entry.title,chars:entry.chars,reason:entry.reason||'旧復元点',scope:entry.scope||'full',hash:entry.hash,size:entry.size});
      if(manifest?.previous)all.push({id:'previous',at:manifest.previous.at||0,
        title:'直前の保存世代',chars:null,reason:'直前の保存世代'});
    }
    if(idb)try{
      const indexed=await idb.get('checkpoint-index');
      for(const entry of indexed||[])all.push({id:'idb/'+entry.id,at:entry.at,title:entry.title,chars:entry.chars,
        reason:entry.reason||'IndexedDB復元点',scope:entry.scope||'full',hash:entry.hash,size:entry.size});
      // Old IDB versions stored every snapshot in one array. Convert once to
      // individual records; future lists do not load the old manuscript bodies.
      const legacy=await legacyCheckpointIndex();
      for(const entry of legacy)all.push(entry);
    }catch(e){notify('IndexedDB復元点の一覧を読み込めません: '+e.message,true);}
    return all.sort((a,b)=>b.at-a.at);
  }
  async function loadCheckpoint(id,current=null){
    let raw=null,metadata=null;
    if(id==='previous'){
      if(!manifest?.previous)throw Error('直前の保存世代がありません。');
      return readGeneration(manifest.previous);
    }
    if(id.startsWith('idb/')){
      if(!idb)throw Error('IndexedDBが利用できません。');
      metadata=((await idb.get('checkpoint-index'))||[]).find(x=>x.id===id.slice(4));
      raw=await idb.get('checkpoint-data/'+id.slice(4));
    }else if(id.startsWith('legacy-idb/')){
      const n=Number(id.slice('legacy-idb/'.length));
      raw=await idb?.get('legacy-checkpoint-data/'+n);
      if(typeof raw!=='string'){
        const legacy=await idb?.get('checkpoints');
        raw=legacy?.[n]?.data;
      }
    }else if(/^checkpoint\/[^/]+$/.test(id)){
      const entryText=sqlRows(await run('SELECT v FROM '+TABLE+' WHERE k=?',[id]))[0]?.v;
      if(typeof entryText!=='string')throw Error('復元点の情報がありません。');
      const entry=JSON.parse(entryText);
      raw=entry.data??await readParts(entry.parts,entry.hash,entry.size);
      if(entry.hash&&checksum(raw)!==entry.hash)throw Error('復元点のチェックサムが一致しません。');
    }
    if(typeof raw!=='string')throw Error('復元点を読み込めません。');
    if(metadata&&(metadata.hash&&checksum(raw)!==metadata.hash||metadata.size!==undefined&&raw.length!==metadata.size))
      throw Error('IndexedDB復元点のチェックサムが一致しません。');
    const parsed=JSON.parse(raw);
    if(parsed.scope==='branch'){
      if(!current)throw Error('分岐の復元には現在の作品が必要です。');
      const d=validator(current),b=validatedArchive(parsed.branch,parsed.branch?.id);
      if(d.activeBranch.id===b.id||d.branches.some(x=>x.id===b.id))
        throw Error('同じIDの分岐が存在します。既存分岐を上書きしません。');
      if(d.branches.length>=MAX_ARCHIVED_BRANCHES)throw Error('分岐が上限に達しています。');
      return validator({...d,branches:[...d.branches,b]});
    }
    if(parsed.scope==='active'){
      const restored=validator(parsed.state);
      if(!current)return restored;
      const d=validator(current),branches=d.branches.filter(b=>b.id!==restored.activeBranch.id);
      if(d.activeBranch.id!==restored.activeBranch.id){
        if(branches.length>=MAX_ARCHIVED_BRANCHES)throw Error('現在の分岐を保護する空きがありません。');
        branches.push(branchSnapshot(d,d.activeBranch));
      }
      return validator({...restored,branches});
    }
    return validator(parsed?.version===2?expandCompactBackup(parsed):parsed);
  }
  // Backward-compatible eager API for existing callers/tests. The UI uses
  // checkpointList + loadCheckpoint to avoid loading 12 huge documents at once.
  async function checkpoints(){
    const list=await checkpointList();
    const out=[];
    for(const entry of list)try{
      const data=JSON.stringify(await materialize(await loadCheckpoint(entry.id,preferred)));
      out.push({...entry,data});
    }catch(e){notify('復元点が破損しています: '+e.message,true);}
    return out;
  }
  async function chooseRecovery(which){
    if(!recoveryRequired)throw Error('復旧元の選択は必要ありません。');
    const selected=which==='idb'?(idbValid&&!idbValid.error?idbValid.value:null):which==='sqlite'?sqlSnapshot?.validated.value:null;
    if(!selected)throw Error('復旧元が見つかりません。');
    const wasReadOnly=readOnly,wasRequired=recoveryRequired;
    try{
      readOnly=false;
      // Retain both versions before switching; all steps must finish.
      const other=which==='idb'?sqlSnapshot?.validated.value:idbValid?.value;
      if(other)await checkpoint(other,'選ばなかった復旧元');
      await checkpoint(selected,'復旧前に選択した保存元');
      nextSqlRetry=0; // An explicit user recovery always retries SQLite immediately.
      await save(selected);
      if(sqlSnapshot?.validated.value&&mode!=='SQLite')
        throw Error('SQLiteへの復旧書き込みが完了していません。再試行できます。');
      recoveryRequired=false;
      return selected;
    }catch(e){
      readOnly=wasReadOnly;recoveryRequired=wasRequired;
      throw e;
    }
  }
  async function allowImportRecovery(){
    if(recoveryRequired)throw Error('まずSQLite/IndexedDBの復旧元を選択してください。');
    if(!sqlAvailable&&!idb&&!(sqliteCorrupt&&typeof sql==='function'))throw Error('保存先がありません。JSONは閲覧できますが端末へ保存できません。');
    // User-confirmed recovery: preserve the corrupt ACTIVE manifest under a new
    // key before replacing it. Do not GC unknown orphan chunks on this write.
    if(sqliteCorrupt&&typeof sql==='function'){
      try{
        const recoveredManifest=rawEvidence||JSON.stringify(manifest||{});
        await run('INSERT INTO '+TABLE+' (k,v) VALUES (?,?)',[
          'corrupt-backup/v2-'+Date.now()+'-'+Math.random().toString(36).slice(2),recoveredManifest
        ]);
        // Preserve all old generation keys, even if the damaged manifest cannot be parsed.
        // Publish write permission only after every durable protection marker is written.
        const keys=sqlRows(await run('SELECT k FROM '+TABLE)).map(row=>row.k);
        for(const key of keys)if(typeof key==='string'&&key.startsWith('g'))
          await run('INSERT OR REPLACE INTO '+TABLE+' (k,v) VALUES (?,?)',['corrupt-keep/'+key,'1']);
        manifest=null;rootCache=null;sqlAvailable=true;sqlInitialized=true;sqlRetryBlocked=false;
        sqliteCorrupt=false;sqlProblem='';
      }catch(e){
        notify('SQLite復旧準備に失敗しました。破損データを保護するため復旧を中止します: '+e.message,true);
        throw e;
      }
    }
    if(!sqlAvailable&&!idb)throw Error('SQLite復旧にも失敗し保存先がありません。読み取り専用を維持します。');
    readOnly=false;
    if(!sqlAvailable&&idb)mode='IndexedDB（退避）';
    return true;
  }
  async function rebuildFromIdb(){
    if(!cleanIdb||recoveryRequired||!readOnly||(!sqliteCorrupt&&!rebuildPending))throw Error('検証済みIndexedDBからの再作成は利用できません。');
    const selected=idbValid.value;
    rebuildPending=true;
    try{
      await allowImportRecovery();
      nextSqlRetry=0;
      await save(selected);
      if(mode!=='SQLite')throw Error('SQLiteへの書き込みを確認できません。');
      rebuildPending=false;return selected;
    }catch(e){readOnly=true;throw e;}
  }
  // Export bounded groups of raw SQLite rows, including archived branches,
  // previous generations, checkpoint chunks and damaged backup evidence.
  async function rawRowKeys(){
    if(typeof sql!=='function')throw Error('SQLite APIを利用できません。');
    return sqlRows(await run('SELECT k FROM '+TABLE)).map(r=>r.k)
      .filter(k=>typeof k==='string'&&!k.startsWith('corrupt-keep/')).sort();
  }
  async function rawRowPage(keys,page=0){
    const pageSize=10;
    if(!Array.isArray(keys)||!Number.isSafeInteger(page)||page<0||page>=Math.ceil(keys.length/pageSize))
      throw Error('救出ページが不正です。');
    const rows=[];
    for(const key of keys.slice(page*pageSize,(page+1)*pageSize)){
      try{
        const value=sqlRows(await run('SELECT v FROM '+TABLE+' WHERE k=?',[key]))[0]?.v;
        if(typeof value!=='string')throw Error('保存行がありません。');
        rows.push({key,value});
      }catch(e){rows.push({key,error:String(e.message||e)});}
    }
    return JSON.stringify({schema:'layla-talking-story-recovery-rows',page:page+1,pages:Math.ceil(keys.length/pageSize),rows});
  }
  async function rawDump(){
    const LIMIT=2_000_000,MAX_PARTS=1200;
    const evidence={schema:'layla-talking-story-recovery-raw',sqliteError:sqlProblem,
      rawManifest:rawEvidence,activeManifest:manifest,limitChars:LIMIT,
      notice:'救出専用JSONです（通常のバックアップとしては読み込めません）。現在の本文JSONチャンクを最大200万文字まで収録します。欠落箇所はchunkErrors、収録位置はchunkRangesで確認できます。'};
    if(fallback?.state){
      evidence.indexedDbStatus={pending:fallback.pending,at:fallback.at,rev:fallback.rev};
      // Avoid serializing every archived branch merely to obtain a short prefix.
      try{
        const {title,body}=fallback.state;
        evidence.indexedDbRawPrefix=JSON.stringify({title:typeof title==='string'?title.slice(0,120):'',body:typeof body==='string'?body.slice(0,100_000):''});
        evidence.indexedDbBodyTruncated=typeof body==='string'&&body.length>100_000;
      }catch(e){evidence.indexedDbError=String(e.message||e);}
    }
    let current=manifest||(()=>{try{return JSON.parse(rawEvidence);}catch{return null;}})();
    // Retry a failed startup read for rescue only; do not change write permissions.
    if(!current&&typeof sql==='function'){
      try{
        const value=sqlRows(await run('SELECT v FROM '+TABLE+' WHERE k=?',[ACTIVE]))[0]?.v;
        if(typeof value==='string'){evidence.rawManifest=value;current=JSON.parse(value);}
      }catch(e){evidence.manifestReadError=String(e.message||e);}
    }
    if(Array.isArray(current?.parts)&&typeof sql==='function'){
      const found=[],errors=[],ranges=[];let total=0,visited=0,truncated=false;
      for(const key of current.parts){
        if(total>=LIMIT||visited>=MAX_PARTS){truncated=true;break;}
        const index=visited++;
        try{
          if(typeof key!=='string')throw Error('チャンクキーが不正です');
          const part=sqlRows(await run('SELECT v FROM '+TABLE+' WHERE k=?',[key]))[0]?.v;
          if(typeof part!=='string')throw Error('チャンクが欠落しています');
          let length=Math.min(part.length,LIMIT-total);
          if(length<part.length){
            truncated=true;
            const last=part.charCodeAt(length-1);
            if(last>=0xd800&&last<=0xdbff)length--;
          }
          found.push(part.slice(0,length));
          ranges.push({index,key,start:total,length,originalLength:part.length});
          total+=length;
          if(truncated)break;
        }catch(e){errors.push({index,key,error:String(e.message||e)});}
      }
      evidence.activeRootRawPrefix=found.join('');
      evidence.activeRootTruncated=truncated;
      evidence.chunkErrors=errors;
      evidence.chunkRanges=ranges;
      evidence.activeRootComplete=!truncated&&!errors.length&&visited===current.parts.length;
    }else evidence.notice+=' ACTIVEを解析できず本編チャンクを特定できません。';
    return JSON.stringify(evidence);
  }
  if(safeFastForward&&cleanIdb){
    try{
      // No concurrent SQLite edits: advance the pending IDB changes safely.
      await checkpoint(sqlSnapshot.validated.value,'IndexedDB自動復旧前のSQLite');
      await save(idbValid.value);
      if(mode!=='SQLite')throw Error('SQLiteへ同期できませんでした。');
      preferred=idbValid.value;
      notify('未同期IndexedDBデータをSQLiteへ安全に反映しました。');
    }catch(e){
      recoveryRequired=true;readOnly=true;
      notify('自動同期に失敗しました。保存元を手動で選択してください: '+e.message,true);
    }
  }
  return {
    initial:preferred,sqlInitial:sqlSnapshot?.validated.value||null,
    get readOnly(){return readOnly;},corrupt:sqliteCorrupt,
    get recoveryRequired(){return recoveryRequired;},get hasStorage(){return Boolean(sqlAvailable||idb);},
    mode:()=>mode,get problem(){return sqlProblem;},get backupWarning(){return backupWarning;},
    recoveryInfo:()=>({sqlite:sqlSnapshot?.validated.value?{title:sqlSnapshot.validated.value.title,chars:sqlSnapshot.validated.value.body.length,at:sqlSnapshot.validated.value.updatedAt,turns:sqlSnapshot.validated.value.turns.length}:null,idb:idbValid?.value?{title:idbValid.value.title,chars:idbValid.value.body.length,at:idbValid.value.updatedAt,turns:idbValid.value.turns.length}:null}),
    get canRebuildFromIdb(){return cleanIdb&&readOnly&&!recoveryRequired&&(sqliteCorrupt||rebuildPending);},
    save,checkpoint,checkpoints,checkpointList,loadCheckpoint,chooseRecovery,allowImportRecovery,rebuildFromIdb,rawDump,rawRowKeys,rawRowPage,materialize,compactState,
    flush:()=>new Promise((resolve,reject)=>{
      if(!working&&queued===null)return resolve();
      const wait=()=>{
        if(!working&&queued===null)resolve();
        else Promise.resolve().then(()=>setTimeout(wait,10));
      };wait();
    })
  };
}
