// Layla SQLite is the primary store; IndexedDB is an outage fallback.
// Compatible with the legacy talking_story_data_v1 ACTIVE {version:1,parts,at} format.
// Immutable chunks -> single manifest switch; retain the previous generation.
// Never auto-overwrite healthy SQLite with unvalidated/different pending IDB data.
import {cleanState,checksum,compactBackup,expandCompactBackup,archiveReference,isArchiveReference} from './logic.js';
import {snapshot as branchSnapshot,MAX_ARCHIVED_BRANCHES,renameBranch} from './branches.js';

const TABLE='talking_story_data_v1',ACTIVE='active',DBNAME='talking-story-fallback-v1';
class ArchiveDamage extends Error {}
export class CheckpointArchiveUnreadable extends Error {}
// Limit synchronized archive copies, not authoritative SQLite or IDB-only saves.
// Previous-generation retention can temporarily double this archive budget.
export const MIRROR_ARCHIVE_LIMIT=2000000; // serialized UTF-16 code units
// Retry only storage reads; deterministic content validation is not retried.
async function retryRead(read){
  let error;
  for(let attempt=0;attempt<3;attempt++){
    try{return await read();}catch(e){error=e;if(e instanceof ArchiveDamage)throw e;}
  }
  throw error;
}
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
  let mirrorStatus='',mirrorFailureReported=false;
  // A session must never overwrite SQLite it failed to fully read on startup.
  let sqlInitialized=false,sqlRetryBlocked=false;
  const branchCache=new WeakMap();
  let rootCache=null,idbRootCache=null,idbLatest=null,sqlSavesSinceGc=9;
  const refData=new WeakMap(),storedRefs=new WeakMap(),archiveIssues=new WeakMap(),unknownSummaries=new WeakSet();
  const repairIds=new Set(),archiveChecks=new WeakMap(),pendingRenames=new WeakSet();
  const damagedEntries=new WeakSet(),protectedEntries=new WeakSet();
  // The app opts into lazy storage; legacy callers still receive full snapshots.
  const lazy=lazyArchives&&validator===cleanState;
  const meta=b=>({id:b.id,name:b.name,createdAt:b.createdAt,parentId:b.parentId,forkTurn:b.forkTurn,
    chars:b.body.length,turnCount:b.turns.length});
  const coreOf=state=>{
    const {draft,pendingCandidate,prefs,updatedAt,branches,...core}=state;
    return {core:{...core,branches:[]},overlay:{draft,pendingCandidate,prefs,updatedAt}};
  };
  // Stable independent root sections: changes in settings never shift body or history chunks.
  const sectionNames=['settings','body','turns','extras'];
  function coreSections(core){
    const {body,turns,undo,replyTrash,...settings}=core;
    return [settings,{body},{turns},{undo,replyTrash}];
  }
  function sectionChunks(core){
    return coreSections(core).map((section,i)=>splitChunks(
      (i===0?'{':',')+JSON.stringify(section).slice(1,-1)+(i===3?'}':'')));
  }
  function cachedSections(m,core,raw){
    if(!Array.isArray(m.rootSections)||m.rootSections.length!==4)return null;
    const groups=sectionChunks(core);
    if(groups.some((g,i)=>g.length!==m.rootSections[i])||
       groups.flat().join('')!==raw||groups.flat().length!==m.parts.length)return null;
    let offset=0;
    return groups.map(chunks=>{const keys=m.parts.slice(offset,offset+chunks.length);offset+=chunks.length;return {chunks,keys};});
  }
  const mirrorEntries=record=>record?.coreParts?[record.core,...record.coreParts]:record?.core?[record.core]:[];
  function checkOverlay(overlay,hash){
    if(hash!==undefined&&checksum(JSON.stringify(overlay))!==hash)
      throw Error('下書き・生成設定のチェックサムが一致しません。');
    return overlay||{};
  }
  function reference(b,source,entry,summary=null){
    let ref=isArchiveReference(b)?b:storedRefs.get(b);
    if(!ref){ref=archiveReference(summary||meta(b));storedRefs.set(b,ref);refData.set(ref,{});}
    const data=refData.get(ref);
    if(!data)throw Error('別の保存先の分岐参照です。');
    data[source]=entry;
    return ref;
  }
  const summaryOf=b=>isArchiveReference(b)?{id:b.id,name:b.name,createdAt:b.createdAt,parentId:b.parentId,forkTurn:b.forkTurn,chars:b.chars,turnCount:b.turnCount}:meta(b);
  function summaryEntry(entry,b){
    const summary=summaryOf(b);
    return {...entry,summary,summaryHash:checksum(JSON.stringify(summary))};
  }
  function checkedSummary(entry){
    const m=entry.summary;
    if(!m||m.id!==entry.id||typeof m.name!=='string'||!m.name.trim()||m.name.length>90||
      typeof m.createdAt!=='string'||!(m.parentId===null||typeof m.parentId==='string')||
      !(m.forkTurn===null||Number.isSafeInteger(m.forkTurn))||
      !Number.isSafeInteger(m.chars)||m.chars<0||!Number.isSafeInteger(m.turnCount)||m.turnCount<0||
      checksum(JSON.stringify(m))!==entry.summaryHash)throw new ArchiveDamage('分岐の要約情報が不正です。');
    if(entry.sourceName!==undefined&&(typeof entry.sourceName!=='string'||!entry.sourceName.trim()||entry.sourceName.length>90||
      entry.sourceNameHash!==checksum(JSON.stringify([entry.hash,entry.sourceName,m.name]))))
      throw new ArchiveDamage('分岐名変更情報が不正です。');
    if(entry.sourceName===undefined&&entry.sourceNameHash!==undefined)throw new ArchiveDamage('分岐名変更情報が欠落しています。');
    return m;
  }
  // Keep immutable original JSON. Validate original and effective metadata.
  function renamedEntry(entry,b){
    if(!entry.summary)return summaryEntry(entry,b);
    if(entry.summary.name===b.name)return entry;
    const old=checkedSummary(entry),sourceName=entry.sourceName??old.name;
    const next=summaryEntry(entry,b);
    if(sourceName===b.name){delete next.sourceName;delete next.sourceNameHash;}
    else{next.sourceName=sourceName;next.sourceNameHash=checksum(JSON.stringify([next.hash,sourceName,b.name]));}
    return next;
  }
  async function renameStoredBranch(state,id,name){
    const label=String(name||'').trim();
    if(!label||label.length>90)throw Error('分岐名は1〜90文字です。');
    const b=state.branches.find(x=>x.id===id);
    if(!isArchiveReference(b))return renameBranch(state,id,label);
    if(b.name===label)return state;
    const data=refData.get(b);
    if(!data||unknownSummaries.has(b)||archiveIssues.has(b))throw Error('分岐の整合性を確認してから名前を変更してください。');
    if(Object.values(data).some(e=>!e.summary))return renameBranch(await materialize(state,id),id,label);
    if(data.idb?.omitted&&!sqlAvailable)throw Error('SQLiteに接続してから名前を変更してください。');
    for(const e of Object.values(data))checkedSummary(e);
    const ref=archiveReference({...summaryOf(b),name:label});
    refData.set(ref,{...data});pendingRenames.add(ref);
    return cleanState({...state,branches:state.branches.map(x=>x===b?ref:x)});
  }
  function entryReference(entry,source,summary,error=null,unknown=false){
    const ref=archiveReference(summary);
    refData.set(ref,{[source]:entry});
    if(error){archiveIssues.set(ref,String(error.message||error));if(error instanceof ArchiveDamage)damagedEntries.add(entry);}
    if(unknown)unknownSummaries.add(ref);
    return ref;
  }
  async function decodeArchiveEntry(entry,source,refs,knownKeys=null){
    if(!entry||typeof entry.id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(entry.id))
      throw Error('分岐IDが不正です。');
    let summary=null;
    try{
      if(refs&&entry.summary!==undefined){
        summary=checkedSummary(entry);
        if(source==='sql'&&(!Array.isArray(entry.parts)||!entry.parts.length||entry.parts.length>1500||
          entry.parts.some(k=>typeof k!=='string'||(knownKeys&&!knownKeys.has(k)))))
          throw new ArchiveDamage('分岐チャンクが欠落しています。');
        if(source==='idb'&&entry.omitted===true&&entry.missing===true&&typeof entry.key!=='string')
          return entryReference(entry,source,summary);
        if(source==='idb'&&(entry.missing||typeof entry.key!=='string'))throw new ArchiveDamage('IndexedDBに分岐のミラーがありません。');
        return entryReference(entry,source,summary);
      }
      // Legacy manifests lack summaries: read once, then upgrade on next save.
      const full=await readEntry(entry,source);
      return refs?reference(full,source,entry):full;
    }catch(e){
      if(!refs)throw e;
      return entryReference(entry,source,summary||{id:entry.id,name:'読込不能の分岐 ('+entry.id+')',
        createdAt:'',parentId:null,forkTurn:null,chars:0,turnCount:0},e,!summary);
    }
  }
  async function readEntry(entry,source){
    if(source==='idb'&&(entry.missing||typeof entry.key!=='string'))throw new ArchiveDamage('IndexedDBに分岐のミラーがありません。');
    const raw=source==='idb'?await retryRead(()=>idb.get(entry.key)):await readParts(entry.parts,entry.hash,entry.size);
    try{
      const full=validatedArchive(checkedJson(raw,entry),entry.id);
      if(entry.sourceName===undefined){if(entry.sourceNameHash!==undefined)throw Error('分岐名変更情報が欠落しています。');return full;}
      const summary=checkedSummary(entry);
      if(JSON.stringify(meta(full))!==JSON.stringify({...summary,name:entry.sourceName}))throw Error('変更前の分岐要約が一致しません。');
      return validatedArchive({...full,name:summary.name},entry.id);
    }catch(e){throw new ArchiveDamage(String(e.message||e));}
  }
  async function verifySource(state,source,allowLinkedOmissions=false){
    for(const b of state.branches){
      if(!isArchiveReference(b))continue;
      const entry=refData.get(b)?.[source];
      if(!entry)throw Error('分岐の保存参照がありません。');
      const full=allowLinkedOmissions&&source==='idb'&&entry.omitted
        ?await readCheckedArchive(b,'sql'):await readEntry(entry,source);
      if(unknownSummaries.has(b)||JSON.stringify(meta(full))!==JSON.stringify(summaryOf(b)))
        throw Error('分岐の要約情報が一致しません。');
    }
  }
  function branchProblem(state){
    return state?.branches?.find(b=>archiveIssues.has(b));
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
    for(const type of ['sql','idb']){
      const entry=source[type];if(!entry||entry.omitted)continue;
      try{
        const full=await readCheckedArchive(b,type);
        if(!failure)archiveIssues.delete(b);
        else archiveIssues.set(b,'一方の保存先に問題があります。整合性チェックで確認してください。');
        return full;
      }catch(e){failure=e;}
    }
    const message='分岐「'+b.name+'」を読み込めません: '+(failure?.message||'保存先なし');
    const changed=archiveIssues.get(b)!==message;
    archiveIssues.set(b,message);
    if(changed)notify(message+'。本編の保存は継続できます。再試行または整合性チェックを行ってください。',true);
    throw Error(message);
  }
  async function readCheckedArchive(b,source){
    const entry=refData.get(b)?.[source];
    if(!entry)throw new ArchiveDamage('保存先に分岐がありません。');
    try{
      let full=await readEntry(entry,source);
      if(pendingRenames.has(b)&&entry.summary&&entry.summary.name!==b.name&&JSON.stringify(meta(full))===JSON.stringify(checkedSummary(entry)))
        full=validatedArchive({...full,name:b.name},entry.id);
      if(!unknownSummaries.has(b)&&JSON.stringify(meta(full))!==JSON.stringify(summaryOf(b)))
        throw new ArchiveDamage('分岐の要約情報が一致しません。');
      return full;
    }catch(e){if(e instanceof ArchiveDamage)damagedEntries.add(entry);throw e;}
  }
  // Check both copies independently, never treat fallback as proof of primary health.
  async function checkArchive(b){
    if(!isArchiveReference(b))return {id:b.id,sql:'unsaved',idb:'unsaved',repairable:false};
    const data=refData.get(b)||{},result={id:b.id};
    for(const type of ['sql','idb']){
      if(type==='sql'&&!sqlAvailable||type==='idb'&&!idb){result[type]='unavailable';continue;}
      if(type==='idb'&&data[type]?.omitted){result[type]='omitted';continue;}
      if(!data[type]||data[type].missing){result[type]='missing';continue;}
      try{await readCheckedArchive(b,type);result[type]='ok';}
      catch(e){result[type]=e instanceof ArchiveDamage?'damaged':'retry';result[type+'Error']=String(e.message||e);}
    }
    const bad=x=>x==='damaged'||x==='missing';
    result.repairable=(result.sql==='ok'&&bad(result.idb))||(result.idb==='ok'&&bad(result.sql));
    const failed=['sql','idb'].some(t=>result[t]==='damaged'||result[t]==='retry'||result[t]==='missing');
    archiveChecks.set(b,result);
    if(failed)archiveIssues.set(b,'整合性チェック: SQLite '+result.sql+' / IndexedDB '+result.idb);
    else archiveIssues.delete(b);
    return result;
  }
  // Durable evidence is written BEFORE removing or replacing a branch reference.
  async function protectSqlEntry(entry){
    if(protectedEntries.has(entry))return;
    if(!sqlAvailable||!sqlInitialized||sqlRetryBlocked)throw Error('SQLite原本を保護できません。再試行してください。');
    if(!Array.isArray(entry.parts)||!entry.parts.every(k=>typeof k==='string'))throw Error('分岐目録の保護に失敗しました。');
    const marker='corrupt-backup/v2-branch-'+Date.now()+'-'+Math.random().toString(36).slice(2);
    await run('INSERT INTO '+TABLE+' (k,v) VALUES (?,?)',[marker,JSON.stringify({version:1,parts:[],branchParts:[entry]})]);
    for(const key of entry.parts)
      await run('INSERT OR REPLACE INTO '+TABLE+' (k,v) VALUES (?,?)',['corrupt-keep/'+key,'1']);
    protectedEntries.add(entry);
  }
  async function protectIdbEntry(entry){
    if(protectedEntries.has(entry)||entry.missing)return;
    if(!idb)throw Error('IndexedDB原本を保護できません。');
    const raw=await retryRead(()=>idb.get(entry.key));
    await idb.put('corrupt-keep/branch/'+Date.now()+'-'+Math.random().toString(36).slice(2),{entry,raw});
    protectedEntries.add(entry);
  }
  async function protectArchive(b){
    const data=refData.get(b)||{};
    if(data.sql)await protectSqlEntry(data.sql);
    if(data.idb)await protectIdbEntry(data.idb);
  }
  async function isolateArchive(state,id){
    const b=state.branches.find(x=>x.id===id);
    if(!b||!isArchiveReference(b)||readOnly)throw Error('隔離できる分岐がありません。');
    await flushSaves();
    const check=await checkArchive(b);
    if(check.sql==='ok'||check.idb==='ok'||check.sql==='retry'||check.idb==='retry')
      throw Error('健全なコピーがあるか、一時的な読込エラーです。修復または再試行してください。');
    if(!archiveIssues.has(b)||!['sql','idb'].some(t=>check[t]==='damaged'||check[t]==='missing'))throw Error('破損を確認できません。');
    await protectArchive(b);
    const next={...state,branches:state.branches.filter(x=>x!==b)};
    await save(next);return compactState(next);
  }
  async function repairArchive(state,id){
    const b=state.branches.find(x=>x.id===id);
    if(!b||!isArchiveReference(b)||readOnly)throw Error('修復できる分岐がありません。');
    await flushSaves();
    const check=await checkArchive(b);
    if(!check.repairable)throw Error('検証済みの修復元がありません。');
    const full=await readCheckedArchive(b,check.sql==='ok'?'sql':'idb');
    await protectArchive(b);
    const next={...state,branches:state.branches.map(x=>x===b?full:x)};
    repairIds.add(id);
    try{await save(next);return compactState(next);}
    finally{repairIds.delete(id);}
  }
  async function flushSaves(){
    while(working||queued!==null)await new Promise(resolve=>setTimeout(resolve,10));
  }
  async function lastIntegrityCheckAt(){
    try{if(idb){const at=await idb.get('archive-check-at');if(Number.isFinite(at))return at;}}catch{}
    try{if(sqlAvailable){const rows=sqlRows(await retryRead(()=>run('SELECT v FROM '+TABLE+' WHERE k=?',['archive-check-at'])));return Number(rows[0]?.v)||0;}}catch{}
    return 0;
  }
  async function markIntegrityChecked(){
    const at=Date.now();let saved=false;
    if(idb)try{await idb.put('archive-check-at',at);saved=true;}catch{}
    if(sqlAvailable&&sqlInitialized&&!sqlRetryBlocked&&!readOnly)
      try{await run('INSERT OR REPLACE INTO '+TABLE+' (k,v) VALUES (?,?)',['archive-check-at',String(at)]);saved=true;}catch{}
    if(!saved)throw Error('整合性チェック日時を保存できません。');
    return at;
  }
  // Separate recovery record: never overwrite latest/ACTIVE on a root lock.
  async function stashActive(state){
    if(!idb)throw Error('IndexedDB退避先がありません。');
    const raw=JSON.stringify(cleanState({...state,branches:[]}));
    await idb.put('unsaved-active', {at:Date.now(),raw,hash:checksum(raw)});
  }
  async function readStashedActive(){
    if(!idb)return null;
    const record=await idb.get('unsaved-active');
    if(!record||typeof record.raw!=='string'||checksum(record.raw)!==record.hash)return null;
    return {at:record.at,state:cleanState(JSON.parse(record.raw))};
  }
  async function materialize(state,onlyId=null){
    const branches=[];
    for(const b of state.branches||[])branches.push(onlyId===null||b.id===onlyId?await readArchive(b):b);
    return {...state,branches};
  }
  function archiveSignature(state){
    return JSON.stringify({...state,branches:state.branches.map(b=>{
      if(isArchiveReference(b)){const e=refData.get(b)?.sql||refData.get(b)?.idb;return [b.id,e?.hash,e?.size,b.name];}
      const raw=JSON.stringify(b);return [b.id,checksum(raw),raw.length,b.name];
    })});
  }
  function linkMirrors(sqlState,idbState,allowPendingRename=false){
    if(!lazy||!sqlState||!idbState)return;
    for(const b of sqlState.branches){
      if(!isArchiveReference(b))continue;
      const other=idbState.branches.find(x=>x.id===b.id);
      if(!isArchiveReference(other))continue;
      const a=refData.get(b),c=refData.get(other);
      if(a?.sql&&c?.idb&&a.sql.hash===c.idb.hash&&a.sql.size===c.idb.size&&
        b.chars===other.chars&&b.turnCount===other.turnCount){
        if(b.name===other.name){a.idb=c.idb;c.sql=a.sql;}
        else if(allowPendingRename&&c.idb.omitted&&a.sql.summary&&c.idb.summary&&
          JSON.stringify({...checkedSummary(a.sql),name:other.name})===JSON.stringify(checkedSummary(c.idb))&&
          (a.sql.sourceName??b.name)===(c.idb.sourceName??other.name)){c.sql=a.sql;pendingRenames.add(other);}
      }
    }
  }
  async function readSplitIdb(record){
    const entries=mirrorEntries(record);
    if(record.coreParts!==undefined&&(!Array.isArray(record.coreParts)||entries.length!==4||
      entries.some((entry,i)=>entry?.section!==sectionNames[i])))
      throw Error('IndexedDBルート目録が不正です。');
    const raws=[],core={};
    for(const entry of entries){
      const raw=await idb.get(entry.key);
      const value=checkedJson(raw,entry);
      if(!value||typeof value!=='object'||Array.isArray(value))throw Error('IndexedDBルート部品が不正です。');
      for(const key of Object.keys(value)){
        if(Object.prototype.hasOwnProperty.call(core,key))throw Error('IndexedDBルート部品が重複しています。');
      }
      Object.assign(core,value);raws.push(raw);
    }
    if(!entries.length)throw Error('IndexedDBルート目録がありません。');
    if(!Array.isArray(record.archives)||record.archives.length>30)throw Error('IndexedDB分岐目録が不正です。');
    const branches=[];
    for(const entry of record.archives){
      branches.push(await decodeArchiveEntry(entry,'idb',lazy));
    }
    if(lazy)idbRootCache=entries.length===4?{entries,raws}:null;
    return {...core,...checkOverlay(record.state,record.overlayHash),branches};
  }
  async function writeMirror(saved){
    if(!lazy){await idb.put('latest',saved);return;}
    const {state,...header}=saved,{core,overlay}=coreOf(state);
    const raws=coreSections(core).map(section=>JSON.stringify(section));
    const generation='snapshot/'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2);
    const previous=idbLatest?.format===2?idbLatest:null;
    const previousKeys=previous?[...mirrorEntries(previous).map(e=>e.key),...previous.archives.map(e=>e.key).filter(k=>typeof k==='string')]:[];
    const eligible=new Set([...previousKeys,...(previous?.previousKeys||[])]);
    const created=[];
    const entries=[],archives=[];
    let archiveUnits=0;
    try{
      for(let i=0;i<raws.length;i++){
        const raw=raws[i],old=idbRootCache?.entries[i];
        if(old&&eligible.has(old.key)&&idbRootCache.raws[i]===raw){entries.push(old);continue;}
        const key=generation+'/root/'+sectionNames[i];
        entries.push({section:sectionNames[i],key,hash:checksum(raw),size:raw.length});
        created.push(key);await idb.put(key,raw);
      }
      for(const b of state.branches){
        const ref=isArchiveReference(b)?b:storedRefs.get(b);
        const existing=refData.get(ref)?.idb;
        let entry;
        const known=archiveChecks.get(ref),sqlEntry=refData.get(ref)?.sql,original=sqlEntry||existing;
        // Skip oversized SQL-backed archives before reading their bodies. Pending
        // saves still retain new/changed archives and reuse deliberate omissions.
        const omit=(!header.pending&&sqlEntry&&!repairIds.has(b.id)&&
          Number.isSafeInteger(sqlEntry.size)&&archiveUnits+sqlEntry.size>MIRROR_ARCHIVE_LIMIT&&
          !damagedEntries.has(sqlEntry)&&!archiveIssues.has(ref));
        if(omit)entry={id:b.id,missing:true,omitted:true,hash:sqlEntry.hash,size:sqlEntry.size};
        else if(header.pending&&existing?.omitted&&(!sqlEntry||(sqlEntry.hash===existing.hash&&sqlEntry.size===existing.size))&&!repairIds.has(b.id))entry=existing;
        else if(!repairIds.has(b.id)&&existing?.missing&&!existing.omitted&&known?.sql!=='ok')entry=existing;
        else if(!repairIds.has(b.id)&&!existing&&archiveIssues.has(ref)&&known?.sql!=='ok'&&original){
          entry={id:b.id,missing:true,hash:original.hash,size:original.size};
        }
        else if(existing&&!existing.missing&&eligible.has(existing.key)&&!repairIds.has(b.id))entry=existing;
        else{
          let full;
          try{full=await readArchive(b);}
          catch(e){
            // Explicit incomplete mirror. Never claim it is a complete recovery source.
            const original=refData.get(ref)?.sql||existing;
            if(!original)throw e;
            entry={id:b.id,missing:true,hash:original.hash,size:original.size};
          }
          if(full){
            const raw=JSON.stringify(full),key=generation+'/branch/'+b.id;
            if(!header.pending&&sqlEntry&&!repairIds.has(b.id)&&archiveUnits+raw.length>MIRROR_ARCHIVE_LIMIT&&!damagedEntries.has(sqlEntry)&&!archiveIssues.has(ref))
              entry={id:b.id,missing:true,omitted:true,hash:checksum(raw),size:raw.length};
            else{
              entry={id:b.id,key,hash:checksum(raw),size:raw.length};
              created.push(key);await idb.put(key,raw);
            }
          }
        }
        if(!entry.missing)archiveUnits+=entry.size||0;
        // Newly omitted copies inherit original name metadata from SQL.
        if(entry.omitted&&!entry.summary&&sqlEntry?.summary){
          entry={...entry,summary:sqlEntry.summary,summaryHash:sqlEntry.summaryHash,
            ...(sqlEntry.sourceName!==undefined?{sourceName:sqlEntry.sourceName,sourceNameHash:sqlEntry.sourceNameHash}:{})};
        }
        archives.push(entry.summary&&!archiveIssues.has(ref)?renamedEntry(entry,b):entry.summary?entry:summaryEntry(entry,b));
      }
      // A fallback open or rename may remove a bad source from the live directory.
      for(const entry of previous?.archives||[])
        if(damagedEntries.has(entry)&&!archives.includes(entry))await protectIdbEntry(entry);
      const record={...header,format:2,state:overlay,overlayHash:checksum(JSON.stringify(overlay)),core:entries[0],coreParts:entries.slice(1),archives,previousKeys,generation};
      // Manifest last: interrupted writes cannot replace the last valid snapshot.
      if(header.pending&&archives.some(e=>e.missing))await stashActive(state);
      await idb.put('latest',record);
      idbLatest=record;idbRootCache={entries,raws};
      const omitted=archives.filter(e=>e.omitted).length;
      mirrorStatus=omitted?'IndexedDBミラーは容量制限で分岐 '+omitted+' 件を省略しています。省略分岐はSQLite利用時のみ閲覧できます。':'';
      for(let i=0;i<state.branches.length;i++)reference(state.branches[i],'idb',archives[i]);
      const keep=new Set([...entries.map(e=>e.key),...archives.map(e=>e.key),...previousKeys]);
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
        // Branch-local damage is retained in its original directory; root remains writable.
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
  let idbValid=null,partialRebuild=null,rebuildOmitted=[],omissionConflict=false;
  if(idbReadError){idbValid={value:null,error:idbReadError};notify('IndexedDBの分割保存を検証できません: '+idbReadError.message,true);}
  else if(fallback?.state){
    idbValid=validate(fallback.state,validator);
    if(idbValid.error)notify('IndexedDBの退避データが不正です。SQLiteへ自動復旧しません: '+idbValid.error.message,true);
    else {
      // Pending mirrors may replace SQLite, and recovery mirrors may rebuild it.
      // Validate their own bytes before granting that authority, never via SQL fallback.
      try{
        const matchingBase=Boolean(fallback.pending&&sqlAvailable&&sqlSnapshot?.validated.value&&!sqlSnapshot.validated.error&&Number.isSafeInteger(fallback.baseRev)&&fallback.baseRev>0&&fallback.baseRev===sqlSnapshot.rev);
        if(matchingBase)linkMirrors(sqlSnapshot.validated.value,idbValid.value,true);
        if(branchProblem(idbValid.value)&&(sqliteCorrupt||(fallback.pending&&sqlAvailable)))throw Error('IndexedDB分岐の保存部品が不正です。');
        if(lazy&&sqliteCorrupt){
          // Only deliberate, validated omissions may be left out of explicit
          // reconstruction. Never relax verification for normal pending sync.
          const omitted=idbValid.value.branches.filter(b=>{
            const entry=refData.get(b)?.idb;
            return entry?.omitted===true&&entry.missing===true&&typeof entry.key!=='string';
          });
          if(omitted.length){
            const selected=validator({...idbValid.value,branches:idbValid.value.branches.filter(b=>!omitted.includes(b))});
            await verifySource(selected,'idb');
            partialRebuild=selected;rebuildOmitted=omitted.map(b=>refData.get(b).idb);
            // An incomplete mirror is NOT a complete synchronization source.
            idbValid.error=Error('容量制限で省略された分岐があります。');
            notify('本編と検証済み分岐の再作成が可能です。省略分岐 '+omitted.length+' 件は再作成せず、旧SQLite原本を保護します。',true);
          }else await verifySource(idbValid.value,'idb');
        }else if(lazy&&fallback.pending&&sqlAvailable)await verifySource(idbValid.value,'idb',matchingBase);
      }catch(e){idbValid.error=e;notify('IndexedDBの分岐を検証できません: '+e.message,true);}
      seq=Math.max(seq,Number(fallback.rev)||0);
    }
  }
  const omittedCount=idbLatest?.archives?.filter(e=>e.omitted).length||0;
  if(!idb)mirrorStatus='IndexedDBミラーなし。外部JSONバックアップを推奨します。';
  if(omittedCount)mirrorStatus='IndexedDBミラーは容量制限で分岐 '+omittedCount+' 件を省略しています。省略分岐はSQLite利用時のみ閲覧できます。';
  const cleanIdb=Boolean(idbValid?.value&&!idbValid.error);
  if(idb&&sqlSnapshot?.validated.value&&!sqlSnapshot.validated.error&&!fallback?.pending&&
    (!cleanIdb||Number(fallback?.rev)!==sqlSnapshot.rev)){
    mirrorStatus='IndexedDBミラーなし・未検証または古い可能性があります。SQLiteを使用中。外部JSONバックアップ推奨。';
  }
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
  if(sqliteCorrupt||(!sqlSnapshot?.validated.value&&idbValid?.error))readOnly=true;
  // An incomplete pending copy must never be silently replaced by a new
  // synchronized mirror after a conflicting SQLite revision.
  if(fallback?.pending&&omittedCount&&idbValid?.error&&sqlSnapshot?.validated.value){
    readOnly=true;
    if(sqlAvailable&&!sqlSnapshot.validated.error&&idbValid.value&&!idbValid.rescued){
      // Unknown base: no automatic merge. Link only byte-identical archives
      // for rescue; keep SQLite authoritative until explicit selection.
      omissionConflict=true;recoveryRequired=true;
      linkMirrors(sqlSnapshot.validated.value,idbValid.value);
      preferred=idbValid.value;
      mirrorStatus='省略分岐を含む未同期IndexedDBとSQLiteが衝突しています。SQLiteを採用するか保留してください。未同期本編は復元点へ退避します。';
    }else{
      if(idbValid.value)preferred=idbValid.value;
      mirrorStatus='未同期IndexedDBとSQLiteを安全に照合できません。上書きを停止しました。未保存編集の救出JSON・外部バックアップを利用してください。';
    }
    notify(mirrorStatus,true);
  }
  if(!sqlAvailable&&!idb)mode='保存不可';
  else if(sqlAvailable)mode='SQLite';
  else mode=idb?'IndexedDB（退避）':'保存不可';

  async function readParts(parts,expectedHash,expectedSize){
    if(!Array.isArray(parts)||parts.length>1500)throw new ArchiveDamage('保存部品数が不正です。');
    const chunks=[];
    for(const key of parts){
      const record=await retryRead(async()=>sqlRows(await run('SELECT v FROM '+TABLE+' WHERE k=?',[key])));
      if(typeof record[0]?.v!=='string')throw new ArchiveDamage('保存チャンク欠落: '+key);
      chunks.push(record[0].v);
    }
    const raw=chunks.join('');
    if(expectedHash&&checksum(raw)!==expectedHash)throw new ArchiveDamage('チェックサムが不一致');
    if(expectedSize!==undefined&&raw.length!==expectedSize)throw new ArchiveDamage('保存文字数が不一致');
    return raw;
  }
  async function decodeGeneration(m,refs=false){
    if(!m||!Array.isArray(m.parts))throw Error('保存世代の情報がありません。');
    const raw=await readParts(m.parts,m.hash,m.size),core=JSON.parse(raw);
    const root={...core,...checkOverlay(m.overlay,m.overlayHash)};
    // A fresh session can reuse unchanged root chunks too. This layout is
    // produced by splitChunks; legacy roots are migrated on the next save.
    if(refs&&m===manifest&&m.overlay){
      const sections=cachedSections(m,core,raw);
      if(sections)rootCache={manifest:m,sections};
    }
    // Old v1 manifest contains ALL branches inside root; new v1 stores immutable
    // archived branch blobs independently to avoid rewriting them on every edit.
    if(Array.isArray(m.branchParts)){
      if(m.branchParts.length>MAX_ARCHIVED_BRANCHES)throw Error('分岐目録が不正です。');
      const branches=[];
      // One key-only scan detects missing chunks without loading any branch body.
      const knownKeys=refs&&m.branchParts.some(b=>b?.summary!==undefined)?
        new Set((await retryRead(async()=>sqlRows(await run('SELECT k FROM '+TABLE)))).map(row=>row.k)):null;
      for(const b of m.branchParts)branches.push(await decodeArchiveEntry(b,'sql',refs,knownKeys));
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
    const groups=lazy?sectionChunks(core):[splitChunks(JSON.stringify(rootState))];
    const chunks=groups.flat(),rootJson=chunks.join('');
    if(chunks.length>1000)throw Error('SQLiteの容量上限（約4000万文字）を超えました。JSON保存を推奨します。');
    const keys=[],sections=[];
    for(let g=0;g<groups.length;g++){
      const group=groups[g],old=rootCache?.manifest===manifest?rootCache.sections?.[g]:null;
      const sectionKeys=[];
      for(let i=0;i<group.length;i++){
        // Exact equality within each section, even when preceding lengths change.
        if(old?.chunks[i]===group[i]&&old.keys[i]){sectionKeys.push(old.keys[i]);continue;}
        const key=generation+'/root/'+g+'/'+i;sectionKeys.push(key);
        await run('INSERT INTO '+TABLE+' (k,v) VALUES (?,?)',[key,group[i]]);
      }
      keys.push(...sectionKeys);sections.push({chunks:group,keys:sectionKeys});
    }
    const previousBranches=new Map((manifest?.branchParts||[]).map(b=>[b.id,b]));
    const branchParts=[];
    for(const b of state.branches||[]){
      const old=previousBranches.get(b.id);
      const ref=isArchiveReference(b)?b:storedRefs.get(b);
      if(old&&!repairIds.has(b.id)&&(branchCache.get(b)===old||refData.get(ref)?.sql===old)){branchParts.push(archiveIssues.has(b)?old:renamedEntry(old,b));continue;}
      const full=lazy?await readArchive(b):b;
      const json=JSON.stringify(full),hash=checksum(json);
      if(old&&!repairIds.has(b.id)&&!isArchiveReference(b)&&old.hash===hash&&old.size===json.length){
        const entry=renamedEntry(old,full);branchParts.push(entry);if(validator===cleanState)branchCache.set(b,entry);continue;
      }
      const parts=splitChunks(json),bkeys=[];
      for(let i=0;i<parts.length;i++){
        const key=generation+'/branch/'+b.id+'/'+i;bkeys.push(key);
        await run('INSERT INTO '+TABLE+' (k,v) VALUES (?,?)',[key,parts[i]]);
      }
      const entry=summaryEntry({id:b.id,parts:bkeys,hash,size:json.length},full);
      branchParts.push(entry);if(validator===cleanState)branchCache.set(b,entry);
    }
    for(const entry of previousBranches.values())
      if(damagedEntries.has(entry)&&!branchParts.includes(entry))await protectSqlEntry(entry);
    const previous=manifest?{
      version:1,parts:manifest.parts,at:manifest.at,
      ...(manifest.hash?{hash:manifest.hash}:{}),
      ...(manifest.size!==undefined?{size:manifest.size}:{}),
      ...(manifest.branchParts?{branchParts:manifest.branchParts}:{}),
      ...(manifest.rootSections?{rootSections:manifest.rootSections}:{}),
      ...(manifest.overlay?{overlay:manifest.overlay,...(manifest.overlayHash!==undefined?{overlayHash:manifest.overlayHash}:{})}:{}),
      rev:manifest.rev||0
    }:null;
    const next={version:1,parts:keys,branchParts,at:Date.now(),rev:++seq,
      hash:checksum(rootJson),size:rootJson.length,previous,
      ...(lazy?{rootSections:groups.map(g=>g.length),overlay,overlayHash:checksum(JSON.stringify(overlay))}:{})};
    await run('INSERT OR REPLACE INTO '+TABLE+' (k,v) VALUES (?,?)',[ACTIVE,JSON.stringify(next)]);
    manifest=next;rootCache={manifest:next,sections};rawEvidence=null;
    if(lazy)for(let i=0;i<state.branches.length;i++)reference(state.branches[i],'sql',branchParts[i]);
    // Retain active and previous immutable branches. GC only unreferenced
    // generations; never remove checkpoint chunks. Scan at most once per ten
    // successful saves (first save per session also reclaims abandoned rows).
    if(++sqlSavesSinceGc<10)return;
    sqlSavesSinceGc=0;
    try{
      const retain=new Set([ACTIVE,...keys,...(previous?.parts||[])]);
      for(const b of [...branchParts,...(previous?.branchParts||[])])for(const key of b.parts||[])retain.add(key);
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
    }catch(e){sqlSavesSinceGc=9;notify('保存世代の整理を次回へ延期しました: '+e.message,true);}
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
          // Validate the root and archive directory without loading every modern branch.
          // Old entries without summaries still need their original full validation.
          const checked=validate(await decodeGeneration(current,lazy),validator);
          if(checked.error)throw Error('SQLite保存部品を検証できません。自動上書きを禁止しました。');
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
        backupWarning='';
        if(mirrorFailed||!idb){
          mirrorStatus=mirrorFailed?'IndexedDBミラー更新失敗（古い可能性あり）。SQLiteは保存済み。外部JSONバックアップ推奨。':'IndexedDBミラーなし。SQLiteは保存済み。';
          if(mirrorFailed&&!mirrorFailureReported){mirrorFailureReported=true;notify(mirrorStatus,true);}
          else notify('保存済み（Layla SQLite）');
        }else{mirrorFailureReported=false;notify('保存済み（Layla SQLite）');}
        return;
      }catch(e){
        const message=String(e.message||e);
        if(message.includes('容量上限')){notify(message);throw e;}
        sqlAvailable=false;sqlProblem=message;nextSqlRetry=Date.now()+20000;
        notify('SQLite書込失敗（IndexedDBへ退避）: '+message,true);
      }
    }
    if(idb){
      await writeMirror({...saved,baseRev:sqlInitialized&&!sqlRetryBlocked?saved.baseRev:null,rev:++seq,pending:true});
      mode='IndexedDB（未同期退避）';
      backupWarning=idbLatest?.archives?.some(e=>e.missing)?'分岐のミラーが不完全です。未同期の本編は救出用領域にも保持しました。':'';
      notify(backupWarning||'IndexedDBへ退避しました。外部JSONバックアップも推奨します。',Boolean(backupWarning));
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
    if(readOnly||cleaningCorruption)return Promise.reject(Error('復旧確認・整理中のため上書き禁止です。'));
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
  const protectedReason=reason=>/^(import|reset)$|取込|読み込|新規作成|新しい作品|本文.*(削除|大幅)|省略衝突の未同期救出|復旧元|保存元/.test(reason||'');
  const automaticReason=reason=>/^(セッション開始時の自動復元点|日次自動復元点)$/.test(reason||'');
  const day=at=>new Date(at).toDateString();
  function retention(entries){
    const regular=entries.filter(e=>!protectedReason(e.reason)&&!automaticReason(e.reason));
    const important=entries.filter(e=>protectedReason(e.reason));
    const days=new Set(),automatic=[];
    for(const e of entries.filter(e=>automaticReason(e.reason))){
      const date=day(e.at);
      if(!days.has(date)&&automatic.length<3){days.add(date);automatic.push(e);}
    }
    return [...regular.slice(0,8),...important.slice(0,3),...automatic];
  }
  // The committed checkpoint metadata is the persistent daily timestamp.
  // Fail closed on metadata I/O errors instead of repeatedly creating backups.
  async function latestAutomaticCheckpointAt(){
    const entries=[];
    if(sqlAvailable)for(const {entry} of await sqlCheckpointParents())entries.push(entry);
    if(idb){
      const index=await idb.get('checkpoint-index');
      if(index!==null&&index!==undefined&&!Array.isArray(index))throw Error('復元点一覧の形式が不正です。');
      entries.push(...(index||[]));
    }
    const dates=entries.filter(e=>automaticReason(e.reason)&&Number.isFinite(Number(e.at))&&Number(e.at)>0).map(e=>Number(e.at));
    return dates.length?Math.max(...dates):null;
  }
  // Only suppress duplicate points after validating the actual stored body.
  async function hasMatchingAutomaticCheckpoint(state,now=Date.now()){
    try{
      const today=day(now);
      for(const entry of await checkpointList()){
        if(!automaticReason(entry.reason)||entry.scope!=='active'||day(entry.at)!==today||entry.chars!==state.body.length)continue;
        try{
          const restored=await loadCheckpoint(entry.id);
          if(restored.activeBranch.id===state.activeBranch.id&&restored.body.length===state.body.length&&
             checksum(restored.body)===checksum(state.body)&&restored.body===state.body)return true;
        }catch{/* create a normal point instead */}
      }
    }catch{/* create a normal point instead */}
    return false;
  }
  async function checkpoint(state,reason='操作前',{scope=lazy?'active':'full',branchId=null}={}){
    if(readOnly)throw Error('復旧中のため復元点を作成できません。');
    // Snapshot before waiting: the caller may continue editing the state.
    const snapshot=validator(state);
    // Replacing an entire work or resolving storage conflicts must preserve all
    // archives. Ordinary points preserve only the active branch.
    if(scope==='active'&&(/^(import|reset)$|復旧元|自動復旧前/.test(reason)))scope='full';
    let normalized,raw,format,fullArchives=null;
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
      if(lazy){
        // Whole-work replacement is rare but must keep every archived branch.
        // Store each immutable archive separately, deduplicated across full points.
        normalized=validator({...snapshot,branches:[]});
        fullArchives=snapshot.branches;raw=JSON.stringify(normalized);
        format='full-index-v1';
      }else{
        normalized=snapshot;
        const compact=Boolean(normalized.branches?.length);
        raw=compact?compactBackup(normalized):JSON.stringify(normalized);
        format=compact?'shared-prefix-v2':'v1';
      }
    }else throw Error('復元点の範囲が不正です。');
    const at=lastCheckpointAt=Math.max(Date.now(),lastCheckpointAt+1);
    const id='checkpoint/'+at.toString(36)+'-'+Math.random().toString(36).slice(2,8);
    const entry={id,at,title:normalized.title,chars:normalized.body.length,reason,
      format,scope,hash:checksum(raw),size:raw.length};
    // A concurrent checkpoint must never prune another's unfinished chunks.
    const task=checkpointTail.then(()=>writeCheckpoint(entry,raw,fullArchives));
    checkpointTail=task.catch(()=>{});
    return task;
  }
  async function checkpointArchive(b,storage,created){
    let full;
    try{full=await readArchive(b);}
    catch(e){
      throw new CheckpointArchiveUnreadable(String(e.message||e)+'。作品全体の復元点は作成できません。メイン画面の「ストーリー分岐」で読込不能の分岐を確認し、設定の「分岐の整合性チェック」を実行してください。健全なコピーがあれば修復、一時エラーなら再試行、両方とも読めない場合は「分岐を隔離（原本保持）」を行ってから再試行してください。');
    }
    const raw=JSON.stringify(full),hash=checksum(raw),size=raw.length;
    const base='checkpoint-archive/'+b.id+'/'+hash+'-'+size;
    // The checksum is not cryptographic: reuse only after exact content equality.
    for(let attempt=0;attempt<100;attempt++){
      const key=base+(attempt?'-'+attempt:'');
      if(storage==='sql'){
        const existing=sqlRows(await run('SELECT v FROM '+TABLE+' WHERE k=?',[key]))[0]?.v;
        if(typeof existing==='string'){
          try{const old=JSON.parse(existing);if(await readParts(old.parts,old.hash,old.size)===raw)return {id:b.id,key,...old};}catch{}
          continue;
        }
        const parts=splitChunks(raw),names=parts.map((_,i)=>key+'/part/'+i);
        for(let i=0;i<parts.length;i++)await run('INSERT OR REPLACE INTO '+TABLE+' (k,v) VALUES (?,?)',[names[i],parts[i]]);
        const descriptor={parts:names,hash,size};
        await run('INSERT INTO '+TABLE+' (k,v) VALUES (?,?)',[key,JSON.stringify(descriptor)]);
        return {id:b.id,key,...descriptor};
      }
      const existing=await idb.get(key);
      if(existing===raw)return {id:b.id,key,hash,size};
      if(existing!==null&&existing!==undefined)continue;
      await idb.put(key,raw);created.push(key);
      return {id:b.id,key,hash,size};
    }
    throw Error('復元点の分岐を安全に保存できません。');
  }
  async function fullCheckpointPayload(entry,raw,archives,storage,created=[]){
    if(archives===null)return {entry,raw};
    const archiveEntries=[];
    for(const b of archives)archiveEntries.push(await checkpointArchive(b,storage,created));
    // Keep the root payload and archive descriptors separate. The parent stores
    // keys for GC; their actual values are fetched only when selected.
    const payload=JSON.stringify({scope:'full-index',state:JSON.parse(raw),archives:archiveEntries});
    return {entry:{...entry,hash:checksum(payload),size:payload.length,
      archiveKeys:archiveEntries.map(a=>a.key)},raw:payload};
  }
  async function writeCheckpoint(entry,raw,fullArchives=null){
    if(readOnly)throw Error('復旧中のため復元点を作成できません。');
    const {id}=entry;
    let sqlFailure=null;
    if(sqlAvailable){
      try{
        const prepared=await fullCheckpointPayload(entry,raw,fullArchives,'sql');
        const parts=splitChunks(prepared.raw),names=[];
        if(parts.length>1200)throw Error('復元点のチャンクが多すぎます。');
        for(let i=0;i<parts.length;i++){
          const key=id+'/part/'+i;
          await run('INSERT INTO '+TABLE+' (k,v) VALUES (?,?)',[key,parts[i]]);
          names.push(key);
        }
        await run('INSERT INTO '+TABLE+' (k,v) VALUES (?,?)',[id,JSON.stringify({...prepared.entry,parts:names})]);
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
        // readArchive has already tried both storage sources. Do not let a
        // secondary checkpoint-storage failure mask the isolation guidance.
        if(e instanceof CheckpointArchiveUnreadable)throw e;
        notify('SQLite復元点の作成に失敗しました。IndexedDBへ退避を試します: '+e.message,true);
      }
    }
    if(idb){
      // Only index metadata is read to show the restore picker.
      const created=[];
      let prepared,list;
      try{
        list=(await idb.get('checkpoint-index'))||[];
        prepared=await fullCheckpointPayload(entry,raw,fullArchives,'idb',created);
        await idb.put('checkpoint-data/'+id,prepared.raw);
      }catch(e){
        for(const key of created)try{await idb.delete?.(key);}catch{}
        throw e;
      }
      const sorted=[prepared.entry,...list].sort((a,b)=>(Number(b.at)||0)-(Number(a.at)||0));
      const kept=retention(sorted),keepIds=new Set(kept.map(x=>x.id));
      try{await idb.put('checkpoint-index',kept);}
      catch(e){
        // If index publication was uncertain, retain the payload and archives.
        throw e;
      }
      for(const old of sorted.filter(x=>!keepIds.has(x.id)))if(typeof idb.delete==='function')
        try{await idb.delete('checkpoint-data/'+old.id);}catch(e){notify('古いIndexedDB復元点の清掃を延期します: '+e.message,true);}
      const retainedArchiveKeys=new Set(kept.flatMap(x=>x.archiveKeys||[]));
      for(const old of sorted.filter(x=>!keepIds.has(x.id)))for(const key of old.archiveKeys||[])
        if(!retainedArchiveKeys.has(key))try{await idb.delete?.(key);}catch{}
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
    const keptArchives=new Set(keep.flatMap(p=>p.entry.archiveKeys||[]));
    const keys=sqlRows(await run('SELECT k FROM '+TABLE)).map(r=>r.k);
    const readable=new Set(parents.map(p=>p.key));
    const unknown=new Set(keys.filter(k=>typeof k==='string'&&/^checkpoint\/[^/]+$/.test(k)&&!readable.has(k)));
    // Preserve parts of unreadable parent rows for forensic recovery. Remove
    // evicted parents first, so an interrupted GC never leaves a broken parent.
    for(const p of drop)await run('DELETE FROM '+TABLE+' WHERE k=?',[p.key]);
    for(const key of keys){
      if(typeof key!=='string')continue;
      if(key.startsWith('checkpoint-archive/')){
        const owner=key.includes('/part/')?key.slice(0,key.indexOf('/part/')):key;
        if(!unknown.size&&!keptArchives.has(owner))await run('DELETE FROM '+TABLE+' WHERE k=?',[key]);
        continue;
      }
      if(!key.startsWith('checkpoint/')||!key.includes('/part/'))continue;
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
        title:'直前の自動保存（短期救出用）',chars:null,reason:'直前の自動保存世代・操作前復元点とは別'});
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
    if(parsed.scope==='full-index'){
      if(!Array.isArray(parsed.archives)||parsed.archives.length>MAX_ARCHIVED_BRANCHES)throw Error('復元点の分岐目録が不正です。');
      const branches=[];
      for(const a of parsed.archives){
        const branchRaw=id.startsWith('idb/')?await idb.get(a.key):await readParts(a.parts,a.hash,a.size);
        branches.push(validatedArchive(checkedJson(branchRaw,a),a.id));
      }
      return validator({...parsed.state,branches});
    }
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
    if(omissionConflict&&which!=='sqlite')throw Error('省略分岐のある未同期IndexedDBは全体を採用できません。SQLiteを選択するか保留してください。');
    const selected=which==='idb'?(idbValid&&!idbValid.error?idbValid.value:null):which==='sqlite'?sqlSnapshot?.validated.value:null;
    if(!selected)throw Error('復旧元が見つかりません。');
    const wasReadOnly=readOnly,wasRequired=recoveryRequired;
    try{
      readOnly=false;
      // Retain both versions before switching; all steps must finish.
      const other=which==='idb'?sqlSnapshot?.validated.value:idbValid?.value;
      if(omissionConflict){
        // Preserve pending root and every readable archive; never silently
        // drop a damaged non-omitted archive to resolve this conflict.
        const branches=[];
        for(const b of other.branches){
          const entry=refData.get(b)?.idb;
          if(entry?.omitted&&entry.missing&&!refData.get(b)?.sql)continue;
          await readArchive(b);branches.push(b);
        }
        await checkpoint({...other,branches},'省略衝突の未同期救出（読込可能な分岐のみ）',{scope:'full'});
      }else if(other)await checkpoint(other,'選ばなかった復旧元',{scope:'full'});
      await checkpoint(selected,'復旧前に選択した保存元',{scope:'full'});
      nextSqlRetry=0; // An explicit user recovery always retries SQLite immediately.
      await save(selected);
      if(sqlSnapshot?.validated.value&&mode!=='SQLite')
        throw Error('SQLiteへの復旧書き込みが完了していません。再試行できます。');
      // Do not report a successful recovery while the previous pending mirror
      // remains authoritative on restart. Both sources were checkpointed above.
      // Retain the old record rather than deleting potentially recoverable data.
      if(idb){
        let latest;
        try{latest=await idb.get('latest');}
        catch(e){throw Error('SQLiteは保存済みですが未同期ミラーを確認できません。復元点は保持されています。再試行してください: '+String(e.message||e));}
        if(latest?.pending)
          throw Error('SQLiteは保存済みですが未同期ミラーの解消に失敗しました。救出復元点は保持されています。再試行してください。');
      }
      recoveryRequired=false;omissionConflict=false;
      return selected;
    }catch(e){
      readOnly=wasReadOnly;recoveryRequired=wasRequired;
      throw e;
    }
  }
  async function allowImportRecovery(){
    if(recoveryRequired)throw Error('まずSQLite/IndexedDBの復旧元を選択してください。');
    if(!sqlAvailable&&!idb&&!(sqliteCorrupt&&typeof sql==='function'))throw Error('保存先がありません。ファイルを読み込めません。既存の作品は変更していません。保存先を復旧してから再試行してください。');
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
    if((!cleanIdb&&!partialRebuild)||recoveryRequired||!readOnly||(!sqliteCorrupt&&!rebuildPending))throw Error('検証済みIndexedDBからの再作成は利用できません。');
    const selected=partialRebuild||idbValid.value;
    if(lazy)await verifySource(selected,'idb');
    rebuildPending=true;
    try{
      await allowImportRecovery();
      // allowImportRecovery has retained the old ACTIVE manifest and every
      // surviving generation row. Also retain the omitted mirror directory
      // separately, even if the old SQLite manifest was unreadable.
      if(rebuildOmitted.length){
        await run('INSERT INTO '+TABLE+' (k,v) VALUES (?,?)',[
          'corrupt-backup/v2-idb-omitted-'+Date.now()+'-'+Math.random().toString(36).slice(2),
          JSON.stringify({version:1,parts:[],omittedArchives:rebuildOmitted})
        ]);
      }
      nextSqlRetry=0;
      await save(selected);
      if(mode!=='SQLite')throw Error('SQLiteへの書き込みを確認できません。');
      rebuildPending=false;return selected;
    }catch(e){
      // A failed SQL write may have cleared sqliteCorrupt and manifest while the
      // old ACTIVE still exists. Explicit retry must protect it again, not use
      // blind auto-reconnect. Keep read-only until a verified SQLite write succeeds.
      readOnly=true;rebuildPending=true;sqliteCorrupt=true;sqlAvailable=false;
      throw e;
    }
  }
  // Only explicit, verified recovery cleanup may release old corruption evidence.
  let cleaningCorruption=false;
  async function corruptionEvidence(){
    if(typeof sql!=='function')throw Error('SQLite APIを利用できません。');
    const keys=sqlRows(await run('SELECT k FROM '+TABLE)).map(r=>r.k).filter(k=>typeof k==='string');
    return {keys,markers:keys.filter(k=>k.startsWith('corrupt-keep/')),
      backups:keys.filter(k=>k.startsWith('corrupt-backup/')).sort().reverse()};
  }
  async function purgeCorruptEvidence(){
    if(cleaningCorruption||working||queued!==null||readOnly||recoveryRequired||sqliteCorrupt||
       !sqlAvailable||!sqlInitialized||sqlRetryBlocked||mode!=='SQLite'||!manifest)
      throw Error('正常なSQLiteへの復旧・保存完了後に実行してください。');
    cleaningCorruption=true;
    try{
      const rows=await readActiveRows(),current=JSON.parse(rows[0]?.v||'null');
      if(!current||JSON.stringify(current)!==JSON.stringify(manifest))throw Error('現在の保存世代が変化しました。');
      // Validate every active archive before deleting anything. Preserve the previous
      // manifest and all its root/branch keys even if it shares old chunks.
      await readGeneration(current);
      const retain=new Set();
      for(const m of [current,current.previous])if(m){
        if(!Array.isArray(m.parts)||!m.parts.every(k=>typeof k==='string')||
           (m.branchParts!==undefined&&!Array.isArray(m.branchParts)))
          throw Error('保存目録が不正です。削除を中止します。');
        for(const k of m.parts)retain.add(k);
        for(const b of m.branchParts||[]){
          if(!Array.isArray(b.parts)||!b.parts.every(k=>typeof k==='string'))throw Error('分岐目録が不正です。');
          for(const k of b.parts)retain.add(k);
        }
      }
      const {keys,markers,backups}=await corruptionEvidence();
      // Also release legacy backups without per-row protection markers, but never
      // touch checkpoint or arbitrary keys. Delete evidence manifests last.
      const known=new Set(keys),targets=new Set();
      for(const marker of markers)targets.add(marker.slice('corrupt-keep/'.length));
      for(const backup of backups){
        try{
          const old=JSON.parse(sqlRows(await run('SELECT v FROM '+TABLE+' WHERE k=?',[backup]))[0]?.v);
          for(const m of [old,old?.previous])if(m){
            for(const k of Array.isArray(m.parts)?m.parts:[])targets.add(k);
            for(const b of Array.isArray(m.branchParts)?m.branchParts:[])
              for(const k of Array.isArray(b.parts)?b.parts:[])targets.add(k);
          }
        }catch{/* An unparseable backup is represented by the durable markers. */}
      }
      let removed=0;
      for(const k of targets)if(typeof k==='string'&&k.startsWith('g')&&known.has(k)&&!retain.has(k)){
        await run('DELETE FROM '+TABLE+' WHERE k=?',[k]);removed++;
      }
      for(const k of backups)await run('DELETE FROM '+TABLE+' WHERE k=?',[k]);
      for(const k of markers)await run('DELETE FROM '+TABLE+' WHERE k=?',[k]);
      return {removed,markers:markers.length,backups:backups.length};
    }finally{cleaningCorruption=false;}
  }
  async function rawBodySources(){
    const {keys,backups}=await corruptionEvidence();
    return [...(keys.includes(ACTIVE)?[ACTIVE]:[]),...backups];
  }
  async function rawBodyText(source=ACTIVE){
    if(!(await rawBodySources()).includes(source))throw Error('救出元がありません。');
    const value=sqlRows(await run('SELECT v FROM '+TABLE+' WHERE k=?',[source]))[0]?.v;
    let m;try{m=JSON.parse(value);}catch{throw Error('目録が破損しています。行単位救出をご利用ください。');}
    if(!Array.isArray(m?.parts)||m.parts.length>1500)throw Error('本編目録が不正です。');
    // Current section layout can recover body independently of settings and history.
    let parts=m.parts,section=false;
    if(Array.isArray(m.rootSections)&&m.rootSections.length===4&&
       m.rootSections.every(n=>Number.isSafeInteger(n)&&n>0)&&m.rootSections.reduce((a,b)=>a+b,0)===parts.length){
      parts=parts.slice(m.rootSections[0],m.rootSections[0]+m.rootSections[1]);section=true;
    }
    const chunks=[];
    for(const key of parts){
      try{
        if(typeof key!=='string')throw Error('invalid key');
        const v=sqlRows(await run('SELECT v FROM '+TABLE+' WHERE k=?',[key]))[0]?.v;
        chunks.push(typeof v==='string'?v:null);
      }catch{chunks.push(null);}
    }
    if(!chunks.includes(null)){
      try{
        const raw=chunks.join('');
        const body=JSON.parse(section?'{'+raw.slice(1)+'}':raw).body;
        if(typeof body==='string')return {text:body,partial:false};
      }catch{/* fall through to explicitly labelled partial fragments */}
    }
    if(!section)throw Error('旧形式の本編を安全に識別できません。行単位救出をご利用ください。');
    // Never silently concatenate across missing chunks. Decode each contiguous
    // JSON string fragment when possible; keep undecodable escapes as raw evidence.
    let text='',runText='',runStart=0,missing=0;
    const flush=end=>{
      if(!runText)return;
      let fragment=runText;
      if(runStart===0)fragment=fragment.replace(/^,"body":"/,'');
      if(end===chunks.length)fragment=fragment.replace(/"$/,'');
      try{text+=JSON.parse('"'+fragment+'"');}
      catch{text+='\n【JSON断片・エスケープ未復号】\n'+fragment+'\n【断片終端】\n';}
      runText='';
    };
    for(let i=0;i<chunks.length;i++){
      if(chunks[i]===null){flush(i);missing++;text+='\n【欠落チャンク '+(i+1)+'】\n';}
      else{if(!runText)runStart=i;runText+=chunks[i];}
    }
    flush(chunks.length);
    if(missing===chunks.length)throw Error('読める本編チャンクがありません。');
    return {text:'【部分救出・原文の完全性は未確認】\n'+text,partial:true};
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
      await checkpoint(sqlSnapshot.validated.value,'IndexedDB自動復旧前のSQLite',{scope:'full'});
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
    get readOnly(){return readOnly;},get corrupt(){return sqliteCorrupt;},
    archiveIssue:b=>archiveIssues.get(b)||'',
    checkArchive,repairArchive,isolateArchive,lastIntegrityCheckAt,markIntegrityChecked,stashActive,readStashedActive,
    get recoveryRequired(){return recoveryRequired;},get hasStorage(){return Boolean(sqlAvailable||idb);},
    mode:()=>mode,get problem(){return sqlProblem;},get backupWarning(){return backupWarning;},get mirrorStatus(){return mirrorStatus;},
    recoveryInfo:()=>({omissionConflict,omittedCount,sqlite:sqlSnapshot?.validated.value?{title:sqlSnapshot.validated.value.title,chars:sqlSnapshot.validated.value.body.length,at:sqlSnapshot.validated.value.updatedAt,turns:sqlSnapshot.validated.value.turns.length}:null,idb:idbValid?.value?{title:idbValid.value.title,chars:idbValid.value.body.length,at:idbValid.value.updatedAt,turns:idbValid.value.turns.length}:null}),
    get canRebuildFromIdb(){return Boolean(cleanIdb||partialRebuild)&&readOnly&&!recoveryRequired&&(sqliteCorrupt||rebuildPending);},
    get rebuildOmittedCount(){return rebuildOmitted.length;},
    save,checkpoint,checkpoints,checkpointList,latestAutomaticCheckpointAt,hasMatchingAutomaticCheckpoint,renameStoredBranch,loadCheckpoint,chooseRecovery,allowImportRecovery,rebuildFromIdb,rawDump,rawRowKeys,rawRowPage,rawBodySources,rawBodyText,purgeCorruptEvidence,materialize,compactState,
    flush:()=>new Promise((resolve,reject)=>{
      if(!working&&queued===null)return resolve();
      const wait=()=>{
        if(!working&&queued===null)resolve();
        else Promise.resolve().then(()=>setTimeout(wait,10));
      };wait();
    })
  };
}
