// Layla SQLite is primary. Save immutable chunks and atomically switch manifest.
// IndexedDB keeps edits made while SQLite was unavailable.
const TABLE='talking_story_data_v1', ACTIVE='active', IDB='talking-story-fallback-v1';
function openIdb(){return new Promise((ok,fail)=>{
  if(typeof indexedDB==='undefined')return fail(Error('IndexedDB unavailable'));
  const req=indexedDB.open(IDB,1);req.onupgradeneeded=()=>req.result.createObjectStore('snapshots');
  req.onsuccess=()=>ok(req.result);req.onerror=()=>fail(req.error);
});}
function idbRead(db){return new Promise((ok,fail)=>{
  const req=db.transaction('snapshots','readonly').objectStore('snapshots').get('latest');
  req.onsuccess=()=>ok(req.result||null);req.onerror=()=>fail(req.error);
});}
function idbWrite(db,value){return new Promise((ok,fail)=>{
  const tx=db.transaction('snapshots','readwrite');tx.objectStore('snapshots').put(value,'latest');
  tx.oncomplete=ok;tx.onerror=()=>fail(tx.error);tx.onabort=()=>fail(tx.error);
});}
export async function openStore(layla,notify=()=>{}){
  let db=null,sqliteOk=false,sqliteSnapshot=null,backup=null,corrupt=false;
  try{db=await openIdb();backup=await idbRead(db);}catch{notify('IndexedDBを利用できません。');}
  try{
    await layla.db.executeSql('CREATE TABLE IF NOT EXISTS '+TABLE+' (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    sqliteOk=true;
    const result=await layla.db.executeSql('SELECT v FROM '+TABLE+' WHERE k=?',[ACTIVE]);
    if(result.rows.length){
      const manifest=JSON.parse(result.rows[0].v);
      if(manifest.version!==1||!Array.isArray(manifest.parts)||manifest.parts.length>100)throw Error('保存目録が不正');
      let raw='';
      for(const k of manifest.parts){
        const part=await layla.db.executeSql('SELECT v FROM '+TABLE+' WHERE k=?',[k]);
        if(typeof part.rows?.[0]?.v!=='string')throw Error('本文レコードが欠落');
        raw+=part.rows[0].v;
      }
      sqliteSnapshot={state:JSON.parse(raw),at:Number(manifest.at)||0};
    }
  }catch(e){
    sqliteOk=false;corrupt=true;
    notify('SQLiteを読めません。破損の可能性があるため上書きしません。IndexedDBの退避データを確認します。');
  }
  const hasNewerBackup=backup?.state&&(!sqliteSnapshot||(backup.pending&&backup.at>sqliteSnapshot.at));
  const initial=hasNewerBackup?backup.state:sqliteSnapshot?.state||backup?.state||null;
  let mode=sqliteOk?'SQLite':'IndexedDB';
  const saveSql=async(state,at)=>{
    const data=JSON.stringify(state);
    const chunks=data.match(/[\s\S]{1,40000}/g)||[''];
    if(chunks.length>100)throw Error('保存領域の最大サイズを超えました。JSONを外部へ保存してください。');
    const generation='g'+at+'-'+Math.random().toString(36).slice(2,9);
    const keys=[];
    for(let i=0;i<chunks.length;i++){
      const key=generation+'/'+i;keys.push(key);
      await layla.db.executeSql('INSERT INTO '+TABLE+' (k,v) VALUES (?,?)',[key,chunks[i]]);
    }
    const old=await layla.db.executeSql('SELECT v FROM '+TABLE+' WHERE k=?',[ACTIVE]);
    await layla.db.executeSql('INSERT OR REPLACE INTO '+TABLE+' (k,v) VALUES (?,?)',[ACTIVE,JSON.stringify({version:1,parts:keys,at})]);
    if(old.rows.length)try{
      const previous=JSON.parse(old.rows[0].v);
      for(const key of previous.parts||[])if(!keys.includes(key))
        await layla.db.executeSql('DELETE FROM '+TABLE+' WHERE k=?',[key]);
    }catch{}
  };
  let chain=Promise.resolve();
  async function commit(state){
    const at=Date.now();
    const payload={state:JSON.parse(JSON.stringify(state)),at,pending:true};
    if(sqliteOk){
      try{
        await saveSql(payload.state,at);mode='SQLite';
        if(db)await idbWrite(db,{...payload,pending:false}).catch(()=>notify('IndexedDBミラーの更新に失敗しました。'));
        notify('保存済み（Layla SQLite）');return;
      }catch(e){sqliteOk=false;mode='IndexedDB';notify('SQLiteへの保存に失敗。IndexedDBへ退避します。');}
    }
    if(db){await idbWrite(db,payload);notify('保存済み（IndexedDB退避）');return;}
    notify('永続保存できません。JSONを書き出してください。');
    throw Error('保存先が利用できません');
  }
  if(hasNewerBackup&&sqliteOk){
    try{await commit(initial);notify('前回のIndexedDB退避データをSQLiteへ復旧しました。');}
    catch{notify('退避データの復旧に失敗しました。JSONを書き出してください。');}
  }
  return {initial,mode:()=>mode,corrupt,
    save(state){const snapshot=JSON.parse(JSON.stringify(state));chain=chain.catch(()=>{}).then(()=>commit(snapshot));return chain;},
    flush(){return chain;}};
}
