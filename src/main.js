import {makeRuntime} from './runtime.js';
import {FIELDS,LIMITS,BODY_LIMIT,TRANSFER_MAX_BYTES,cleanState,freshState,warningsForState,buildRequest,samplerParams,parseImport,readableText,acceptTurn,undoTurn} from './logic.js';
import {openStore} from './persistence.js';
import {writeFile,filename} from './export.js';
import './style.css';

const app=document.getElementById('app'),host=makeRuntime(),el=id=>document.getElementById(id);
const node=(tag,cls,value)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(value!==undefined)e.textContent=value;return e;};
let state=freshState(),store=null,ready=false,saveBlocked=true,busy=false,stream=null,activeId=0;
let candidate=null,saveTimer=null,fullBody=false,saveError='',notice='',lastAcceptedMessage='';
const promptDraft=()=>state.draft.trim()||'この場面を自然に続きを進める';
function status(text,error=false){
  notice=text||'';
  const e=el('status');if(e){e.textContent=notice;e.className='status'+(error?' error':'');}
}
function safety(text=''){
  const warnings=ready?warningsForState(state):[];
  const problem=text||saveError||(saveBlocked?'保存停止中。JSON書き出しで現状を退避し、復旧元を確認してください。':'');
  const n=el('safety');
  n.hidden=!problem&&!warnings.length;
  n.textContent=[problem,...warnings].filter(Boolean).join('／');
  n.className='safety'+(problem?' error':'');
}
function lockUI(){
  const disabled=!ready||busy||saveBlocked;
  for(const id of ['generate','new-story','restore','user-input'])
    if(el(id))el(id).disabled=disabled;
  el('nav-settings').disabled=!ready||busy;
  el('import').disabled=!ready||busy||Boolean(store?.recoveryRequired);
  if(el('recover'))el('recover').disabled=!ready||!store?.recoveryRequired;
  if(el('raw-backup'))el('raw-backup').disabled=!ready;
  for(const input of el('screen-settings').querySelectorAll('input:not([type=file]),textarea,select'))input.disabled=saveBlocked||busy;
  el('stop').disabled=!busy;
  for(const id of ['accept','retry','discard','candidate-edit'])if(el(id))
    el(id).disabled=disabled||!candidate;
  el('undo').disabled=disabled||!state.undo||state.body.length!==state.undo?.beforeLength+state.undo?.added?.length;
  for(const id of ['export-json','export-txt','export-md','quick-backup'])
    if(el(id))el(id).disabled=!ready; // Export is allowed even in read-only recovery.
}
function persist(delay=600){
  state.updatedAt=new Date().toISOString();
  safety();
  if(saveBlocked){status('現在は未保存です。復旧確認または外部JSONバックアップが必要です。',true);return;}
  clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>{saveTimer=null;void saveNow();},delay);
  status('編集中… 自動保存待機');
}
async function saveNow(){
  clearTimeout(saveTimer);saveTimer=null;
  if(!store||saveBlocked){safety();return false;}
  try{
    await store.save(state);
    saveError='';status('保存済み（'+store.mode()+'）');safety();return true;
  }catch(e){
    saveError='保存失敗: '+String(e?.message||e);
    status(saveError,true);safety();return false;
  }
}
function showHistory(){
  const root=el('turn-log');root.replaceChildren();
  if(!state.turns.length){root.append(node('p','hint','まだ対話履歴はありません。'));return;}
  state.turns.slice(-10).forEach(t=>{
    const div=node('div','turn');
    div.append(node('span','tag','あなたの入力'),node('div','',t.user),
      node('div','hint','→ '+String(t.preview||t.reply||'').slice(0,140).replace(/\n/g,' ')+'…'));
    root.append(div);
  });
}
function paint(){
  el('title-view').textContent=state.title||'新しい物語';
  const long=state.body.length>20000&&!fullBody;
  el('body-view').textContent=state.body
    ?(long?'（長編のため末尾2万字を表示中。全文は設定画面で編集できます）\n\n'+state.body.slice(-20000):state.body)
    :'ここから物語が始まります。設定を記入して、主人公の行動を入力してください。';
  el('body-view').classList.toggle('empty',!state.body);
  el('counter').textContent=state.body.length.toLocaleString('ja-JP')+'文字（UTF-16）';
  el('view-full').hidden=state.body.length<=20000;
  el('view-full').textContent=fullBody?'末尾のみ表示':'全文を表示';
  el('meta').textContent='モデルはLayla本体で選択 · '+(store?store.mode():'読み込み中');
  el('user-input').value=state.draft;
  showHistory();showCandidate();lockUI();safety();
}
function showCandidate(message){
  const panel=el('candidate-box');panel.hidden=!candidate;
  if(candidate){
    const edit=el('candidate-edit');
    if(document.activeElement!==edit||busy)edit.value=candidate.text;
    el('candidate-status').textContent=message===undefined?(candidate.note||'候補を確認し、必要なら編集して採用してください。'):message;
  }
  lockUI();
}
function showMain(){
  if(!ready)return;
  el('screen-main').hidden=false;el('screen-settings').hidden=true;
  el('nav-main').classList.add('primary');el('nav-settings').classList.remove('primary');
  paint();void saveNow(); // Save immediately on navigation.
  window.scrollTo(0,0);
}
function showSettings(){
  if(!ready||busy||saveBlocked)return;
  el('screen-main').hidden=true;el('screen-settings').hidden=false;
  el('nav-main').classList.remove('primary');el('nav-settings').classList.add('primary');
  rebuildSettings();window.scrollTo(0,0);
}
function inputField(parent,key,label,kind,hint){
  const id='field-'+key,l=node('label','',label),control=node(kind==='text'?'input':'textarea');
  l.htmlFor=id;control.id=id;control.placeholder=hint||'';
  if(kind==='text')control.type='text';else control.rows=['memory','characters'].includes(key)?6:3;
  control.value=state[key]||'';control.maxLength=LIMITS[key];
  const count=node('div','hint');count.textContent=control.value.length+' / '+LIMITS[key]+'文字';
  control.addEventListener('input',()=>{
    // maxlength prevents NEW overflows, but legacy oversized content is never truncated.
    state[key]=control.value;count.textContent=control.value.length+' / '+LIMITS[key]+'文字';
    if(key==='title')el('title-view').textContent=control.value||'新しい物語';
    persist();
  });
  parent.append(l,control,count,node('p','hint',hint));
}
function sectionSettings(label,keys,opened=false){
  const details=node('details');details.open=opened;details.append(node('summary','',label));
  for(const key of keys){const f=FIELDS.find(f=>f[0]===key);if(f)inputField(details,...f);}
  el('settings-fields').append(details);
}
function preference(parent,key,label,min,max,step){
  const div=node('div'),l=node('label','',label),ctrl=node('input'),msg=node('div','hint');
  l.htmlFor='pref-'+key;ctrl.id=l.htmlFor;ctrl.type='number';ctrl.min=min;ctrl.max=max;ctrl.step=step;
  const initial=state.prefs[key];ctrl.value=initial===null||initial===undefined?'':String(initial);
  ctrl.placeholder=['targetChars','contextChars','contextTokens'].includes(key)?'既定値あり':'空欄＝Layla既定値';
  const validate=()=>{
    const x=ctrl.value;
    const bad=x!==''&&(!Number.isFinite(Number(x))||Number(x)<min||Number(x)>max);
    msg.textContent=bad?'設定範囲は '+min+'〜'+max+' です。':'';
    ctrl.setAttribute('aria-invalid',String(bad));
    if(!bad){state.prefs[key]=x;persist();}
  };
  ctrl.addEventListener('change',validate);
  div.append(l,ctrl,msg);parent.append(div);
}
function selectPref(parent,key,label,values){
  const div=node('div'),l=node('label','',label),select=node('select');
  l.htmlFor='pref-'+key;select.id=l.htmlFor;
  for(const value of values){const option=node('option','',value);option.value=value;select.append(option);}
  if(!values.includes(state.prefs[key]))state.prefs[key]=values[0];
  select.value=state.prefs[key];select.onchange=()=>{state.prefs[key]=select.value;persist();};
  div.append(l,select);parent.append(div);
}
function rebuildSettings(){
  const fields=el('settings-fields');fields.replaceChildren();
  sectionSettings('作品の基本情報',['title','synopsis','goal'],true);
  sectionSettings('キャラクター・世界観',['characters','world','player'],true);
  sectionSettings('覚えておいてほしい内容（自由記載）',['memory'],true);
  sectionSettings('禁止事項・固定指示',['avoidPlot','avoidWords','rules']);
  sectionSettings('モデル名のメモ（切替はLayla本体）',['modelNote']);
  const pref=el('preference-fields');pref.replaceChildren();
  const basic=node('div','formgrid');
  preference(basic,'targetChars','生成目安の文字数',100,1000,50);
  preference(basic,'contextChars','直近本文の参照希望文字数',500,12000,100);
  preference(basic,'contextTokens','モデルのコンテキスト長（概算トークン）',2048,65536,512);
  selectPref(basic,'pace','物語のテンポ',['ゆっくり','普通','速め']);
  selectPref(basic,'pov','物語の視点',['ユーザー視点（二人称寄り）','相手キャラの一人称','三人称（客観）']);
  pref.append(basic);
  const checks=node('div','');
  [['autoAdopt','正常生成時は自動採用する（既定OFF）'],['includeInput','ユーザーの入力を自然に物語へ反映させる']].forEach(([key,label])=>{
    const wrap=node('label','checkline'),box=node('input');box.type='checkbox';box.checked=state.prefs[key]===true;
    box.onchange=()=>{state.prefs[key]=box.checked;persist();};wrap.append(box,document.createTextNode(label));checks.append(wrap);
  });pref.append(checks);
  const detail=node('details');detail.append(node('summary','','詳細な生成設定（対応はLayla本体によります）'));
  const grid=node('div','formgrid');
  [['temperature','temperature',0,2,.05],['top_p','top_p',0,1,.05],['top_k','top_k',1,200,1],
    ['min_p','min_p',0,1,.01],['repeat_penalty','繰り返しペナルティ',.5,3,.05],
    ['repeat_last_n','検索範囲（実験的）',0,2048,1],['repeat_penalty_slope','傾斜（実験的）',0,2,.05],
    ['frequency_penalty','frequency_penalty',-2,2,.1],['presence_penalty','presence_penalty',-2,2,.1],
    ['max_tokens','max_tokens',1,8192,1]].forEach(args=>preference(grid,...args));
  detail.append(grid,node('p','hint','詳細パラメータが原因でエラーになる場合は空欄に戻してください。'));
  pref.append(detail);
  const edit=el('edit-body');edit.value=state.body;edit.maxLength=BODY_LIMIT;
  const count=el('edit-count');count.textContent=state.body.length+' / '+BODY_LIMIT+'文字';
  edit.oninput=()=>{
    const text=edit.value;
    if(text.length<state.body.length*0.5&&state.body.length>500){
      el('edit-warning').hidden=false;
      const previous={...state,body:state.body};
      // Preserve an independent snapshot before a destructive edit.
      void store?.checkpoint(previous).catch(e=>status('削除前の復元点を保存できません: '+e.message,true));
    }
    state.body=text;state.undo=null;count.textContent=text.length+' / '+BODY_LIMIT+'文字';
    persist();
  };
  updatePromptMeta();
}
function updatePromptMeta(){
  const m=buildRequest(state,promptDraft()).meta;
  el('prompt-meta').textContent='送信予算の目安：約'+m.estimatedTokens+'トークン／設定コンテキスト'+m.contextTokens+
    '（出力予約'+m.outputTokens+'）。省略した項目：'+(m.omitted.length?m.omitted.map(x=>x.key).join('、'):'なし')+
    '。本文の古い部分：'+m.bodyOmitted+'文字省略。※推定値であり実モデルのトークン化とは異なります。';
}
function modal(question,choices=[['yes','続行'],['no','キャンセル']]){
  return new Promise(resolve=>{
    const overlay=el('modal'),body=el('modal-content'),buttons=el('modal-buttons');
    body.textContent=question;buttons.replaceChildren();overlay.hidden=false;
    function close(value){overlay.hidden=true;resolve(value);}
    for(const [val,label] of choices){
      const b=node('button',val==='yes'?'primary':'ghost',label);
      b.onclick=()=>close(val);buttons.append(b);
    }
  });
}
async function useCandidate(){
  if(!candidate?.text?.trim()||busy||saveBlocked)return false;
  if(candidate.baseBody!==state.body){status('候補生成後に本文が変わっています。上書きせず、候補をJSONにバックアップしてください。',true);return false;}
  try{
    state=acceptTurn(state,candidate);candidate=null;paint();persist(0);
    const saved=await saveNow();
    if(saved)status('候補を採用し、保存しました。');
    return saved;
  }catch(e){status('採用できません: '+String(e.message||e),true);return false;}
}
async function startGeneration({retry=false,inputOverride=null}={}){
  if(busy||saveBlocked||!ready)return;
  if(candidate&&!retry){
    const choice=await modal('未採用候補が残っています。候補を破棄して新しく生成しますか？');
    if(choice!=='yes')return;
  }
  const requestInput=inputOverride??promptDraft();
  const old=candidate,baseBody=state.body;
  const thisId=++activeId;
  busy=true;stream=null;
  candidate={user:requestInput,text:'',sourceDraft:state.draft,baseBody,note:'生成中…'};
  state.pendingCandidate=candidate;persist(0);showCandidate('生成中…');lockUI();
  let finished=false,stopResolver=null;
  const aborted=new Promise(resolve=>{stopResolver=resolve;});
  const canUpdate=()=>thisId===activeId&&!finished;
  try{
    const request=buildRequest(state,requestInput),params=samplerParams(state.prefs);
    if(params.max_tokens===undefined)params.max_tokens=Math.min(4096,Math.ceil(state.prefs.targetChars*2.2)+128);
    if(request.meta.omitted.length)status('コンテキスト予算により設定の一部を省略しています。設定で内訳を確認できます。');
    stream=host.generate({messages:request.messages,params,
      onText:text=>{
        if(!canUpdate())return;
        candidate.text=text;el('candidate-edit').value=text;
      },onError:error=>{if(canUpdate())status('生成エラー: '+String(error?.message||error),true);}
    });
    activeStop=()=>stopResolver({kind:'stopped'});
    const result=await Promise.race([stream.final().then(value=>({kind:'done',value}),error=>({kind:'error',error})),aborted]);
    if(!canUpdate())return;
    if(result.kind==='stopped'){
      candidate.note='停止しました。途中までの文章を確認して採用できます。';
    }else if(result.kind==='error'){
      throw result.error;
    }else{
      candidate.text=String(result.value||candidate.text||'').trim();
      if(!candidate.text)throw Error('モデルの応答が空です。');
      const forbidden=state.avoidWords.split(/[,、，\n]/).map(t=>t.trim()).filter(Boolean);
      const hit=forbidden.find(t=>candidate.text.includes(t));
      candidate.note=hit?'禁止ワード「'+hit+'」が含まれています。内容を確認してください。':'生成が完了しました。編集・再生成・採用を選べます。';
      if(state.prefs.autoAdopt&&!hit&&state.body===baseBody){
        finished=true;busy=false;await useCandidate();return;
      }
    }
    state.pendingCandidate=candidate;persist(0);
  }catch(e){
    const err=String(e?.message||e);
    if(!candidate.text&&old){
      candidate=old;state.pendingCandidate=old;
      candidate.note='再生成に失敗しました。前の候補を残しています。';
    }else if(!candidate.text){
      candidate=null;state.pendingCandidate=null;
    }else candidate.note='生成エラーで途中停止しました。途中までの文章を確認してください。';
    status('生成に失敗しました: '+err+'。詳細生成設定を空欄に戻してお試しください。',true);persist(0);
  }finally{
    if(thisId===activeId){finished=true;busy=false;stream=null;activeStop=null;lockUI();showCandidate();}
  }
}
let activeStop=null;
function stopGeneration(){
  if(!busy)return;
  const token=activeId;
  try{stream?.abort();}catch{}
  activeId++; // Ignore late stream callbacks from the cancelled generation.
  busy=false;stream=null;lockUI();
  if(candidate){
    candidate.note='生成を停止しました。途中までの文章は未採用です。';
    state.pendingCandidate=candidate;showCandidate();persist(0);
  }
  if(typeof activeStop==='function'){const cancel=activeStop;activeStop=null;cancel();}
  status('停止しました。');
}
async function exportAs(ext){
  if(!ready)return;
  try{
    const content=ext==='json'?JSON.stringify(state,null,2):readableText(state,ext);
    const name=filename(state.title,ext);
    const mime=ext==='json'?'application/json':ext==='md'?'text/markdown':'text/plain';
    const result=await writeFile(host,name,content,mime);
    status(result.message,result.kind==='manual');
    if(result.kind==='manual'){
      el('manual-export').hidden=false;el('manual-name').textContent=name;
      el('manual-text').value=result.text;el('manual-export').scrollIntoView({block:'nearest'});
    }
    void saveNow(); // Do not delay the share sheet waiting for SQLite.
  }catch(e){status('書き出しに失敗しました: '+String(e.message||e),true);}
}
async function beforeDestructive(action){
  if(!store?.hasStorage){status('端末保存ができません。外部JSONバックアップを取ってください。',true);return false;}
  try{if(!await saveNow())throw Error('現在の状態を保存できません。');await store.checkpoint(state);return true;}
  catch(e){status('復元点を作れないため操作を中止しました: '+String(e.message||e),true);return false;}
}
async function handleImport(file){
  if(!file||!ready||busy)return;
  try{
    if(file.size>TRANSFER_MAX_BYTES)throw Error('50MB以下のファイルを選んでください。');
    const parsed=parseImport(file.name,await file.text(),state);
    const type=parsed.full?'設定・記憶・本文・履歴すべて':'本文と履歴のみ';
    if(await modal(file.name+' を読み込みます。置換対象: '+type+'。事前に外部JSONバックアップを取っていますか？')!=='yes')return;
    if(saveBlocked){
      if(store?.recoveryRequired)throw Error('先に復旧元を選択してください。');
      if(await modal('現在の保存先は読み取り専用です。既存の異常データが残る場合があります。外部バックアップを確認した上で復旧を許可しますか？')!=='yes')return;
      store.allowImportRecovery();saveBlocked=false;
    }else if(!await beforeDestructive('import'))return;
    state=parsed.state;state.updatedAt=new Date().toISOString();
    candidate=state.pendingCandidate;fullBody=false;paint();rebuildSettings();
    if(await saveNow())status('ファイルを読み込み保存しました。');
    else status('読み込みましたが保存に失敗しました。外部JSONへ書き出してください。',true);
  }catch(e){status('読み込みに失敗しました: '+String(e.message||e),true);}
}
async function resetStory(){
  if(!ready||busy||saveBlocked)return;
  if(await modal('新しい作品にすると現在の本文と設定が置き換わります。事前にJSONを外部保存してください。')!=='yes')return;
  if(!await beforeDestructive('reset'))return;
  state=freshState();candidate=null;paint();rebuildSettings();await saveNow();
}
async function restoreCheckpoint(){
  if(!ready||saveBlocked||busy)return;
  const versions=await store.checkpoints();
  if(!versions.length){status('復元できる以前の保存点はありません。');return;}
  const lines=versions.map((v,i)=>(i+1)+'. '+new Date(v.at).toLocaleString('ja-JP')+'／'+v.title+'／'+v.chars+'文字');
  const choice=await modal('直近の復元点を表示します。最新を復元しますか？\n'+lines.join('\n'),[['yes','最新を復元'],['no','中止']]);
  if(choice!=='yes')return;
  try{
    const selected=cleanState(JSON.parse(versions[0].data));
    if(!await beforeDestructive('restore'))return;
    state=selected;candidate=state.pendingCandidate;paint();rebuildSettings();
    await saveNow();status('復元点から戻しました。');
  }catch(e){status('復元できません: '+String(e.message||e),true);}
}
async function recoverChoice(){
  if(!store?.recoveryRequired)return;
  const choice=await modal('未同期のIndexedDBとSQLiteに異なる本文があります。どちらを採用しますか？\n※どちらも選ばず保留できます。',
    [['idb','IndexedDBの退避を使う'],['sqlite','SQLiteの保存を使う'],['cancel','保留する']]);
  if(choice==='cancel')return;
  try{
    const recovered=await store.chooseRecovery(choice);
    state=cleanState(recovered);candidate=state.pendingCandidate;
    store.recoveryRequired=false;saveBlocked=false;saveError='';ready=true;
    paint();status('指定した保存元から復元・保存しました。');
  }catch(e){status('復旧に失敗しました: '+String(e.message||e),true);}
}
async function exportRaw(){
  try{
    const raw=await store.rawDump();
    const result=await writeFile(host,filename('talking-story-raw-recovery','json'),raw,'application/json');
    status(result.message,result.kind==='manual');
    if(result.kind==='manual'){el('manual-export').hidden=false;el('manual-text').value=result.text;}
  }catch(e){status('生データを書き出せません: '+String(e.message||e),true);}
}
function setup(){
  app.innerHTML=
    '<header><div class="bar"><img class="logo" src="./icon.jpg" alt="緑の時計"><div class="titles"><div class="subtitle">LAYLA MINI-APP · LOCAL STORY</div><div class="brand" id="title-view">新しい物語</div></div><span class="badge">物語</span></div>'+
    '<div id="status" class="status" role="status" aria-live="polite">データ読み込み中…</div><div id="safety" class="safety error" role="alert">初期化中</div></header>'+
    '<main><div id="screen-main">'+
    '<section class="panel"><div class="split" style="justify-content:space-between"><h2>確定した物語</h2><span class="mini" id="counter"></span></div><p id="meta" class="hint"></p><div class="story" id="body-view"></div><div class="actions"><button id="view-full">全文を表示</button><button id="jump-bottom">入力欄へ移動</button><button id="undo">直前の採用を取り消す</button></div></section>'+
    '<section class="panel" id="prompt-section"><h2>あなたの台詞・行動</h2><p class="hint">本人が話す台詞・取る行動、次の場面の希望を記入してください。</p><textarea id="user-input" rows="5" maxlength="15000" placeholder="例：『おはよう』と笑って、隣に座る。"></textarea><div class="actions"><button id="generate" class="primary">続きを生成</button><button id="stop" class="warn" disabled>生成停止</button></div><div id="candidate-box" hidden><label for="candidate-edit">未採用の候補（編集可能）</label><textarea id="candidate-edit" rows="9"></textarea><p id="candidate-status" class="hint"></p><div class="actions"><button id="accept" class="primary">この文章を採用</button><button id="retry">もう一度生成</button><button id="discard" class="warn">破棄</button></div></div></section>'+
    '<section class="panel"><details><summary>直近の入力と採用履歴</summary><div class="chatlog" id="turn-log"></div></details></section></div>'+
    '<div id="screen-settings" hidden><section class="panel"><h2>作品設定</h2><p class="hint">日本語の文章と [海:名称≡&lt;虎田海&gt;] 形式は混在できます。</p><div id="settings-fields"></div></section>'+
    '<section class="panel"><h2>生成設定</h2><div id="preference-fields"></div><p class="hint" id="prompt-meta"></p></section>'+
    '<section class="panel"><h2>確定本文の編集</h2><p class="hint">ここが正本です。長編の場合は編集前にJSONをバックアップしてください。</p><p id="edit-count" class="hint"></p><p id="edit-warning" class="safety" hidden>本文を大きく削除しました。誤操作であれば、直ちに「直前の状態を復元」を利用してください。</p><textarea id="edit-body" class="long" rows="12"></textarea></section>'+
    '<section class="panel"><h2>バックアップ・復元</h2><p class="hint">JSONは設定・自由記憶・本文・履歴を保存。TXTとMDは本文用。保存先はiOS「ファイル」で確認してください。</p><div class="actions"><button id="export-json" class="primary">全データ JSON</button><button id="export-txt">本文 TXT</button><button id="export-md">本文 MD</button></div><div class="actions"><button id="import">ファイルを読み込む</button><button id="restore">直前の状態を復元</button><button id="new-story" class="warn">新しい作品</button></div><div class="actions"><button id="recover">復旧元を選択</button><button id="raw-backup">保存生データの救出</button></div><input id="file-picker" type="file" accept=".json,.txt,.md" hidden></section></div>'+
    '<section class="panel" id="manual-export" hidden><h3>緊急書き出し</h3><p id="manual-name" class="hint"></p><p class="hint">下のテキストをすべてコピーして、iOS「ファイル」へ保存してください。</p><textarea id="manual-text" rows="6" readonly></textarea><button id="copy-manual">テキストをコピー</button></section>'+
    '</main><nav class="nav"><button class="primary" id="nav-main">本文へ戻る</button><button id="nav-settings">設定</button><button id="quick-backup">JSON保存</button></nav>'+
    '<div id="modal" class="overlay" hidden role="dialog" aria-modal="true"><div class="modal-card"><p id="modal-content"></p><div id="modal-buttons" class="actions"></div></div></div>';
  el('nav-main').onclick=showMain;el('nav-settings').onclick=showSettings;
  el('quick-backup').onclick=()=>void exportAs('json');
  el('generate').onclick=()=>void startGeneration();
  el('stop').onclick=stopGeneration;
  el('accept').onclick=()=>void useCandidate();
  el('retry').onclick=()=>void startGeneration({retry:true,inputOverride:candidate?.user});
  el('discard').onclick=async()=>{
    if(await modal('未採用の生成文を破棄しますか？')!=='yes')return;
    candidate=null;state.pendingCandidate=null;persist(0);showCandidate();status('候補を破棄しました。');
  };
  el('candidate-edit').oninput=e=>{if(!candidate||busy)return;candidate.text=e.target.value;state.pendingCandidate=candidate;persist();};
  el('user-input').oninput=e=>{state.draft=e.target.value;persist();};
  el('undo').onclick=async()=>{
    if(await modal('直前に採用した1ターンを取り消しますか？')!=='yes')return;
    try{state=undoTurn(state);candidate=null;paint();persist(0);await saveNow();}
    catch(e){status('取り消せません: '+String(e.message||e),true);}
  };
  el('view-full').onclick=()=>{fullBody=!fullBody;paint();};
  el('jump-bottom').onclick=()=>el('prompt-section').scrollIntoView({block:'start'});
  el('export-json').onclick=()=>void exportAs('json');
  el('export-txt').onclick=()=>void exportAs('txt');
  el('export-md').onclick=()=>void exportAs('md');
  el('import').onclick=()=>el('file-picker').click();
  el('file-picker').onchange=e=>{const file=e.target.files?.[0];e.target.value='';if(file)void handleImport(file);};
  el('new-story').onclick=()=>void resetStory();
  el('restore').onclick=()=>void restoreCheckpoint();
  el('recover').onclick=()=>void recoverChoice();
  el('raw-backup').onclick=()=>void exportRaw();
  el('copy-manual').onclick=async()=>{
    const area=el('manual-text');area.focus();area.select();
    try{await navigator.clipboard.writeText(area.value);status('コピーしました。ファイルに保存してください。');}
    catch{status('テキストを選択しました。コピー操作をしてください。',true);}
  };
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='hidden'&&ready){state.pendingCandidate=candidate;void saveNow();}
  });
  window.addEventListener('pagehide',()=>{if(ready){state.pendingCandidate=candidate;void saveNow();}});
  el('modal').hidden=true;paint();
}
async function init(){
  setup();lockUI();
  try{
    store=await openStore(host,message=>status(message,true),{validator:cleanState});
    if(store.initial){
      try{state=cleanState(store.initial);}
      catch(e){saveBlocked=true;saveError='データ読み込みエラー: '+e.message;ready=true;paint();safety();return;}
    }
    candidate=state.pendingCandidate;
    ready=true;saveBlocked=store.readOnly||!store.hasStorage;
    if(store.recoveryRequired){
      saveError='SQLiteとIndexedDBの編集が衝突しています。復旧元の選択が必要です。';
      status(saveError,true);
      paint();el('recover').disabled=false;el('nav-settings').disabled=false;
    }else{
      paint();
      if(saveBlocked){saveError=store.problem||'永続保存不可。JSON書き出しを行ってください。';status(saveError,true);}
      else status('準備完了。保存先：'+store.mode());
    }
    safety();
  }catch(e){
    ready=true;saveBlocked=true;saveError='初期化に失敗: '+String(e.message||e);
    status(saveError,true);paint();safety();
  }
}
void init();
