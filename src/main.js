import {makeRuntime} from './runtime.js';
import {FIELDS,LIMITS,BODY_LIMIT,TRANSFER_MAX_BYTES,cleanState,freshState,warningsForState,buildRequest,samplerParams,readableText,compactBackup,acceptTurn,bodyFingerprint,rememberReply,restoreReplyCandidate,updateStreamText,inputLimitWarning,AUTO_CONTINUE_INPUT,editableTurnInput} from './logic.js';
import {openStore,CheckpointArchiveUnreadable} from './persistence.js';
import {timeline,timelineAt,forkAt,rewindAfter,editUserAt,editReplyAt,regenerateAt,switchBranch,deleteInactiveBranch,reconcileBodyEdit,clearHistoryAgainstBody,rewindLastWithoutFork,MAX_ARCHIVED_BRANCHES,makeBodyRecovery} from './branches.js';
import {writeFile,filename,browserDownload,utf8ByteLength,manualExportPayload,manualPageOffsets,manualPageName} from './export.js';
import {runImport,regenerateTurn,stoppedCandidate,waitForStop,exportPlan,exportJsonWithFallback,checkArchivesManually} from './ui-flows.js';
import './style.css';

const app=document.getElementById('app'),host=makeRuntime(),el=id=>document.getElementById(id);
const node=(tag,cls,value)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(value!==undefined)e.textContent=value;return e;};
let state=freshState(),store=null,ready=false,saveBlocked=true,busy=false,stream=null,activeId=0;
let candidate=null,saveTimer=null,fullBody=false,saveError='',backupSizeWarning='',notice='',noticeError=false,lastAcceptedMessage='';
let lastExport=null,exporting=false,pendingBodyEdit=null,bodyEditTimer=null,bodyEditBackup=null,replacementSaving=false;
let deletionWarning='',historyWarning='';
const bodyRecovery=makeBodyRecovery();
let periodicAt=null,periodicTask=null,periodicWarning='',recoveryEpoch=0,periodicLoaded=false,periodicRetryAt=0;
function resetBodyRecovery(){
  bodyRecovery.reset();recoveryEpoch++;integrityEpoch++;integrityResults.clear();
  const label=el('integrity-status');if(label)label.textContent=INTEGRITY_HINT;
}
async function ensurePeriodicCheckpoint(){
  if(!ready||!store||saveBlocked||busy||branchBusy||bodyBackupBusy||!state.body.length||document.visibilityState==='hidden')return;
  if(periodicTask||Date.now()<periodicRetryAt)return;
  periodicTask=(async()=>{
    try{
      if(!periodicLoaded){
        periodicAt=await store.latestAutomaticCheckpointAt();
        periodicLoaded=true;
      }
      if(periodicAt!==null&&new Date(periodicAt).toDateString()===new Date().toDateString()){periodicWarning='';return;}
      if(saveBlocked||busy||branchBusy||bodyBackupBusy||!state.body.length||document.visibilityState==='hidden')return;
      const snapshot=cleanState({...state,branches:[]}),epoch=recoveryEpoch;
      await store.checkpoint(snapshot,'日次自動復元点',{scope:'active'});
      periodicAt=Date.now();periodicRetryAt=0;periodicWarning='';
      if(epoch===recoveryEpoch)bodyRecovery.seed(snapshot);
    }catch(e){
      periodicRetryAt=Date.now()+3600000;periodicLoaded=false;
      periodicWarning='自動復元点の作成に失敗しました: '+String(e?.message||e)+'。1時間後に再試行します。';
    }
  })();
  try{await periodicTask;}finally{periodicTask=null;}
}
let integrityTask=null,integrityEpoch=0;
const INTEGRITY_HINT='分岐の全文を読み込むため、必要な時だけ手動でチェックします。中断した場合は手動で再実行してください。';
const integrityLabels={ok:'正常',damaged:'破損',missing:'なし',omitted:'容量制限で省略',retry:'一時エラー',unavailable:'利用不可',unsaved:'未保存'};
const integrityResults=new Map();
function integrityIdle(){return ready&&store&&!saveBlocked&&!busy&&!branchBusy&&!bodyBackupBusy&&!exporting&&document.visibilityState!=='hidden';}
async function runIntegrityCheck(){
  if(integrityTask||!integrityIdle())return;
  const workEpoch=integrityEpoch,epoch=recoveryEpoch;
  const sameWork=()=>workEpoch===integrityEpoch;
  // Defer even the initial save until the task is registered and the UI locked.
  integrityTask=Promise.resolve().then(async()=>{
    const label=el('integrity-status');
    const report=text=>{if(sameWork())label.textContent=text;};
    try{
      if(!sameWork()||!integrityIdle())return;
      report('整合性チェックの準備中…');
      if(!await saveNow())throw Error('整合性チェック前の保存に失敗しました。');
      if(!sameWork()||epoch!==recoveryEpoch||!integrityIdle()){report('整合性チェックを中断しました。手動で再実行してください。');return;}
      const branches=state.branches.slice();
      let checked=0,issues=0,retry=false;
      const isCurrent=()=>sameWork()&&integrityIdle()&&epoch===recoveryEpoch&&branches.length===state.branches.length&&branches.every((b,i)=>state.branches[i]===b);
      const complete=await checkArchivesManually(branches,{
        isCurrent,check:b=>store.checkArchive(b),
        onResult:(b,r,index,total)=>{
          integrityResults.set(b.id,r);
          if(r.sql==='retry'||r.idb==='retry')retry=true;
          if(store.archiveIssue(b)||r.repairable)issues++;
          checked=index;report('整合性チェック '+index+' / '+total+' 件');
          showBranches();safety();lockUI();
        },
        pause:()=>new Promise(resolve=>setTimeout(resolve,30))
      });
      if(!complete||!isCurrent()){report('整合性チェックを中断しました。手動で再実行してください。');return;}
      if(retry){report('一時エラーあり。時間をおいて手動で再実行してください。');return;}
      const at=await store.markIntegrityChecked();
      if(!isCurrent()){report('作品が変更されました。手動で再チェックしてください。');return;}
      report('最終チェック：'+new Date(at).toLocaleString('ja-JP')+'／'+checked+'件中 '+issues+'件要確認。修復は分岐一覧から実行できます。');
    }catch(e){report('チェック失敗：'+e.message+'。手動で再試行してください。');}
  });
  lockUI();
  try{await integrityTask;}finally{integrityTask=null;lockUI();}
}
let historyOffset=0,branchBusy=false,bodyBackupBusy=false,editRev=0,savedRev=0,stopUntil=0,retryFallback=null;
let activeGenerationFinished=null,stopUnconfirmed=false,streamSaveInFlight=false;
const HISTORY_PAGE_SIZE=30;
const promptDraft=()=>state.draft.trim()||AUTO_CONTINUE_INPUT;
function renderStatus(){
  const critical=ready&&(saveBlocked||Boolean(store?.recoveryRequired));
  const message=critical?(store?.recoveryRequired?'保存データの衝突：画面上部で復旧元を選択してください。':'保存停止中：画面上部の警告・救出方法を確認してください。'):notice;
  const error=critical||noticeError;
  const e=el('status');
  if(e){if(e.textContent!==message)e.textContent=message;e.className='status'+(error?' error':'');}
  const detail=el('status-detail');
  if(detail){detail.hidden=!noticeError||!notice;if(detail.textContent!==notice)detail.textContent=noticeError?notice:'';}
}
function status(text,error=false){
  notice=text||'';noticeError=error;renderStatus();
}
function safety(text=''){
  if(store?.readOnly)saveBlocked=true;
  const warnings=ready?warningsForState(state):[];
  const unreadable=state.branches.filter(b=>store?.archiveIssue(b));
  if(unreadable.length)warnings.push('読込不能の分岐 '+unreadable.length+'件：元データを保護しています。本文TXT/MDや生データ救出をご利用ください。');
  if(store?.mirrorStatus)warnings.push(store.mirrorStatus);
  const problem=[text,saveError,backupSizeWarning,periodicWarning,saveBlocked?'保存停止中。JSON書き出しで現状を退避し、復旧元を確認してください。':''].filter(Boolean).join('／');
  const n=el('safety');
  n.hidden=!problem&&!warnings.length;
  n.textContent=[problem,...warnings].filter(Boolean).join('／');
  n.className='safety'+(problem?' error':'');
  if(ready)renderStatus();
}
function lockUI(){
  if(store?.readOnly)saveBlocked=true;
  const disabled=!ready||busy||branchBusy||bodyBackupBusy||saveBlocked||exporting;
  const cooling=Date.now()<stopUntil;
  for(const id of ['generate','new-story','restore','user-input'])
    if(el(id))el(id).disabled=disabled||(id==='generate'&&cooling);
  el('nav-settings').disabled=!ready||busy||branchBusy||bodyBackupBusy;
  el('nav-main').disabled=!ready||branchBusy||bodyBackupBusy;
  el('import').disabled=!ready||busy||branchBusy||bodyBackupBusy||exporting||Boolean(store?.recoveryRequired);
  if(el('recover'))el('recover').disabled=!ready||busy||exporting||branchBusy||bodyBackupBusy||!store?.recoveryRequired;
  if(el('recover-now')){el('recover-now').hidden=!store?.recoveryRequired;el('recover-now').disabled=!ready||busy||exporting||branchBusy||bodyBackupBusy;}
  if(el('raw-backup'))el('raw-backup').disabled=!ready||branchBusy||exporting;
  if(el('raw-body'))el('raw-body').disabled=!ready||busy||branchBusy||exporting||bodyBackupBusy;
  if(el('purge-corrupt'))el('purge-corrupt').disabled=disabled||exporting||store?.mode()!=='SQLite';
  if(el('raw-rows'))el('raw-rows').disabled=!ready||busy||branchBusy||exporting;
  if(el('check-integrity'))el('check-integrity').disabled=disabled||Boolean(integrityTask);
  if(el('rescue-unsaved'))el('rescue-unsaved').disabled=!ready||!store||exporting||busy||branchBusy||bodyBackupBusy;
  if(el('rebuild-idb'))el('rebuild-idb').disabled=!ready||busy||branchBusy||exporting||!store?.canRebuildFromIdb;
  if(el('reset-history'))el('reset-history').disabled=disabled;
  for(const input of el('screen-settings').querySelectorAll('input:not([type=file]),textarea,select'))input.disabled=saveBlocked||busy||branchBusy||exporting||(bodyBackupBusy&&input.id!=='edit-body');
  el('stop').disabled=!busy;
  for(const id of ['accept','retry','discard','candidate-edit'])if(el(id))
    el(id).disabled=disabled||!candidate||(id==='accept'&&!candidate?.text?.trim())||(id==='retry'&&cooling);
  el('undo').disabled=disabled||!state.turns.length||el('undo').dataset.invalidAction==='1';
  for(const button of el('screen-settings').querySelectorAll('[data-trash-action]'))button.disabled=disabled||Boolean(candidate);
  for(const button of el('screen-main').querySelectorAll('[data-branch-action]'))
    button.disabled=disabled||button.dataset.invalidAction==='1';
  for(const id of ['turn-go','turn-start'])if(el(id))el(id).disabled=disabled||!state.turns.length;
  for(const id of ['turn-older','turn-newer'])if(el(id))el(id).disabled=disabled||el(id).dataset.pageDisabled==='1';
  for(const id of ['export-json','export-light-json','export-main-json','export-txt','export-md','quick-backup'])
    if(el(id))el(id).disabled=!ready||exporting||branchBusy; // Export is allowed even in read-only recovery.
}
function persist(delay=600){
  state.updatedAt=new Date().toISOString();
  editRev++;
  // Full validation of all branches on every keystroke is expensive.
  if(el('safety'))safety();
  updateInputWarning();
  if(el('screen-settings')&&!el('screen-settings').hidden)schedulePromptMeta();
  if(saveBlocked){status('現在は未保存です。復旧確認または外部JSONバックアップが必要です。',true);return;}
  clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>{saveTimer=null;void saveNow();},delay);
  status('編集中… 自動保存待機');
}
async function saveNow(force=false){
  while(bodyEditBackup)await bodyEditBackup;
  commitPendingBodyEdit();
  clearTimeout(saveTimer);saveTimer=null;
  if(!store||saveBlocked){
    if(store?.readOnly&&editRev!==savedRev)try{await store.stashActive(state);saveError='未保存の本編・下書き・候補をIndexedDBの救出用領域へ退避しました。';}catch(e){saveError='未保存編集の退避に失敗: '+e.message;}
    safety();return false;
  }
  // Daily recovery points run separately; foreground and stream saves do not wait.
  if(!force&&editRev===savedRev){safety();return true;}
  const revision=editRev;
  try{
    await store.save(state);
    state=store.compactState(state);
    savedRev=Math.max(savedRev,revision);
    saveError=store.backupWarning||'';
    status(saveError||'保存済み（'+store.mode()+'）',Boolean(saveError));
    safety();return true;
  }catch(e){
    saveError='保存失敗: '+String(e?.message||e);
    status(saveError,true);if(store?.readOnly)try{await store.stashActive(state);saveError+='／未保存編集を救出用領域へ退避しました。';}catch{}safety();return false;
  }
}
let promptMetaTimer=null;
function schedulePromptMeta(){
  clearTimeout(promptMetaTimer);
  promptMetaTimer=setTimeout(()=>{if(el('prompt-meta'))updatePromptMeta();},240);
}

