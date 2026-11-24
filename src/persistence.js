// Layla SQLite is the primary store; IndexedDB is an outage fallback.
// Compatible with the legacy talking_story_data_v1 ACTIVE {version:1,parts,at} format.
// Immutable chunks -> single manifest switch; retain the previous generation.
// Never auto-overwrite healthy SQLite with unvalidated/different pending IDB data.
import {cleanState} from './logic.js';

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
export function checksum(src){
  let h=2166136261;
  for(let i=0;i<src.length;i++)h=Math.imul((h^src.charCodeAt(i)),16777619);
  return (h>>>0).toString(16);
}
export function sqlRows(result){
  const rows=result?.rows;
  if(Array.isArray(rows))return rows;
  if(rows&&typeof rows.item==='function'&&typeof rows.length==='number')
    return Array.from({length:rows.length},(_,i)=>rows.item(i));
  if(rows&&typeof rows.length==='number')return Array.from(rows);
  return [];
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
        put(key,val){return new Promise((ok,no)=>{const t=db.transaction('snapshots','readwrite');t.objectStore('snapshots').put(val,key);t.oncomplete=ok;t.onerror=()=>no(t.error);t.onabort=()=>no(t.error);});}
      });
    };
    req.onerror=()=>reject(req.error);
  });
}
function validate(raw,validator){
  try{return {value:validator(raw),error:null};}catch(e){return {value:null,error:e};}
}
export async function openStore(host,notify=()=>{},{idbFactory=browserIdb,validator=cleanState}={}){
  let idb=null,fallback=null,sqlAvailable=false,sqlProblem='',rawEvidence=null,sqliteCorrupt=false;
  let sqlSnapshot=null,manifest=null,readOnly=false,recoveryRequired=false;
  let preferred=null,mode='保存不可',seq=0,backupWarning='';
  const sql=host?.db?.executeSql;
  const run=async(q,args=[])=>host.db.executeSql(q,args);
  try{idb=await idbFactory();fallback=await idb.get('latest');}
  catch(e){notify('IndexedDBを利用できません: '+String(e.message||e));}
  if(typeof sql!=='function'){sqlProblem='SQLite API非対応（通常ブラウザ等）';}
  else{
    try{
      await run('CREATE TABLE IF NOT EXISTS '+TABLE+' (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
      sqlAvailable=true;
      const rows=sqlRows(await run('SELECT v FROM '+TABLE+' WHERE k=?',[ACTIVE]));
      if(rows.length){
        rawEvidence=rows[0].v;
        manifest=JSON.parse(String(rawEvidence));
        if(manifest.version!==1||!Array.isArray(manifest.parts)||manifest.parts.length>1200)
          throw Error('ACTIVEマニフェストの形式が不正');
        let raw='';
        for(const key of manifest.parts){
          const part=sqlRows(await run('SELECT v FROM '+TABLE+' WHERE k=?',[key]));
          if(typeof part[0]?.v!=='string')throw Error('保存チャンク欠落: '+key);
          raw+=part[0].v;
        }
        if(manifest.hash&&checksum(raw)!==manifest.hash)throw Error('チェックサムが不一致');
        if(manifest.size!==undefined&&manifest.size!==raw.length)throw Error('保存文字数が不一致');
        const loaded=JSON.parse(raw);
        sqlSnapshot={state:loaded,validated:validate(loaded,validator),raw,rev:Number(manifest.rev)||0};
        seq=Math.max(seq,sqlSnapshot.rev);
        if(sqlSnapshot.validated.error)throw Error('SQLite保存内容の検証失敗: '+sqlSnapshot.validated.error.message);
        rawEvidence=null;
      }
    }catch(e){
      sqlProblem=String(e.message||e);
      // If the API/table itself fails before a manifest is read, this can be
      // transient unavailability, NOT corrupted saved data. Allow IDB fallback.
      sqliteCorrupt=rawEvidence!==null||manifest!==null;
      readOnly=sqliteCorrupt;sqlAvailable=false;
      notify(sqliteCorrupt?'SQLite保存を検証できません。上書きを停止しました: '+sqlProblem:'SQLiteを一時的に利用できません。IndexedDBへ退避を試します: '+sqlProblem);
    }
  }
  let idbValid=null;
  if(fallback?.state){
    idbValid=validate(fallback.state,validator);
    if(idbValid.error)notify('IndexedDBの退避データが不正です。SQLiteへ自動復旧しません: '+idbValid.error.message);
    else seq=Math.max(seq,Number(fallback.rev)||0);
  }
  const different=Boolean(idbValid?.value&&sqlSnapshot?.validated.value&&
    JSON.stringify(idbValid.value)!==JSON.stringify(sqlSnapshot.validated.value));
  if(fallback?.pending&&idbValid?.value&&different&&sqlAvailable){
    recoveryRequired=true;readOnly=true;
    preferred=idbValid.value; // Display but do NOT write until explicit choice.
    notify('SQLiteとIndexedDBの未同期編集が異なります。復旧元を選ぶまで保存を停止します。');
  }else if(sqlSnapshot?.validated.value){
    preferred=sqlSnapshot.validated.value;
  }else if(idbValid?.value){
    preferred=idbValid.value;
  }else if(fallback?.state&&idbValid?.error&&!sqlSnapshot){
    readOnly=true;
  }
  if(sqliteCorrupt)readOnly=true;
  if(!sqlAvailable&&!idb)mode='保存不可';
  else if(sqlAvailable)mode='SQLite';
  else mode=idb?'IndexedDB（退避）':'保存不可';

  async function readGeneration(m){
    if(!m||!Array.isArray(m.parts))throw Error('保存世代の情報がありません。');
    let raw='';
    for(const key of m.parts){
      const rows=sqlRows(await run('SELECT v FROM '+TABLE+' WHERE k=?',[key]));
      if(typeof rows[0]?.v!=='string')throw Error('世代の保存チャンクがありません。');
      raw+=rows[0].v;
    }
    if(m.hash&&checksum(raw)!==m.hash)throw Error('世代チェックサムエラー');
    return validator(JSON.parse(raw));
  }
  async function writeSql(raw){
    const chunks=splitChunks(raw);
    if(chunks.length>1000)throw Error('SQLiteの容量上限（約4000万文字）を超えました。JSON保存を推奨します。');
    const generation='g'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
    const keys=[];
    for(let i=0;i<chunks.length;i++){
      const key=generation+'/'+i;keys.push(key);
      await run('INSERT INTO '+TABLE+' (k,v) VALUES (?,?)',[key,chunks[i]]);
    }
    const previous=manifest?{
      version:1,parts:manifest.parts,at:manifest.at,
      ...(manifest.hash?{hash:manifest.hash}:{}),
      ...(manifest.size!==undefined?{size:manifest.size}:{}),rev:manifest.rev||0
    }:null;
    const next={version:1,parts:keys,at:Date.now(),rev:++seq,hash:checksum(raw),size:raw.length,previous};
    await run('INSERT OR REPLACE INTO '+TABLE+' (k,v) VALUES (?,?)',[ACTIVE,JSON.stringify(next)]);
    manifest=next;rawEvidence=null;
    // Retain the previous snapshot and cleanup orphan chunks after commit.
    try{
      const keep=new Set([ACTIVE,...keys,...(previous?.parts||[])]);
      const all=sqlRows(await run('SELECT k FROM '+TABLE));
      for(const row of all){
        const key=row.k;
        if(typeof key==='string'&&key.startsWith('g')&&!keep.has(key))
          await run('DELETE FROM '+TABLE+' WHERE k=?',[key]);
      }
    }catch(e){notify('古い保存チャンクの整理を次回へ延期しました。');}
  }
  async function commit(raw){
    if(readOnly)throw Error('読み取り専用です。復旧元を確認するかJSONバックアップを利用してください。');
    const state=validator(JSON.parse(raw));
    const saved={state,rev:seq+1,at:Date.now(),pending:true};
    if(sqlAvailable){
      try{
        await writeSql(raw);
        mode='SQLite';
        let mirrorFailed=false;
        if(idb)await idb.put('latest',{...saved,rev:seq,pending:false}).catch(()=>{mirrorFailed=true;});
        backupWarning=mirrorFailed?'SQLite保存済み。ただしIndexedDBミラー更新失敗。外部JSONバックアップ推奨。':'';
        notify(backupWarning||'保存済み（Layla SQLite）',mirrorFailed);
        return;
      }catch(e){
        const message=String(e.message||e);
        if(message.includes('容量上限')){notify(message);throw e;}
        sqlAvailable=false;sqlProblem=message;
        notify('SQLite書込失敗（IndexedDBへ退避）: '+message);
      }
    }
    if(idb){
      await idb.put('latest',{...saved,rev:++seq,pending:true});
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
    let raw;try{raw=JSON.stringify(state);}catch(e){return Promise.reject(e);}
    return new Promise((resolve,reject)=>{
      queued=raw;waiters.push({resolve,reject});
      if(!working)void processQueue();
    });
  }
  // Preserve old single-row checkpoint records; new checkpoints use chunks.
  async function checkpoint(state,reason='操作前'){
    if(readOnly)throw Error('復旧中のため復元点を作成できません。');
    const normalized=validator(state),raw=JSON.stringify(normalized);
    const id='checkpoint/'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);
    const entry={at:Date.now(),title:normalized.title,chars:normalized.body.length,reason,
      hash:checksum(raw),size:raw.length};
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
        await pruneSqlCheckpoints();
        return;
      }catch(e){
        sqlFailure=e;
        notify('SQLite復元点の作成に失敗しました。IndexedDBへの退避を試します: '+e.message,true);
      }
    }
    if(idb){
      const list=(await idb.get('checkpoints'))||[];
      await idb.put('checkpoints',[{...entry,data:raw},...list].slice(0,8));
      return;
    }
    throw sqlFailure||Error('復元点を保存できません。');
  }
  async function pruneSqlCheckpoints(){
    const keys=sqlRows(await run('SELECT k FROM '+TABLE)).map(r=>r.k)
      .filter(k=>typeof k==='string'&&/^checkpoint\/[^/]+$/.test(k)).sort().reverse();
    // 8 safety checkpoints: avoid rapidly evicting a reset/import/deletion recovery.
    for(const old of keys.slice(8)){
      let info=null;
      try{
        const raw=sqlRows(await run('SELECT v FROM '+TABLE+' WHERE k=?',[old]))[0]?.v;
        info=JSON.parse(raw);
      }catch{}
      if(info?.parts)for(const part of info.parts)await run('DELETE FROM '+TABLE+' WHERE k=?',[part]);
      await run('DELETE FROM '+TABLE+' WHERE k=?',[old]);
    }
  }
  async function checkpoints(){
    const all=[];
    if(sqlAvailable){
      const keys=sqlRows(await run('SELECT k FROM '+TABLE)).map(r=>r.k)
        .filter(k=>typeof k==='string'&&/^checkpoint\/[^/]+$/.test(k));
      for(const k of keys){
        try{
          const raw=sqlRows(await run('SELECT v FROM '+TABLE+' WHERE k=?',[k]))[0]?.v;
          const entry=JSON.parse(raw);
          let data=entry.data;
          if(!data&&Array.isArray(entry.parts)){
            const chunks=[];
            for(const key of entry.parts){
              const part=sqlRows(await run('SELECT v FROM '+TABLE+' WHERE k=?',[key]))[0]?.v;
              if(typeof part!=='string')throw Error('復元点チャンク欠落');
              chunks.push(part);
            }
            data=chunks.join('');
          }
          if(typeof data!=='string')continue;
          if(entry.hash&&checksum(data)!==entry.hash)throw Error('復元点の検証失敗');
          all.push({id:k,...entry,data,reason:entry.reason||'旧復元点'});
        }catch(e){notify('一部の復元点を検証できません: '+e.message,true);}
      }
      if(manifest?.previous){
        try{
          const prev=await readGeneration(manifest.previous);
          all.push({id:'previous',at:manifest.previous.at||0,data:JSON.stringify(prev),
            title:prev.title,chars:prev.body.length,reason:'直前の保存世代'});
        }catch{}
      }
    }
    if(idb)try{
      const entries=await idb.get('checkpoints');
      for(const entry of entries||[]){
        if(typeof entry.data==='string'&&(!entry.hash||checksum(entry.data)===entry.hash))
          all.push({id:'idb/'+entry.at,...entry,reason:entry.reason||'IndexedDB復元点'});
      }
    }catch{}
    return all.sort((a,b)=>b.at-a.at).slice(0,12);
  }
  async function chooseRecovery(which){
    if(!recoveryRequired)throw Error('復旧元の選択は必要ありません。');
    const selected=which==='idb'?idbValid?.value:which==='sqlite'?sqlSnapshot?.validated.value:null;
    if(!selected)throw Error('復旧元が見つかりません。');
    const wasReadOnly=readOnly,wasRequired=recoveryRequired;
    try{
      readOnly=false;
      // Retain both versions before switching; all steps must finish.
      const other=which==='idb'?sqlSnapshot?.validated.value:idbValid?.value;
      if(other)await checkpoint(other,'選ばなかった復旧元');
      await checkpoint(selected,'復旧前に選択した保存元');
      await save(selected);
      recoveryRequired=false;
      return selected;
    }catch(e){
      readOnly=wasReadOnly;recoveryRequired=wasRequired;
      throw e;
    }
  }
  function allowImportRecovery(){
    if(recoveryRequired)throw Error('まずSQLite/IndexedDBの復旧元を選択してください。');
    // Only for explicit user-confirmed external JSON recovery.
    if(!sqlAvailable&&!idb)throw Error('保存先がありません。JSONは閲覧できますが端末へ保存できません。');
    readOnly=false;
    if(!sqlAvailable&&idb)mode='IndexedDB（退避）';
    return true;
  }
  async function rawDump(){
    const evidence={schema:'layla-talking-story-recovery-raw',sqliteError:sqlProblem,rawManifest:rawEvidence,failedIdb:fallback,
      activeManifest:manifest,notice:'巨大なSQLite全行を読み込むとアプリが停止するため、生ダンプはマニフェストと障害情報のみを含みます。'};
    return JSON.stringify(evidence);
  }
  const hasStorage=Boolean(sqlAvailable||idb);
  return {
    initial:preferred,sqlInitial:sqlSnapshot?.validated.value||null,
    get readOnly(){return readOnly;},corrupt:sqliteCorrupt,
    get recoveryRequired(){return recoveryRequired;},get hasStorage(){return Boolean(sqlAvailable||idb);},
    mode:()=>mode,get problem(){return sqlProblem;},get backupWarning(){return backupWarning;},
    recoveryInfo:()=>({sqlite:sqlSnapshot?.validated.value?{title:sqlSnapshot.validated.value.title,chars:sqlSnapshot.validated.value.body.length,at:sqlSnapshot.validated.value.updatedAt,turns:sqlSnapshot.validated.value.turns.length}:null,idb:idbValid?.value?{title:idbValid.value.title,chars:idbValid.value.body.length,at:idbValid.value.updatedAt,turns:idbValid.value.turns.length}:null}),
    save,checkpoint,checkpoints,chooseRecovery,allowImportRecovery,rawDump,
    flush:()=>new Promise((resolve,reject)=>{
      if(!working&&queued===null)return resolve();
      const wait=()=>{
        if(!working&&queued===null)resolve();
        else Promise.resolve().then(()=>setTimeout(wait,10));
      };wait();
    })
  };
}
