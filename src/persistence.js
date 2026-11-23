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
  let idb=null,fallback=null,sqlAvailable=false,sqlProblem='',rawEvidence=null;
  let sqlSnapshot=null,manifest=null,readOnly=false,recoveryRequired=false;
  let preferred=null,mode='保存不可',seq=0,checkpointCache=[];
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
      readOnly=true;sqlAvailable=false;
      notify('SQLiteの読み取りに失敗しました。上書き停止: '+sqlProblem);
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
  if(sqlProblem&&sqlProblem!=='SQLite API非対応（通常ブラウザ等）')readOnly=true;
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
        if(idb)await idb.put('latest',{...saved,rev:seq,pending:false}).catch(()=>notify('IndexedDBミラーの更新失敗。SQLiteへの保存は成功しています。'));
        notify('保存済み（Layla SQLite）');
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
  async function checkpoint(state){
    if(readOnly)throw Error('復旧中のため復元点を作成できません。');
    const snapshot=validator(state),raw=JSON.stringify(snapshot);
    const entry={at:Date.now(),data:raw,title:snapshot.title,chars:snapshot.body.length};
    if(sqlAvailable){
      const key='checkpoint/'+entry.at+'-'+Math.random().toString(36).slice(2);
      await run('INSERT INTO '+TABLE+' (k,v) VALUES (?,?)',[key,JSON.stringify(entry)]);
      const keys=sqlRows(await run('SELECT k FROM '+TABLE)).map(r=>r.k).filter(k=>k.startsWith('checkpoint/')).sort().reverse();
      for(const old of keys.slice(3))await run('DELETE FROM '+TABLE+' WHERE k=?',[old]);
      return;
    }
    if(idb){
      const list=(await idb.get('checkpoints'))||[];
      await idb.put('checkpoints',[entry,...list].slice(0,3));return;
    }
    throw Error('復元点を保存できません。');
  }
  async function checkpoints(){
    let all=[];
    if(sqlAvailable){
      const keys=sqlRows(await run('SELECT k FROM '+TABLE)).map(r=>r.k).filter(k=>k.startsWith('checkpoint/'));
      for(const k of keys){
        const data=sqlRows(await run('SELECT v FROM '+TABLE+' WHERE k=?',[k]))[0]?.v;
        try{all.push({id:k,...JSON.parse(data)});}catch{}
      }
      if(manifest?.previous){
        try{const prev=await readGeneration(manifest.previous);
          all.push({id:'previous',at:manifest.previous.at||0,data:JSON.stringify(prev),title:prev.title,chars:prev.body.length});}catch{}
      }
    }
    if(idb)try{
      const entries=await idb.get('checkpoints');
      for(const entry of entries||[])all.push({id:'idb/'+entry.at,...entry});
    }catch{}
    return all.sort((a,b)=>b.at-a.at).slice(0,5);
  }
  async function chooseRecovery(which){
    if(!recoveryRequired)throw Error('復旧元の選択は必要ありません。');
    const selected=which==='idb'?idbValid?.value:which==='sqlite'?sqlSnapshot?.validated.value:null;
    if(!selected)throw Error('復旧元が見つかりません。');
    readOnly=false;recoveryRequired=false;
    // Explicit decision: the selected state is NOT promoted until save() succeeds.
    await checkpoint(selected);
    await save(selected);
    return selected;
  }
  function allowImportRecovery(){
    if(recoveryRequired)throw Error('まずSQLite/IndexedDBの復旧元を選択してください。');
    // Only for explicit user-confirmed external JSON recovery.
    readOnly=false;
    if(!sqlAvailable&&idb)mode='IndexedDB（退避）';
    return true;
  }
  async function rawDump(){
    const evidence={schema:'layla-talking-story-recovery-raw',sqliteError:sqlProblem,rawManifest:rawEvidence,failedIdb:fallback};
    if(typeof sql==='function')try{evidence.rows=sqlRows(await run('SELECT k,v FROM '+TABLE));}catch(e){evidence.dumpError=String(e);}
    return JSON.stringify(evidence,null,2);
  }
  const hasStorage=Boolean(sqlAvailable||idb);
  return {
    initial:preferred,sqlInitial:sqlSnapshot?.validated.value||null,
    readOnly,corrupt:Boolean(sqlProblem&&sqlProblem!=='SQLite API非対応（通常ブラウザ等）'),
    recoveryRequired,hasStorage,mode:()=>mode,problem:sqlProblem,
    save,checkpoint,checkpoints,chooseRecovery,allowImportRecovery,rawDump,
    flush:()=>Promise.resolve()
  };
}