function actionButton(text,handler,disabled=false){
  const b=node('button','small ghost',text);
  b.type='button';b.disabled=disabled;b.dataset.branchAction='1';
  if(disabled)b.dataset.invalidAction='1';
  b.onclick=()=>void handler();
  return b;
}
function showHistory(){
  const root=el('turn-log');root.replaceChildren();
  const total=state.turns.length;
  const pages=Math.max(1,Math.ceil(total/HISTORY_PAGE_SIZE));
  historyOffset=Math.max(0,Math.min(pages-1,historyOffset));
  const start=Math.max(0,total-(historyOffset+1)*HISTORY_PAGE_SIZE);
  const end=total-historyOffset*HISTORY_PAGE_SIZE;
  el('turn-range').textContent=total?(start+1)+'〜'+end+' / '+total+'ターン':'履歴なし';
  el('turn-older').dataset.pageDisabled=historyOffset>=pages-1?'1':'0';
  el('turn-newer').dataset.pageDisabled=historyOffset===0?'1':'0';
  el('undo').dataset.invalidAction='0';
  if(!total){root.append(node('p','hint','まだ採用済みの対話履歴はありません。'));return;}
  let positions=null,problem='';
  try{positions=timeline(state);}catch(e){problem=String(e.message||e);}
  if(problem){
    el('undo').dataset.invalidAction='1';
    const warning=node('p','safety error','本文と履歴の位置が一致しないため、過去のメッセージ操作を停止しています。上の「履歴だけ再設定」を選べます。 '+problem);
    root.append(warning);
  }
  if(positions?.length&&positions[positions.length-1].end<state.body.length)
    root.append(node('p','hint','最終ターンの後に、本文へ直接追記されたテキストがあります。'));
  for(let i=end-1;i>=start;i--){
    const t=state.turns[i],p=positions?.[i],box=node('details','turn-history');
    const label=node('summary','turn-summary','第'+(i+1)+'ターン　'+t.user.slice(0,42).replace(/\n/g,' ') +(t.user.length>42?'…':''));
    const content=node('div','turn-detail');
    content.append(node('div','tag','あなたの送信内容'),node('p','turn-text',t.user));
    content.append(node('div','tag','LLMの返答'),
      node('p','turn-text',(p?.reply||t.reply||t.preview||'（本文の位置を確認できません）').slice(0,650)));
    if((p?.reply||'').length>650)content.append(node('p','hint','編集画面では返信全文を表示します。'));
    const actions=node('div','actions history-actions');
    actions.append(
      actionButton('自分の入力を編集',()=>actOnTurn(i,'user'),!positions),
      actionButton('返信を編集',()=>actOnTurn(i,'reply'),!positions),
      actionButton('返信を再生成',()=>actOnTurn(i,'regenerate'),!positions),
      actionButton('ここまで戻す',()=>actOnTurn(i,'rewind'),!positions||i===total-1)
    );
    content.append(actions);
    box.append(label,content);root.append(box);
  }
}
function showBranches(){
  const target=el('branch-list');target.replaceChildren();
  const current=state.activeBranch||{id:'main',name:'本編'};
  el('branch-current').textContent=current.name+'（現在／'+state.turns.length+'ターン）';
  el('branch-count').textContent=state.branches.length+' / '+MAX_ARCHIVED_BRANCHES+'件の保存済み分岐。分岐が増えると保存容量が増えます。定期的にJSONバックアップしてください。';
  const renameCurrent=actionButton('現在の分岐名を変更',()=>branchAction('rename',current.id));
  target.append(renameCurrent);
  if(!state.branches.length){target.append(node('p','hint','まだ分岐はありません。過去の返信を編集・再生成・巻き戻しすると、元の展開がここに保存されます。直前の取り消し・再生成は分岐を増やさずごみ箱に保存します。'));return;}
  for(const b of state.branches.slice().reverse()){
    const row=node('div','branch-row'),summary=node('div','branch-summary');
    summary.append(node('strong','',b.name+(store?.archiveIssue(b)?'（読込不能・保護中）':'')));
    summary.append(node('div','hint',(b.turnCount??b.turns.length)+'ターン・本文'+(b.chars??b.body.length).toLocaleString('ja-JP')+'文字'));
    const actions=node('div','actions branch-actions');
    actions.append(
      actionButton('この分岐を開く',()=>branchAction('switch',b.id)),
      actionButton('名前変更',()=>branchAction('rename',b.id)),
      actionButton('削除',()=>branchAction('delete',b.id))
    );
    const issue=store?.archiveIssue(b),result=integrityResults.get(b.id);
    if(result)summary.append(node('div','hint','SQLite：'+integrityLabels[result.sql]+'／IndexedDB：'+integrityLabels[result.idb]));
    if(issue){
      summary.append(node('div','hint',issue));
      // Keep retry/open available, but require verified recovery or isolation before destructive changes.
      for(const button of Array.from(actions.querySelectorAll('button')).slice(1))button.dataset.invalidAction='1';
      actions.append(actionButton('分岐を隔離（原本保持）',()=>branchAction('isolate',b.id),Boolean(result?.repairable)));
    }
    if(result?.repairable)actions.append(actionButton('健全なコピーから修復',()=>branchAction('repair',b.id)));
    row.append(summary,actions);target.append(row);
  }
}

function updateInputWarning(){
  const n=el('input-warning');if(!n)return;
  const warning=inputLimitWarning(promptDraft(),state.prefs);n.textContent=warning;n.hidden=!warning;
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
  el('user-input').value=state.draft;updateInputWarning();
  showHistory();showBranches();showCandidate();lockUI();safety();
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
function showMain({scroll=true}={}){
  if(!ready||branchBusy||bodyBackupBusy)return;
  commitPendingBodyEdit();
  el('screen-main').hidden=false;el('screen-settings').hidden=true;
  el('nav-main').classList.add('primary');el('nav-settings').classList.remove('primary');
  paint();if(editRev!==savedRev)void saveNow();
  if(scroll)window.scrollTo(0,0);
}
function showSettings(){
  if(!ready||busy||branchBusy||bodyBackupBusy||!el('screen-settings').hidden)return;
  el('screen-main').hidden=true;el('screen-settings').hidden=false;
  el('nav-main').classList.remove('primary');el('nav-settings').classList.add('primary');
  rebuildSettings();lockUI();window.scrollTo(0,0);
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
  ctrl.addEventListener('input',validate);
  ctrl.addEventListener('change',validate);
  div.append(l,ctrl,msg);parent.append(div);
}
function selectPref(parent,key,label,values){
  const div=node('div'),l=node('label','',label),select=node('select');
  l.htmlFor='pref-'+key;select.id=l.htmlFor;
  for(const value of values){const option=node('option','',value);option.value=value;select.append(option);}
  if(!values.includes(state.prefs[key]))state.prefs[key]=values[0];
  select.value=state.prefs[key];select.onchange=()=>{state.prefs[key]=select.value;persist();schedulePromptMeta();};
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
  [['autoAdopt','正常生成時は自動採用する（既定OFF）'],['includeInput','生成AIにも入力内容を描写させる（本文併記OFF時）'],['recordInputInBody','ユーザーの入力原文を確定本文にも併記する（既定OFF）']].forEach(([key,label])=>{
    const wrap=node('label','checkline'),box=node('input');box.type='checkbox';box.checked=state.prefs[key]===true;
    box.onchange=()=>{state.prefs[key]=box.checked;persist();schedulePromptMeta();};wrap.append(box,document.createTextNode(label));checks.append(wrap);
  });checks.append(node('p','hint','「本文にも併記」をONにすると、採用時にあなたが書いた台詞・行動をそのまま本文へ追加します。生成済みの過去ターンは書き換えません。'));pref.append(checks);
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
  pendingBodyEdit=null;clearTimeout(bodyEditTimer);bodyEditTimer=null;
  deletionWarning='';historyWarning='';renderBodyEditWarnings();
  const count=el('edit-count');count.textContent=state.body.length+' / '+BODY_LIMIT+'文字';
  const queueBodyEdit=()=>{
    if(saveBlocked)return;
    const text=edit.value;
    count.textContent=text.length+' / '+BODY_LIMIT+'文字';
    // Keep the focused textarea editable; its value buffers keystrokes while
    // the previous edit is being protected. Never apply unprotected changes.
    if(bodyBackupBusy)return;
    clearTimeout(bodyEditTimer);bodyEditTimer=null;
    if(text===state.body){pendingBodyEdit=null;return;}
    // Retain the original baseline across small deletions and autosaves.
    // Write the recovery point before applying a potentially destructive edit.
    const plan=bodyRecovery.plan(state,text.length);
    if(plan){
      pendingBodyEdit=null;
      bodyBackupBusy=true;lockUI();
      bodyEditBackup=(async()=>{
        let succeeded=false;
        try{
          if(plan.large||!await store.hasMatchingAutomaticCheckpoint(plan.snapshot))
            await store.checkpoint(plan.snapshot,plan.reason,{scope:'active'});
          if(plan.large)deletionWarning='本文を累積で大幅に削除しました。削除前の本文は重要復元点に保存されています。';
          pendingBodyEdit=text;
          renderBodyEditWarnings();
          commitPendingBodyEdit();
          // Large deletions establish a new baseline only after the protected
          // edit has been applied, including the empty-body case.
          bodyRecovery.completed(plan,state);
          succeeded=true;
        }catch(e){
          bodyRecovery.failed(plan);
          // Keep typed text in the editor for a retry/copy, but not in the
          // persisted manuscript. Do not silently apply an unprotected edit.
          pendingBodyEdit=null;
          status('編集前の復元点を作れませんでした。本文は未反映です。入力を保持しました。再編集して再試行してください: '+e.message,true);
        }finally{
          bodyBackupBusy=false;bodyEditBackup=null;lockUI();
          count.textContent=edit.value.length+' / '+BODY_LIMIT+'文字';
          // Re-evaluate buffered changes against the new protected baseline.
          // A second large deletion must get its own checkpoint.
          if(succeeded&&edit.value!==state.body){
            queueBodyEdit();
            if(!bodyBackupBusy&&document.activeElement!==edit)commitPendingBodyEdit();
          }
        }
      })();
      return;
    }
    pendingBodyEdit=text;
    bodyEditTimer=setTimeout(commitPendingBodyEdit,400);
  };
  edit.oninput=queueBodyEdit;
  edit.onblur=()=>{if(!bodyBackupBusy){queueBodyEdit();if(!bodyBackupBusy)commitPendingBodyEdit();}};
  updatePromptMeta();
  renderReplyTrash();
}
function renderReplyTrash(){
  const root=el('reply-trash');root.replaceChildren();
  if(!state.replyTrash.length){root.append(node('p','hint','ごみ箱は空です。'));return;}
  state.replyTrash.forEach((text,index)=>{
    const row=node('details','turn-history');
    row.append(node('summary','turn-summary',(index+1)+'：'+text.slice(0,60).replace(/\n/g,' ')));
    row.append(node('p','turn-text',text.slice(0,650)));
    const button=node('button','small ghost','未採用候補に復元');button.dataset.trashAction='1';
    button.onclick=async()=>{
      if(!ready||busy||branchBusy||bodyBackupBusy||saveBlocked||candidate)return;
      commitPendingBodyEdit();
      if(bodyBackupBusy)return;
      if(await applyStoryChange(s=>({...s,pendingCandidate:restoreReplyCandidate(s,index)}),'ごみ箱の返信を候補に復元しました。'))showMain();
    };
    row.append(button);root.append(row);
  });
}
function renderBodyEditWarnings(){
  const warning=el('edit-warning');
  if(warning){warning.textContent=[deletionWarning,historyWarning].filter(Boolean).join('／');warning.hidden=!deletionWarning&&!historyWarning;}
}
function commitPendingBodyEdit(){
  clearTimeout(bodyEditTimer);bodyEditTimer=null;
  if(pendingBodyEdit===null)return;
  const text=pendingBodyEdit;pendingBodyEdit=null;
  if(text===state.body)return;
  try{
    state=reconcileBodyEdit(state,text);
    historyWarning='';
  }catch(e){
    state.body=text;state.undo=null;
    historyWarning='本文は保持しましたが履歴の再設定が必要です。 '+e.message;
  }
  renderBodyEditWarnings();
  if(el('edit-count'))el('edit-count').textContent=state.body.length+' / '+BODY_LIMIT+'文字';
  persist();
}
function updatePromptMeta(){
  const warning=inputLimitWarning(promptDraft(),state.prefs);
  if(warning){el('prompt-meta').textContent=warning;return;}
  const m=buildRequest(state,promptDraft()).meta;
  el('prompt-meta').textContent='送信予算の目安：約'+m.estimatedTokens+'トークン／設定コンテキスト'+m.contextTokens+
    '（出力予約'+m.outputTokens+'）。今回の入力上限：約'+m.inputLimit+'文字。省略した項目：'+(m.omitted.length?m.omitted.map(x=>x.title).join('、'):'なし')+
    '。本文の古い部分：'+m.bodyOmitted+'文字省略。'+
    (m.overBudget?'入力・固定指示が推定送信予算を超えています。入力上限は約'+m.inputLimit+'文字です。':'')+
    (m.outputCapped?'指定max_tokensはコンテキスト長の半分以下へ制限します。':'')+
    (m.outputTooShort?'生成の目安に対して出力トークン数が少なめです。文が途中で切れる場合は設定を見直してください。':'')+
    '※推定値であり実モデルのトークン化とは異なります。';
}
function modal(question,choices=[['yes','続行'],['no','キャンセル']]){
  return new Promise(resolve=>{
    const overlay=el('modal'),body=el('modal-content'),buttons=el('modal-buttons');
    overlay.querySelector('.modal-editor')?.remove();overlay.querySelector('.modal-validation')?.remove();
    body.textContent=question;buttons.replaceChildren();overlay.hidden=false;
    function close(value){overlay.hidden=true;resolve(value);}
    overlay.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();
      const cancel=choices.some(([v])=>v==='cancel')?'cancel':choices.some(([v])=>v==='no')?'no':null;
      close(cancel);
    }};
    for(const [val,label] of choices){
      const b=node('button',val==='yes'?'primary':'ghost',label);
      b.onclick=()=>close(val);buttons.append(b);
    }
    buttons.querySelector('button')?.focus();
  });
}
async function useCandidate(){
  if(!candidate?.text?.trim()||busy||saveBlocked){status('採用できる文章がありません。生成完了後に確認してください。',true);return false;}
  if(candidate.baseFingerprint!==bodyFingerprint(state.body)){status('候補生成後に本文が変わっています。上書きせず、候補をJSONにバックアップしてください。',true);return false;}
  try{
    state=acceptTurn(state,candidate);candidate=null;paint();persist(0);
    const saved=await saveNow();
    if(saved)status('候補を採用し、保存しました。');
    return saved;
  }catch(e){status('採用できません: '+String(e.message||e),true);return false;}
}
async function startGeneration({retry=false,inputOverride=null,preserveDraft=false}={}){
  if(busy||bodyBackupBusy||saveBlocked||!ready)return;
  if(Date.now()<stopUntil){status('前の生成が停止したことを確認中です。終了確認後に再生成できます。',true);return;}
  if(stopUnconfirmed){
    if(await modal('前の生成は停止指示を送りましたが、Laylaから停止完了の応答を確認できませんでした。モデルがまだ生成中の場合、再生成すると競合する可能性があります。続行しますか？')!=='yes')return;
    stopUnconfirmed=false;
  }
  if(candidate&&retry&&candidate.text?.trim()){
    if(await modal('今の候補をごみ箱に移して、もう一度生成しますか？')!=='yes')return;
  }
  if(candidate&&!retry){
    const choice=await modal('未採用候補が残っています。ごみ箱に移して新しく生成しますか？');
    if(choice!=='yes')return;
  }
  const requestInput=inputOverride??promptDraft();
  const warning=inputLimitWarning(requestInput,state.prefs);
  if(warning){status(warning,true);updateInputWarning();return;}
  let request,params;
  try{request=buildRequest(state,requestInput);params=samplerParams(state.prefs);}catch(e){status(String(e?.message||e),true);return;}
  if(request.meta.overBudget){status('推定送信予算を超えています。入力上限は約'+request.meta.inputLimit+'文字です。',true);return;}
  const old=candidate,baseFingerprint=bodyFingerprint(state.body);
  retryFallback=old?.text?.trim()?{...old}:null;
  if(old?.text?.trim())state.replyTrash=rememberReply(state.replyTrash,old.text);
  const thisId=++activeId;
  busy=true;stream=null;
  candidate={user:requestInput,text:'',sourceDraft:retry&&old?old.sourceDraft:state.draft,baseFingerprint,note:'生成中…',...((preserveDraft||retry&&old?.preserveDraft)?{preserveDraft:true}:{})};
  state.pendingCandidate=candidate;persist(0);showCandidate('生成中…');lockUI();
  let finished=false,stopResolver=null;
  const aborted=new Promise(resolve=>{stopResolver=resolve;});
  const canUpdate=()=>thisId===activeId&&!finished;
  try{
    if(params.max_tokens===undefined)params.max_tokens=request.meta.outputTokens;
    else params.max_tokens=Math.min(params.max_tokens,request.meta.outputTokens);
    if(request.meta.omitted.length)status('コンテキスト予算により設定の一部を省略しています。設定で内訳を確認できます。');
    stream=host.generate({messages:request.messages,params,
      onText:text=>{
        if(!canUpdate())return;
        if(updateStreamText(candidate,text)){
          state.pendingCandidate=candidate;state.updatedAt=new Date().toISOString();editRev++;
          el('candidate-edit').value=text;
        }
      },onError:error=>{if(canUpdate())status('生成エラー: '+String(error?.message||error),true);}
    });
    activeStop=()=>stopResolver({kind:'stopped'});
    activeGenerationFinished=Promise.resolve(stream.final()).then(value=>({kind:'done',value}),error=>({kind:'error',error}));
    const result=await Promise.race([activeGenerationFinished,aborted]);
    if(!canUpdate())return;
    if(result.kind==='stopped'){
      candidate.note='停止しました。途中までの文章を確認して採用できます。';
    }else if(result.kind==='error'){
      throw result.error;
    }else{
      candidate.text=String(result.value?.text||candidate.text||'').trim();
      const lengthLimited=result.value?.finishReason==='length';
      if(!candidate.text)throw Error('モデルの応答が空です。');
      const forbidden=state.avoidWords.split(/[,、，\n]/).map(t=>t.trim()).filter(Boolean);
      const hit=forbidden.find(t=>candidate.text.includes(t));
      candidate.note=hit?'禁止ワード「'+hit+'」が含まれています。内容を確認してください。':'生成が完了しました。編集・再生成・採用を選べます。';
      if(lengthLimited)candidate.note='出力上限に達したため途中で切れた可能性があります。文章を確認・編集してから採用してください。'+(hit?'／禁止ワード「'+hit+'」を含みます。':'');
      if(state.prefs.autoAdopt&&!hit&&!lengthLimited&&bodyFingerprint(state.body)===baseFingerprint){
        finished=true;busy=false;await useCandidate();return;
      }
    }
    state.pendingCandidate=candidate;retryFallback=null;persist(0);
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
    if(thisId===activeId){finished=true;busy=false;stream=null;activeStop=null;activeGenerationFinished=null;lockUI();showCandidate();}
  }
}
let activeStop=null;
function stopGeneration(){
  if(!busy)return;
  const finalizing=activeGenerationFinished;
  const generationStarted=Boolean(stream||finalizing);
  const requestedAt=Date.now();
  const stopMarker=++activeId;
  try{stream?.abort();}catch(e){status('停止指示のエラー: '+String(e.message||e),true);}
  stopUntil=generationStarted?requestedAt+5000:0; // Ignore late stream callbacks and earlier stop confirmations.
  busy=false;stream=null;lockUI();
  candidate=stoppedCandidate(candidate,retryFallback);
  retryFallback=null;
  state.pendingCandidate=candidate;showCandidate();persist(0);
  if(typeof activeStop==='function'){const cancel=activeStop;activeStop=null;cancel();}
  if(!generationStarted){
    activeGenerationFinished=null;stopUnconfirmed=false;lockUI();
    status('生成開始前に停止しました。');return;
  }
  status('停止指示を送信しました。Laylaの終了応答を確認中です。');
  waitForStop({finalizing,requestedAt,isCurrent:()=>stopMarker===activeId,onRelease:confirmed=>{
    stopUntil=0;activeGenerationFinished=null;
    stopUnconfirmed=!confirmed;lockUI();
    status(confirmed?'Laylaから生成終了の応答を確認しました。':
      '停止完了を確認できませんでした。モデルが推論中の可能性があります。再生成には確認が必要です。',!confirmed);
  }});
}
function clearManualExport(){
  lastExport=null;el('manual-text').value='';el('manual-export').hidden=true;
  el('manual-name').textContent='';el('open-export-manual').hidden=true;
}
function currentManualPage(){
  if(!lastExport)return '';
  const {text,offsets,index}=lastExport;
  return text.slice(offsets[index],offsets[index+1]);
}
function showManualExport(scroll=true){
  if(!lastExport)return;
  const {name,text,mime,warning,offsets,index}=lastExport,total=offsets.length-1;
  el('manual-export').hidden=false;
  el('manual-name').textContent=name+(warning?'／'+warning:'');
  el('manual-page').textContent=(index+1)+' / '+total+' ページ'+(total>1?'（全ページを保存し、復元時はまとめて選択してください）':'');
  el('manual-text').value=currentManualPage();
  el('manual-prev').disabled=index===0;
  el('manual-next').disabled=index===total-1;
  el('download-manual').dataset.name=manualPageName(name,index,total);
  el('download-manual').dataset.mime=total>1?'text/plain':mime;
  if(scroll)el('manual-export').scrollIntoView({block:'nearest'});
}
function presentExport(name,content,mime,result,warning=''){
  clearManualExport();
  const text=manualExportPayload(content,result);
  const needsManual=result.kind==='manual'||result.kind==='unconfirmed';
  if(text!==null){
    lastExport={name,text,mime,warning,offsets:manualPageOffsets(text),index:0};
    el('open-export-manual').hidden=false;
  }
  const alternative=lastExport&&lastExport.offsets.length>2?'／全ページを保存し、読み込み時にまとめて選択してください。':'';
  status((warning?warning+'／':'')+result.message+alternative,Boolean(warning)||needsManual);
  if(needsManual)showManualExport();
}
async function exportAs(ext){
  if(!ready||exporting||branchBusy)return;
  exporting=true;clearManualExport();lockUI();
  try{
    while(bodyEditBackup)await bodyEditBackup;
    commitPendingBodyEdit();
    const snapshot=cleanState(state);
    let {light,mainOnly,json,large,mime,suffix}=exportPlan(ext,snapshot);
    if(large){
      const choice=await modal('分岐を含む大きなバックアップです。端末のメモリを多く使う場合があります。本編のみJSONも選べます。',[['yes','分岐込みで続行'],['main','本編のみJSON'],['no','キャンセル']]);
      if(choice==='main'){ext='main-json';({light,mainOnly,json,large,mime,suffix}=exportPlan(ext,snapshot));}
      else if(choice!=='yes')return;
    }
    let content,warning='';
    if(light||ext==='json'){
      const result=await exportJsonWithFallback(snapshot,async b=>store?(await store.materialize({...snapshot,branches:[b]},b.id)).branches[0]:b,{
        compact:light,maxBytes:TRANSFER_MAX_BYTES,
        confirmMain:async (branch,error)=>{
          showBranches();safety();
          const choice=await modal('分岐「'+branch.name+'」を読み込めず、分岐込みJSONを作成できませんでした。\n'+String(error?.message||error)+'\n本編のみJSONには保存済み分岐'+snapshot.branches.length+'件が一切含まれません。端末内の分岐原本は変更しません。後で整合性チェック・修復をお試しください。',[['main','本編のみJSONを保存'],['cancel','キャンセル']]);
          return choice==='main';
        }
      });
      if(result.cancelled){status('分岐込みJSONの書き出しを中止しました。分岐原本は変更していません。',true);return;}
      content=result.content;
      if(result.mainOnly){suffix='_本編のみ';warning='分岐なしの本編のみJSON（保存済み分岐'+snapshot.branches.length+'件は含まれません）';}
    }
    else if(mainOnly)content=JSON.stringify({...snapshot,branches:[]});
    else content=readableText(snapshot,ext);
    if(json&&(content===null||utf8ByteLength(content)>TRANSFER_MAX_BYTES)){
      backupSizeWarning='50MB超のJSONは再読み込みできないため書き出しを中止しました。軽量JSONまたは本編のみJSONを利用してください。';
      content=null;safety();status(backupSizeWarning,true);return;
    }
    const name=filename(snapshot.title,json?'json':ext,new Date(),suffix);
    const result=await writeFile(host,name,content,mime);
    presentExport(name,content,mime,result,warning);
    if(json&&result.kind==='share'){backupSizeWarning='';safety();}
    if(editRev!==savedRev)void saveNow();
  }catch(e){status('書き出しに失敗しました: '+String(e.message||e)+'。本編のみJSONまたは本文TXTをお試しください。',true);safety();showBranches();}
  finally{exporting=false;lockUI();}
}
async function beforeDestructive(action,{checkpoint=true,scope,branchId}={}){
  if(!store?.hasStorage){status('端末保存ができません。外部JSONバックアップを取ってください。',true);return false;}
  try{
    if(!await saveNow())throw Error('現在の状態を保存できません。');
    if(checkpoint)await store.checkpoint(state,action,{scope,branchId});
    return true;
  }catch(e){
    status('操作前の安全保存に失敗したため中止しました: '+String(e.message||e),true);
    // A failed archive read may have just discovered damage. Expose the
    // repair/isolation controls immediately, without changing the work.
    showBranches();safety();lockUI();
    if(e instanceof CheckpointArchiveUnreadable){
      status('読込不能の分岐があるため中止しました。分岐の整合性チェック・修復または隔離が必要です。',true);
      await modal(String(e.message||e),[['ok','閉じる']]);
    }
    return false;
  }
}
async function handleImport(file){
  if(!file||!ready||busy||branchBusy||bodyBackupBusy||exporting)return;
  branchBusy=true;lockUI();
  try{
    while(bodyEditBackup)await bodyEditBackup;
    commitPendingBodyEdit();
    await runImport(file,{store,getState:()=>state,isSaveBlocked:()=>saveBlocked||Boolean(store?.readOnly),modal,beforeDestructive,
      unlockRecovery:()=>{saveBlocked=false;},
      apply:async next=>{
        resetBodyRecovery();state=next;state.updatedAt=new Date().toISOString();
        candidate=state.pendingCandidate;fullBody=false;paint();rebuildSettings();
        editRev++;if(await saveNow(true))status('ファイルを読み込み保存しました。');
        else status('読み込みましたが保存に失敗しました。外部JSONへ書き出してください。',true);
      }});
  }catch(e){status('読み込みに失敗しました: '+String(e.message||e),true);}
  finally{branchBusy=false;lockUI();}
}
// Keep the last saved work visible until the replacement has been saved.
async function saveStoryReplacement(next){
  const original=state,oldCandidate=candidate,originalRev=editRev;
  let saved=false;
  replacementSaving=true;
  try{
    state=next;candidate=state.pendingCandidate;editRev++;
    saved=await saveNow(true);
    return saved;
  }finally{
    if(!saved){state=original;candidate=oldCandidate;editRev=originalRev;}
    replacementSaving=false;
    if(saved){resetBodyRecovery();fullBody=false;historyOffset=0;}
    paint();rebuildSettings();
  }
}
async function resetStory(){
  if(!ready||busy||branchBusy||bodyBackupBusy||saveBlocked||exporting)return;
  branchBusy=true;lockUI();
  try{
    if(await modal('新しい作品にすると本文・設定・保存済みのすべての分岐が置き換わります。事前にJSONを外部保存してください。')!=='yes')return;
    while(bodyEditBackup)await bodyEditBackup;
    commitPendingBodyEdit();
    if(!await beforeDestructive('reset'))return;
    if(!await saveStoryReplacement(freshState()))status('新しい作品を保存できませんでした。元の作品に戻しました。',true);
  }catch(e){status('新しい作品を作成できません: '+String(e.message||e),true);}
  finally{branchBusy=false;lockUI();}
}
async function restoreCheckpoint(){
  if(!ready||saveBlocked||busy||branchBusy||bodyBackupBusy||exporting)return;
  branchBusy=true;lockUI();
  try{
    while(bodyEditBackup)await bodyEditBackup;
    commitPendingBodyEdit();
    const versions=await store.checkpointList();
    if(!versions.length){status('復元できる以前の保存点はありません。');return;}
    const choices=versions.map((v,i)=>[String(i),String(i+1)+'：'+
      new Date(v.at).toLocaleString('ja-JP')+'／'+(v.title||'無題')+'／'+(v.reason||'保存点')+'／'+(v.scope==='branch'?'削除分岐のみ':v.scope==='active'?'本編のみ':'作品全体')+'／'+(v.chars??'不明')+'文字']);
    choices.push(['cancel','キャンセル']);
    const selection=await modal('復元する時点を選んでください。復元前の現在の状態も保存点に退避します。',choices);
    if(typeof selection!=='string'||!/^\d+$/.test(selection))return;
    const n=Number(selection);
    if(!Number.isSafeInteger(n)||n<0||n>=versions.length)return;
    commitPendingBodyEdit();
    const selected=await store.loadCheckpoint(versions[n].id,state);
    // A full restore replaces all archives; preserve the whole current work first.
    const scope=versions[n].scope;
    // Cross-branch restoration may replace an archived version of that branch.
    // Keep the complete old work in that case, too.
    const crossBranch=scope==='active'&&selected.activeBranch.id!==state.activeBranch.id;
    if(!await beforeDestructive('選択した復元点を開く',{scope:!crossBranch&&(scope==='active'||scope==='branch')?'active':'full'}))return;
    if(await saveStoryReplacement(selected))status('第'+(n+1)+'候補の復元点へ戻しました。');
    else status('復元内容を保存できませんでした。元の作品に戻しました。',true);
  }catch(e){status('復元できません: '+String(e.message||e),true);}
  finally{branchBusy=false;lockUI();}
}
async function recoverChoice(){
  if(!ready||busy||branchBusy||bodyBackupBusy||exporting||!store?.recoveryRequired)return;
  branchBusy=true;lockUI();
  try{
    while(bodyEditBackup)await bodyEditBackup;
    const info=store.recoveryInfo();
  const describe=(name,value)=>name+'：'+(value?value.title+'／'+value.chars+'文字／'+value.turns+'ターン／更新 '+(value.at||'不明'):'読み取り不可');
  const choice=await modal('保存データの衝突です。どちらを採用しますか？\n'+
    describe('SQLite',info.sqlite)+'\n'+describe('IndexedDB',info.idb)+
    (info.omissionConflict?'\n未同期IndexedDBには省略分岐 '+info.omittedCount+' 件があり、全体の採用はできません。SQLiteを採用する前に未同期本編と読込可能な分岐を救出復元点へ保存します。読めない省略分岐は救出復元点に含まれません。自動合併はしません。':'\n選ばなかった側も復元点へ保存します。決められない場合は保留してJSONを書き出してください。'),
    info.omissionConflict?[['sqlite','SQLiteを採用（未同期本編を退避）'],['cancel','保留する']]:[['idb','IndexedDBの退避を使う'],['sqlite','SQLiteの保存を使う'],['cancel','保留する']]);
    if(choice!=='idb'&&choice!=='sqlite')return;
    const recovered=await store.chooseRecovery(choice);
    resetBodyRecovery();state=store.compactState(cleanState(recovered));candidate=state.pendingCandidate;
    saveBlocked=false;saveError='';ready=true;fullBody=false;historyOffset=0;
    editRev++;savedRev=editRev;
    paint();rebuildSettings();lockUI();safety();
    status('指定した保存元から復元・保存しました。設定欄も最新表示に更新しました。');
  }catch(e){
    saveBlocked=true;
    status('復旧に失敗しました。再度選択できます: '+String(e.message||e),true);
    lockUI();safety();
  }finally{branchBusy=false;lockUI();}
}

async function rebuildIdb(){
  if(!store?.canRebuildFromIdb||busy||branchBusy||exporting||bodyBackupBusy)return;
  branchBusy=true;lockUI();
  const omitted=store.rebuildOmittedCount;
  try{
    const detail=omitted?'\n容量制限で省略された分岐 '+omitted+' 件は再作成後の分岐一覧には戻りません。本編と検証済み分岐のみ復元します。旧SQLiteの目録・残存原本と省略分岐の目録は救出用に保持しますが、分岐の完全復元は保証できません。':'';
    if(await modal('検証済みのIndexedDBデータを使ってSQLiteを再作成します。破損した旧SQLite行は救出用に保持します。'+detail+'\n実行しますか？')!=='yes')return;
    const rebuilt=await store.rebuildFromIdb();resetBodyRecovery();state=store.compactState(rebuilt);candidate=state.pendingCandidate;
    saveBlocked=false;saveError='';editRev++;savedRev=editRev;fullBody=false;paint();rebuildSettings();safety();
    status(omitted?'本編と検証済み分岐をSQLiteへ再作成しました。省略分岐 '+omitted+' 件は一覧に戻っていません。旧原本はSQLite生データの分割救出から確認できます。':'IndexedDBからSQLiteを再作成しました。',Boolean(omitted));
  }catch(e){saveBlocked=true;status('SQLiteの再作成に失敗しました: '+String(e.message||e),true);safety();}
  finally{branchBusy=false;lockUI();}
}
async function exportRescuedBody(){
  if(!store||busy||branchBusy||exporting||bodyBackupBusy)return;
  branchBusy=true;clearManualExport();lockUI();
  try{
    const sources=await store.rawBodySources();
    if(!sources.length)throw Error('救出元がありません。');
    const choices=sources.map((key,i)=>`${i+1}: ${key==='active'?'現在のSQLite':key}`).join('\n');
    const selected=await textModal('本編TXT救出：番号を選択してください。\n'+choices,'1',{max:10,multiline:false});
    if(!selected)return;
    const source=sources[Number(selected.text)-1];
    if(!source)throw Error('番号が不正です。');
    const rescued=await store.rawBodyText(source),name=filename('talking-story-rescued-body','txt');
    const result=await writeFile(host,name,rescued.text,'text/plain');
    presentExport(name,rescued.text,'text/plain',result,rescued.partial?'部分救出・欠落や未復号断片あり':'救出原稿の内容は目視で確認してください。');
  }catch(e){status('本編救出に失敗しました: '+String(e.message||e),true);}
  finally{branchBusy=false;lockUI();}
}
async function purgeCorruption(){
  if(!store||busy||branchBusy||bodyBackupBusy||exporting||saveBlocked||store.mode()!=='SQLite')return;
  branchBusy=true;lockUI();
  try{
    if(await modal('古い破損SQLiteデータを永久に削除します。必要な旧データは先に本編TXT救出・SQLite生データ救出で外部保存してください。現在と直前の保存世代・復元点は保持します。削除を実行しますか？',[['yes','古い破損データを削除'],['no','キャンセル']])!=='yes')return;
    if(!await saveNow())throw Error('現在の保存を確認できません。');
    await store.flush();
    const result=await store.purgeCorruptEvidence();
    status('旧破損データの保護を解除しました。削除行 '+result.removed+' 件、目録 '+result.backups+' 件。SQLite内部の空き領域として再利用されます。');
  }catch(e){status('旧破損データの整理を中止しました: '+String(e.message||e),true);}
  finally{branchBusy=false;lockUI();}
}
async function exportRawRows(){
  if(!store||busy||branchBusy||exporting)return;
  branchBusy=true;clearManualExport();lockUI();
  try{
    const keys=await store.rawRowKeys(),pages=Math.ceil(keys.length/10);
    if(!pages){status('救出できるSQLite行がありません。');return;}
    const result=await textModal('SQLite救出用JSON：全'+pages+'ファイル（1ファイル最大10行）。書き出す番号を1〜'+pages+'から指定してください。分岐・旧世代・復元点の原文も含みます。救出中は編集しないでください。','1',{max:10,multiline:false});
    if(!result)return;
    const page=Number(result.text)-1;
    const raw=await store.rawRowPage(keys,page);
    const name=filename('talking-story-raw-rows-'+(page+1)+'-of-'+pages,'json');
    const exported=await writeFile(host,name,raw,'application/json');
    presentExport(name,raw,'application/json',exported);
  }catch(e){status('分割救出に失敗しました: '+String(e.message||e),true);}
  finally{branchBusy=false;lockUI();}
}
async function exportRaw(){
  if(!store||branchBusy||exporting)return;
  exporting=true;clearManualExport();lockUI();
  try{
    const raw=await store.rawDump();
    const name=filename('talking-story-raw-recovery','json');
    const result=await writeFile(host,name,raw,'application/json');
    presentExport(name,raw,'application/json',result);
  }catch(e){status('生データを書き出せません: '+String(e.message||e),true);}
  finally{exporting=false;lockUI();}
}

function textModal(question,initial,{max=15000,multiline=true,options=[['save','保存'],['cancel','キャンセル']]}={}){
  return new Promise(resolve=>{
    const overlay=el('modal'),body=el('modal-content'),buttons=el('modal-buttons');
    overlay.querySelector('.modal-editor')?.remove();overlay.querySelector('.modal-validation')?.remove();
    body.textContent=question;buttons.replaceChildren();
    const editor=node(multiline?'textarea':'input','modal-editor');
    if(!multiline)editor.type='text';
    editor.value=String(initial||'');editor.maxLength=max;
    if(multiline)editor.rows=Math.min(12,Math.max(5,editor.value.split('\n').length+1));
    body.after(editor);
    for(const [value,label] of options){
      const button=node('button',value==='save'||value==='generate'?'primary':'ghost',label);
      button.onclick=()=>{
        if(value!=='cancel'&&!editor.value.trim()){
          let warning=overlay.querySelector('.modal-validation');
          if(!warning){warning=node('p','modal-validation safety error');editor.after(warning);}
          warning.textContent='入力内容が空です。';editor.focus();return;
        }
        overlay.hidden=true;editor.remove();overlay.querySelector('.modal-validation')?.remove();
        resolve(value==='cancel'?null:{action:value,text:editor.value});
      };
      buttons.append(button);
    }
    overlay.hidden=false;
    overlay.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();overlay.hidden=true;editor.remove();
      overlay.querySelector('.modal-validation')?.remove();resolve(null);}};
    editor.focus();
  });
}
async function applyStoryChange(transform,note,{destructive=false,checkpointScope,branchId,checkpointReason}={}){
  if(!ready||busy||branchBusy||bodyBackupBusy||saveBlocked)return false;
  branchBusy=true;lockUI();
  commitPendingBodyEdit();
  const original=state,oldCandidate=candidate;
  try{
    if(!await beforeDestructive(checkpointReason??(checkpointScope==='branch'?'分岐削除前':'分岐操作'),{checkpoint:destructive,scope:checkpointScope,branchId}))return false;
    const changed=await transform(original);
    if(!changed||typeof changed!=='object')throw Error('変更後の状態が不正です。');
    if(changed.activeBranch.id!==original.activeBranch.id)resetBodyRecovery();
    else if(changed.body!==original.body){
      // Undo/regeneration already preserve the reply in trash. Reset deletion
      // baseline but do not consume a new session checkpoint on each trial.
      bodyRecovery.reset();bodyRecovery.seed(changed);recoveryEpoch++;
    }
    state=changed;candidate=state.pendingCandidate;
    state.updatedAt=new Date().toISOString();editRev++;
    if(!await saveNow(true)){
      state=original;candidate=oldCandidate;paint();
      status('変更内容を保存できませんでした。元の画面に戻しました。',true);
      return false;
    }
    historyOffset=0;fullBody=false;paint();
    status(note);
    return true;
  }catch(e){
    state=original;candidate=oldCandidate;paint();
    status('操作を中止しました: '+String(e?.message||e),true);return false;
  }finally{branchBusy=false;lockUI();}
}
async function actOnTurn(index,action){
  if(!ready||busy||branchBusy||saveBlocked)return;
  let turn=null;
  try{turn=timelineAt(state,index);}catch(e){status('このターンは操作できません: '+String(e.message||e),true);return;}
  if(action==='user'){
    const decision=await textModal(
      '第'+(index+1)+'ターン：あなたの送信内容を編集します。\n元のストーリーは別分岐に残し、この入力から新しい展開を作ります。',
      editableTurnInput(turn.user),{max:15000,options:[['generate','変更して再生成'],['draft','入力欄に戻す'],['cancel','キャンセル']]}
    );
    if(!decision)return;
    if(await applyStoryChange(s=>editUserAt(s,index,decision.text),'過去の入力を編集した分岐を作成しました')){
      showMain({scroll:false});
      if(decision.action==='generate'){
        el('prompt-section').scrollIntoView({block:'start'});
        await startGeneration({inputOverride:decision.text.trim()});
      }
      else{el('user-input').focus();el('prompt-section').scrollIntoView({block:'start'});}
    }
    return;
  }
  if(action==='reply'){
    const decision=await textModal(
      '第'+(index+1)+'ターン：LLMの返信を編集します。\n元の後続ターンは元の分岐に保持され、新分岐ではこの返信を確定します。',
      turn.reply,{max:BODY_LIMIT,options:[['save','編集して分岐保存'],['cancel','キャンセル']]}
    );
    if(!decision)return;
    if(await applyStoryChange(s=>editReplyAt(s,index,decision.text),'過去の返信を編集した分岐を作成しました'))
      showMain();
    return;
  }
  if(action==='regenerate'){
    await regenerateTurn({index,turn,state,modal,applyStoryChange,regenerateAt,showMain,
      scrollPrompt:()=>el('prompt-section').scrollIntoView({block:'start'}),startGeneration});
    return;
  }
  if(action==='undo'){
    if(await modal('直前のターンを取り消しますか？\n返信と未採用候補はごみ箱に移します。分岐は増えません。')!=='yes')return;
    if(await applyStoryChange(s=>rewindLastWithoutFork(s),'直前のターンを取り消しました。返信は設定のごみ箱にあります。'))showMain();
    return;
  }
  if(action==='rewind'||action==='restart'){
    const label=action==='restart'?'第1ターンの前':'第'+(index+1)+'ターン'+(action==='rewind'?'終了時':'開始前');
    if(await modal(label+'に戻りますか？\n以降の展開は削除せず、元の分岐として保存します。')!=='yes')return;
    const changed=await applyStoryChange(s=>
      action==='restart'?forkAt(s,{index:0,after:false,label:'第1ターンの前からやり直す'}):
      rewindAfter(s,index),
    '指定位置へ戻した分岐を作成しました');
    if(changed){showMain({scroll:false});el('prompt-section').scrollIntoView({block:'start'});}
  }
}
async function branchAction(action,id){
  if(!ready||busy||branchBusy||saveBlocked)return;
  const found=id===state.activeBranch?.id?state.activeBranch:state.branches.find(b=>b.id===id);
  if(!found){status('分岐が見つかりません。',true);return;}
  if(action==='isolate'||action==='repair'){
    if(await modal(action==='isolate'?'読めない分岐を一覧から外します。破損原本は救出用に保持します。続行しますか？':'検証済みの健全なコピーから分岐を修復します。旧原本は救出用に保持します。続行しますか？')!=='yes')return;
    branchBusy=true;lockUI();
    try{
      if(!await saveNow())throw Error('本編の保存に失敗しました。');
      state=await (action==='isolate'?store.isolateArchive(state,id):store.repairArchive(state,id));
      integrityResults.delete(id);paint();
      status(action==='isolate'?'分岐を隔離しました。':'分岐の修復保存を行いました。再チェックで両保存先を確認してください。');
    }catch(e){status(e.message,true);showBranches();safety();}
    finally{branchBusy=false;lockUI();}
    return;
  }
  if(action==='switch'){
    const selection=await modal('「'+found.name+'」に切り替えます。人物設定・世界観・自由記憶・ユーザー設定はどうしますか？\n生成パラメータは常に現在の値を引き継ぎます。',
      [['branch','切替先分岐の設定を使用'],['inherit','現在の設定を引き継ぐ'],['cancel','キャンセル']]);
    if(selection!=='branch'&&selection!=='inherit')return;
    if(await applyStoryChange(async s=>switchBranch(await store.materialize(s,id),id,{inheritLore:selection==='inherit'}),'分岐を切り替えました'))showMain();
  }else if(action==='rename'){
    const result=await textModal('分岐の名前を編集します。',found.name,{max:90,multiline:false});
    if(result)await applyStoryChange(async s=>store.renameStoredBranch(s,id,result.text),'分岐名を変更しました');
  }else if(action==='delete'){
    if(await modal('保存されている分岐「'+found.name+'」を削除しますか？\n現在の分岐は削除しません。削除前の状態は復元点へ保存しますが、外部JSONバックアップも推奨します。')!=='yes')return;
    await applyStoryChange(s=>deleteInactiveBranch(s,id),'指定分岐を削除しました',{destructive:true,checkpointScope:'branch',branchId:id});
  }
}

function setup(){
  app.innerHTML=
    '<header><div class="bar"><img class="logo" src="./icon.jpg" alt="緑の時計"><div class="titles"><div class="subtitle">LAYLA MINI-APP · LOCAL STORY</div><div class="brand" id="title-view">新しい物語</div></div><span class="badge">物語</span></div>'+
    '<div id="status" class="status" role="status" aria-live="polite">データ読み込み中…</div></header>'+
    '<main><div id="status-detail" class="safety error" hidden></div><div id="safety" class="safety error" role="alert">初期化中</div><button id="recover-now" hidden class="small warn">復旧元を選択</button><button id="open-export-manual" hidden class="small ghost">共有できない場合：手動で救出</button><div id="screen-main">'+
    '<section class="panel"><div class="split" style="justify-content:space-between"><h2>確定した物語</h2><span class="mini" id="counter"></span></div><p id="meta" class="hint"></p><div class="story" id="body-view"></div><div class="actions"><button id="view-full">全文を表示</button><button id="jump-bottom">入力欄へ移動</button><button id="undo">直前のターンを取り消す</button></div></section>'+
    '<section class="panel" id="prompt-section"><h2>あなたの台詞・行動</h2><p class="hint">本人が話す台詞・取る行動、次の場面の希望を記入してください。</p><textarea id="user-input" rows="5" maxlength="15000" placeholder="例：『おはよう』と笑って、隣に座る。"></textarea><p id="input-warning" class="safety" role="alert" hidden></p><div class="actions"><button id="generate" class="primary">続きを生成</button><button id="stop" class="warn" disabled>生成停止</button></div><div id="candidate-box" hidden><label for="candidate-edit">未採用の候補（編集可能）</label><textarea id="candidate-edit" rows="9"></textarea><p id="candidate-status" class="hint"></p><div class="actions"><button id="accept" class="primary">この文章を採用</button><button id="retry">もう一度生成</button><button id="discard" class="warn">破棄</button></div></div></section>'+
    '<section class="panel" id="history-section"><details><summary>会話履歴を編集・再生成・巻き戻す</summary><p class="hint">本文の軽い手直しでは履歴位置を自動補正します。複数ターンを一度に書き換えた場合は、復元点作成後に履歴をリセットできます。</p><button id="reset-history" class="small warn">本文を保持して履歴だけ再設定</button><div class="history-toolbar"><button id="turn-older" class="small ghost">前の30件</button><span id="turn-range" class="hint"></span><button id="turn-newer" class="small ghost">次の30件</button></div><div class="history-toolbar"><label for="turn-number">ターン番号</label><input id="turn-number" type="number" inputmode="numeric" min="1" placeholder="番号"><button id="turn-go" class="small ghost">移動</button><button id="turn-start" class="small warn">第1ターンの前に戻す</button></div><div id="turn-log" class="history-log"></div></details></section><section class="panel" id="branches-section"><h2>ストーリー分岐</h2><p class="hint">元の展開はここからいつでも開けます。分岐ごとの本文・設定・記憶・下書きを保存します。</p><strong id="branch-current"></strong><p id="branch-count" class="hint"></p><div id="branch-list"></div></section></div>'+
    '<div id="screen-settings" hidden><section class="panel"><h2>作品設定</h2><p class="hint">日本語の文章と [海:名称≡&lt;虎田海&gt;] 形式は混在できます。</p><div id="settings-fields"></div></section>'+
    '<section class="panel"><h2>生成設定</h2><div id="preference-fields"></div><p class="hint" id="prompt-meta"></p></section>'+
    '<section class="panel"><h2>確定本文の編集</h2><p class="hint">ここが正本です。長編の場合は編集前にJSONをバックアップしてください。</p><p id="edit-count" class="hint"></p><p id="edit-warning" class="safety" hidden>本文を大きく削除しました。誤操作であれば、直ちに「直前の状態を復元」を利用してください。</p><textarea id="edit-body" class="long" rows="12"></textarea></section>'+
    '<section class="panel"><h2>返信のごみ箱</h2><p class="hint">直近20件まで（合計150万文字目安。超過時は古い返信から整理）。復元は未採用候補として行い、現在の本文を上書きしません。</p><div id="reply-trash"></div></section>'+
    '<section class="panel"><h2>バックアップ・復元</h2><div class="actions"><button id="check-integrity">分岐の整合性チェック</button><button id="rescue-unsaved">未保存編集の救出JSON</button></div><p id="integrity-status" class="hint">'+INTEGRITY_HINT+'</p><p class="hint">JSONは設定・自由記憶・本文・履歴を保存。TXTとMDは本文用。保存先はiOS「ファイル」で確認してください。</p><div class="actions"><button id="export-json" class="primary">全データ JSON</button><button id="export-light-json">軽量JSON（分岐共有）</button><button id="export-main-json">本編のみJSON（分岐なし）</button><button id="export-txt">本文 TXT</button><button id="export-md">本文 MD</button></div><div class="actions"><button id="import">ファイルを読み込む（分割は全ページ）</button><button id="restore">直前の状態を復元</button><button id="new-story" class="warn">新しい作品</button></div><div class="actions"><button id="recover">復旧元を選択</button><button id="raw-body">SQLite本編TXT救出</button><button id="raw-backup">本編生データの簡易救出</button><button id="raw-rows">SQLite生データの分割救出</button><button id="rebuild-idb" class="warn">IndexedDBからSQLiteを再作成</button><button id="purge-corrupt" class="warn">古い破損データを削除</button></div><input id="file-picker" type="file" accept=".json,.txt,.md" multiple hidden></section></div>'+
    '<section class="panel" id="manual-export" hidden><h3>緊急書き出し</h3><p id="manual-name" class="hint"></p><p id="manual-page" class="hint"></p><p class="hint">コピー・ページの保存・通常ブラウザでのダウンロードが可能です。分割JSONは全ページを順番に連結してから読み込んでください。Layla内では保存されたか必ず確認してください。</p><textarea id="manual-text" rows="6" readonly></textarea><div class="actions"><button id="manual-prev">前のページ</button><button id="manual-next">次のページ</button><button id="copy-manual">このページをコピー</button><button id="save-manual-page">このページをファイル保存</button><button id="download-manual">ブラウザ用ダウンロード</button><button id="close-manual">閉じる</button></div></section>'+
    '</main><nav class="nav"><button class="primary" id="nav-main">本文へ戻る</button><button id="nav-settings">設定</button><button id="quick-backup">JSON保存</button></nav>'+
    '<div id="modal" class="overlay" hidden role="dialog" aria-modal="true"><div class="modal-card"><p id="modal-content"></p><div id="modal-buttons" class="actions"></div></div></div>';
  el('nav-main').onclick=()=>showMain();el('nav-settings').onclick=showSettings;
  el('quick-backup').onclick=()=>void exportAs('json');
  el('generate').onclick=()=>void startGeneration();
  el('stop').onclick=stopGeneration;
  el('accept').onclick=()=>void useCandidate();
  el('retry').onclick=()=>void startGeneration({retry:true,inputOverride:candidate?.user});
  el('discard').onclick=async()=>{
    if(await modal('未採用の生成文を破棄しますか？')!=='yes')return;
    state.replyTrash=rememberReply(state.replyTrash,candidate?.text);candidate=null;state.pendingCandidate=null;persist(0);showCandidate();status('候補をごみ箱へ移しました。');
  };
  el('candidate-edit').oninput=e=>{if(!candidate||busy)return;candidate.text=e.target.value;state.pendingCandidate=candidate;persist();};
  el('user-input').oninput=e=>{state.draft=e.target.value;persist();};
  el('undo').onclick=()=>void actOnTurn(state.turns.length-1,'undo');
  el('turn-older').onclick=()=>{historyOffset++;showHistory();lockUI();};
  el('turn-newer').onclick=()=>{historyOffset=Math.max(0,historyOffset-1);showHistory();lockUI();};
  el('turn-go').onclick=()=>{
    const number=Number(el('turn-number').value);
    if(!Number.isInteger(number)||number<1||number>state.turns.length){status('1〜'+state.turns.length+'のターン番号を指定してください。',true);return;}
    historyOffset=Math.floor((state.turns.length-number)/HISTORY_PAGE_SIZE);showHistory();lockUI();
  };
  el('turn-start').onclick=()=>void actOnTurn(0,'restart');
  el('view-full').onclick=()=>{fullBody=!fullBody;paint();};
  el('jump-bottom').onclick=()=>el('prompt-section').scrollIntoView({block:'start'});
  el('export-json').onclick=()=>void exportAs('json');
  el('export-light-json').onclick=()=>void exportAs('compact-json');
  el('export-main-json').onclick=()=>void exportAs('main-json');
  el('export-txt').onclick=()=>void exportAs('txt');
  el('export-md').onclick=()=>void exportAs('md');
  el('import').onclick=()=>el('file-picker').click();
  el('file-picker').onchange=e=>{const files=Array.from(e.target.files||[]);e.target.value='';if(files.length)void handleImport(files);};
  el('new-story').onclick=()=>void resetStory();
  el('restore').onclick=()=>void restoreCheckpoint();
  el('recover').onclick=()=>void recoverChoice();
  el('recover-now').onclick=()=>void recoverChoice();
  el('reset-history').onclick=async()=>{
    if(!state.turns.length)return;
    if(await modal('現在の本文は保持し、送信履歴だけ削除します。元の履歴は復元点に保存します。続行しますか？')!=='yes')return;
    if(await applyStoryChange(s=>clearHistoryAgainstBody(s),'本文を保持して履歴をリセットしました。',{destructive:true,checkpointReason:'履歴リセット前'}))rebuildSettings();
  };
  el('check-integrity').onclick=()=>void runIntegrityCheck();
  el('rescue-unsaved').onclick=async()=>{
    if(!ready||!store||exporting||busy||branchBusy||bodyBackupBusy)return;
    exporting=true;lockUI();
    try{
      const record=await store.readStashedActive();
      if(!record){status('救出用の未保存編集はありません。');return;}
      const name='unsaved-active-'+record.at+'.json',content=JSON.stringify(record.state),mime='application/json';
      const result=await writeFile(host,name,content,mime);
      presentExport(name,content,mime,result,'救出用本編のみ（分岐を含まない）');
    }catch(e){status('未保存編集の救出失敗: '+e.message,true);}
    finally{exporting=false;lockUI();}
  };
  el('raw-body').onclick=()=>void exportRescuedBody();
  el('purge-corrupt').onclick=()=>void purgeCorruption();
  el('raw-backup').onclick=()=>void exportRaw();
  el('raw-rows').onclick=()=>void exportRawRows();
  el('rebuild-idb').onclick=()=>void rebuildIdb();
  el('close-manual').onclick=clearManualExport;
  el('open-export-manual').onclick=()=>showManualExport();
  el('manual-prev').onclick=()=>{if(lastExport&&lastExport.index>0){lastExport.index--;showManualExport(false);}};
  el('manual-next').onclick=()=>{if(lastExport&&lastExport.index<lastExport.offsets.length-2){lastExport.index++;showManualExport(false);}};
  el('save-manual-page').onclick=async()=>{
    if(!lastExport)return;
    const button=el('save-manual-page');
    if(button.disabled)return;
    const name=el('download-manual').dataset.name,mime=el('download-manual').dataset.mime;
    const text=currentManualPage();
    button.disabled=true;
    try{const result=await writeFile(host,name,text,mime);status(result.message,result.kind==='manual'||result.kind==='unconfirmed');}
    catch(e){status('ページ保存失敗：'+e.message,true);}
    finally{button.disabled=false;}
  };
  el('download-manual').onclick=()=>{
    const name=el('download-manual').dataset.name||'story.txt';
    const mime=el('download-manual').dataset.mime||'text/plain';
    const blob=new Blob([currentManualPage()],{type:mime+';charset=utf-8'});
    if(browserDownload(name,blob))status('ブラウザにダウンロードを指示しました。実際の保存を確認してください。');
    else status('この環境ではダウンロードできません。コピーで救出してください。',true);
  };
  el('copy-manual').onclick=async()=>{
    const area=el('manual-text');area.focus();area.select();
    try{await navigator.clipboard.writeText(currentManualPage());status('コピーしました。ファイルに保存してください。');}
    catch{status('テキストを選択しました。コピー操作をしてください。',true);}
  };
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='hidden'&&ready&&!replacementSaving){state.pendingCandidate=candidate;void saveNow(Boolean(busy&&candidate));}
    else if(document.visibilityState==='visible'&&ready&&!busy&&!branchBusy&&!bodyBackupBusy)void ensurePeriodicCheckpoint().then(()=>safety());
  });
  window.addEventListener('pagehide',()=>{if(ready&&!replacementSaving){state.pendingCandidate=candidate;void saveNow(Boolean(busy&&candidate));}});
  // Stream chunks only mark dirty; write a bounded-rate snapshot while active.
  setInterval(()=>{
    if(!ready||!busy||!candidate||saveBlocked||streamSaveInFlight||editRev===savedRev)return;
    streamSaveInFlight=true;void saveNow().finally(()=>{streamSaveInFlight=false;});
  },5000);
  // Only the daily active-work checkpoint runs automatically; archive checks are manual.
  setInterval(()=>{
    if(ready&&document.visibilityState==='visible'&&!busy&&!branchBusy&&!bodyBackupBusy)
      void ensurePeriodicCheckpoint().then(()=>safety());
  },60000);
  el('modal').hidden=true;paint();
}
async function init(){
  setup();lockUI();
  try{
    store=await openStore(host,(message,isError=false)=>status(message,isError),{validator:cleanState,lazyArchives:true});
    if(store.initial){
      try{state=cleanState(store.initial);}
      catch(e){saveBlocked=true;saveError='データ読み込みエラー: '+e.message;ready=true;paint();safety();return;}
    }
    candidate=state.pendingCandidate;
    if(candidate){
      if(!candidate.text?.trim()){candidate=null;state.pendingCandidate=null;}
      else if(candidate.note?.includes('生成中'))candidate.note='中断前に保存された未採用候補です。確認してください。';
    }
    saveBlocked=store.readOnly||!store.hasStorage;
    ready=true;
    if(store.recoveryRequired){
      saveError='SQLiteとIndexedDBの編集が衝突しています。上部の「復旧元を選択」から保存元を選んでください。';
      status(saveError,true);
      paint();el('recover').disabled=false;el('nav-settings').disabled=false;
    }else{
      paint();
      if(saveBlocked){saveError=store.problem||'永続保存不可。JSON書き出しを行ってください。';status(saveError,true);}
      else status('準備完了。保存先：'+store.mode());
    }
    safety();
    if(!saveBlocked&&!store.recoveryRequired)setTimeout(()=>void ensurePeriodicCheckpoint().then(()=>safety()),0);
  }catch(e){
    ready=true;saveBlocked=true;saveError='初期化に失敗: '+String(e.message||e);
    status(saveError,true);paint();safety();
  }
}
void init();
