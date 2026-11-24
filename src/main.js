import {makeRuntime} from './runtime.js';
import {FIELDS,LIMITS,BODY_LIMIT,TRANSFER_MAX_BYTES,cleanState,freshState,warningsForState,buildRequest,samplerParams,parseImport,readableText,compactBackup,acceptTurn,bodyFingerprint} from './logic.js';
import {openStore} from './persistence.js';
import {timeline,timelineAt,forkAt,rewindAfter,rewindBefore,editUserAt,editReplyAt,regenerateAt,switchBranch,renameBranch,deleteInactiveBranch,reconcileBodyEdit,clearHistoryAgainstBody,rewindLastWithoutFork,MAX_ARCHIVED_BRANCHES} from './branches.js';
import {writeFile,filename,browserDownload} from './export.js';
import './style.css';

const app=document.getElementById('app'),host=makeRuntime(),el=id=>document.getElementById(id);
const node=(tag,cls,value)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(value!==undefined)e.textContent=value;return e;};
let state=freshState(),store=null,ready=false,saveBlocked=true,busy=false,stream=null,activeId=0;
let candidate=null,saveTimer=null,fullBody=false,saveError='',backupSizeWarning='',notice='',lastAcceptedMessage='';
let lastExport=null,pendingBodyEdit=null,bodyEditTimer=null;
let historyOffset=0,branchBusy=false,bodyBackupBusy=false,editRev=0,savedRev=0,stopUntil=0,retryFallback=null;
const HISTORY_PAGE_SIZE=30;
const promptDraft=()=>state.draft.trim()||'この場面を自然に続きを進める';
function status(text,error=false){
  notice=text||'';
  const e=el('status');if(e){e.textContent=notice;e.className='status'+(error?' error':'');}
}
function safety(text=''){
  const warnings=ready?warningsForState(state):[];
  const problem=[text,saveError,backupSizeWarning,saveBlocked?'保存停止中。JSON書き出しで現状を退避し、復旧元を確認してください。':''].filter(Boolean).join('／');
  const n=el('safety');
  n.hidden=!problem&&!warnings.length;
  n.textContent=[problem,...warnings].filter(Boolean).join('／');
  n.className='safety'+(problem?' error':'');
}
function lockUI(){
  const disabled=!ready||busy||branchBusy||bodyBackupBusy||saveBlocked;
  const cooling=Date.now()<stopUntil;
  for(const id of ['generate','new-story','restore','user-input'])
    if(el(id))el(id).disabled=disabled||(id==='generate'&&cooling);
  el('nav-settings').disabled=!ready||busy||branchBusy||bodyBackupBusy;
  el('nav-main').disabled=!ready||branchBusy||bodyBackupBusy;
  el('import').disabled=!ready||busy||branchBusy||bodyBackupBusy||Boolean(store?.recoveryRequired);
  if(el('recover'))el('recover').disabled=!ready||!store?.recoveryRequired;
  if(el('recover-now')){el('recover-now').hidden=!store?.recoveryRequired;el('recover-now').disabled=!ready||busy;}
  if(el('raw-backup'))el('raw-backup').disabled=!ready;
  if(el('reset-history'))el('reset-history').disabled=disabled;
  for(const input of el('screen-settings').querySelectorAll('input:not([type=file]),textarea,select'))input.disabled=saveBlocked||busy||branchBusy;
  el('stop').disabled=!busy;
  for(const id of ['accept','retry','discard','candidate-edit'])if(el(id))
    el(id).disabled=disabled||!candidate||(id==='accept'&&!candidate?.text?.trim())||(id==='retry'&&cooling);
  el('undo').disabled=disabled||!state.turns.length;
  for(const button of el('screen-main').querySelectorAll('[data-branch-action]'))
    button.disabled=disabled||button.dataset.invalidAction==='1';
  for(const id of ['turn-go','turn-start'])if(el(id))el(id).disabled=disabled||!state.turns.length;
  for(const id of ['turn-older','turn-newer'])if(el(id))el(id).disabled=disabled||el(id).dataset.pageDisabled==='1';
  for(const id of ['export-json','export-light-json','export-txt','export-md','quick-backup'])
    if(el(id))el(id).disabled=!ready; // Export is allowed even in read-only recovery.
}
function persist(delay=600){
  state.updatedAt=new Date().toISOString();
  editRev++;
  // Full validation of all branches on every keystroke is expensive.
  if(el('safety'))el('safety').hidden=!saveError&&!saveBlocked;
  if(el('screen-settings')&&!el('screen-settings').hidden)schedulePromptMeta();
  if(saveBlocked){status('現在は未保存です。復旧確認または外部JSONバックアップが必要です。',true);return;}
  clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>{saveTimer=null;void saveNow();},delay);
  status('編集中… 自動保存待機');
}
async function saveNow(force=false){
  commitPendingBodyEdit();
  clearTimeout(saveTimer);saveTimer=null;
  if(!store||saveBlocked){safety();return false;}
  if(!force&&editRev===savedRev)return true;
  const revision=editRev;
  try{
    await store.save(state);
    savedRev=Math.max(savedRev,revision);
    saveError=store.backupWarning||'';
    status(saveError||'保存済み（'+store.mode()+'）',Boolean(saveError));
    safety();return true;
  }catch(e){
    saveError='保存失敗: '+String(e?.message||e);
    status(saveError,true);safety();return false;
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
  if(!total){root.append(node('p','hint','まだ採用済みの対話履歴はありません。'));return;}
  let positions=null,problem='';
  try{positions=timeline(state);}catch(e){problem=String(e.message||e);}
  if(problem){
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
  if(!state.branches.length){target.append(node('p','hint','まだ分岐はありません。過去の返信を編集・再生成・Undoすると、元の展開がここに保存されます。'));return;}
  for(const b of state.branches.slice().reverse()){
    const row=node('div','branch-row'),summary=node('div','branch-summary');
    summary.append(node('strong','',b.name));
    summary.append(node('div','hint',b.turns.length+'ターン・本文'+b.body.length.toLocaleString('ja-JP')+'文字'));
    const actions=node('div','actions branch-actions');
    actions.append(
      actionButton('この分岐を開く',()=>branchAction('switch',b.id)),
      actionButton('名前変更',()=>branchAction('rename',b.id)),
      actionButton('削除',()=>branchAction('delete',b.id))
    );
    row.append(summary,actions);target.append(row);
  }
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
function showMain(){
  if(!ready||branchBusy||bodyBackupBusy)return;
  commitPendingBodyEdit();
  el('screen-main').hidden=false;el('screen-settings').hidden=true;
  el('nav-main').classList.add('primary');el('nav-settings').classList.remove('primary');
  paint();if(editRev!==savedRev)void saveNow();
  window.scrollTo(0,0);
}
function showSettings(){
  if(!ready||busy||branchBusy)return;
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
  [['autoAdopt','正常生成時は自動採用する（既定OFF）'],['includeInput','ユーザーの入力を自然に物語へ反映させる'],['recordInputInBody','ユーザーの入力原文を確定本文にも併記する（既定OFF）']].forEach(([key,label])=>{
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
  el('edit-warning').hidden=true;
  el('edit-warning').textContent='本文を大幅変更しました。元の本文は復元点に保存されています。';
  const count=el('edit-count');count.textContent=state.body.length+' / '+BODY_LIMIT+'文字';
  let preDeletePromise=null,lastProtectedBody=null,inputSerial=0;
  edit.oninput=async()=>{
    const serial=++inputSerial;
    const text=edit.value;
    const bigDeletion=text.length<state.body.length*0.5&&state.body.length>500;
    if(bigDeletion){
      el('edit-warning').hidden=false;
      if(lastProtectedBody!==state.body&&!preDeletePromise){
        bodyBackupBusy=true;lockUI();
        preDeletePromise=store.checkpoint(state,'本文を大きく削除する前');
      }
      if(preDeletePromise){
        try{
          await preDeletePromise;lastProtectedBody=state.body;
        }catch(e){
          edit.value=state.body;pendingBodyEdit=null;
          status('削除前の復元点を作れなかったため変更を取り消しました: '+e.message,true);
          bodyBackupBusy=false;preDeletePromise=null;lockUI();return;
        }
        bodyBackupBusy=false;preDeletePromise=null;lockUI();
      }
    }
    if(serial!==inputSerial)return; // an older async input must not overwrite a newer keystroke
    pendingBodyEdit=edit.value;
    count.textContent=pendingBodyEdit.length+' / '+BODY_LIMIT+'文字';
    clearTimeout(bodyEditTimer);
    bodyEditTimer=setTimeout(commitPendingBodyEdit,330);
  };
  edit.onblur=()=>{if(!bodyBackupBusy)commitPendingBodyEdit();};
  updatePromptMeta();
}
function commitPendingBodyEdit(){
  clearTimeout(bodyEditTimer);bodyEditTimer=null;
  if(pendingBodyEdit===null)return;
  const text=pendingBodyEdit;pendingBodyEdit=null;
  try{
    state=reconcileBodyEdit(state,text);
    // A successful history reconciliation must not hide a deletion warning.
  }catch(e){
    state.body=text;state.undo=null;
    el('edit-warning').hidden=false;
    el('edit-warning').textContent='本文は保持しましたが履歴の再設定が必要です。 '+e.message;
  }
  if(el('edit-count'))el('edit-count').textContent=state.body.length+' / '+BODY_LIMIT+'文字';
  persist();
}
function updatePromptMeta(){
  const m=buildRequest(state,promptDraft()).meta;
  el('prompt-meta').textContent='送信予算の目安：約'+m.estimatedTokens+'トークン／設定コンテキスト'+m.contextTokens+
    '（出力予約'+m.outputTokens+'）。省略した項目：'+(m.omitted.length?m.omitted.map(x=>x.title).join('、'):'なし')+
    '。本文の古い部分：'+m.bodyOmitted+'文字省略。'+
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
async function startGeneration({retry=false,inputOverride=null}={}){
  if(busy||bodyBackupBusy||saveBlocked||!ready)return;
  if(Date.now()<stopUntil){status('前の生成の停止処理中です。数秒後にもう一度操作してください。',true);return;}
  if(candidate&&retry&&candidate.text?.trim()){
    if(await modal('今の候補は保存されていません。破棄してもう一度生成しますか？')!=='yes')return;
  }
  if(candidate&&!retry){
    const choice=await modal('未採用候補が残っています。候補を破棄して新しく生成しますか？');
    if(choice!=='yes')return;
  }
  const requestInput=inputOverride??promptDraft();
  const old=candidate,baseFingerprint=bodyFingerprint(state.body);
  retryFallback=old?.text?.trim()?{...old}:null;
  const thisId=++activeId;
  busy=true;stream=null;
  candidate={user:requestInput,text:'',sourceDraft:retry&&old?old.sourceDraft:state.draft,baseFingerprint,note:'生成中…'};
  state.pendingCandidate=candidate;persist(0);showCandidate('生成中…');lockUI();
  let finished=false,stopResolver=null;
  const aborted=new Promise(resolve=>{stopResolver=resolve;});
  const canUpdate=()=>thisId===activeId&&!finished;
  try{
    const request=buildRequest(state,requestInput),params=samplerParams(state.prefs);
    if(params.max_tokens===undefined)params.max_tokens=request.meta.outputTokens;
    else params.max_tokens=Math.min(params.max_tokens,request.meta.outputTokens);
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
      if(state.prefs.autoAdopt&&!hit&&bodyFingerprint(state.body)===baseFingerprint){
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
    if(thisId===activeId){finished=true;busy=false;stream=null;activeStop=null;lockUI();showCandidate();}
  }
}
let activeStop=null;
function stopGeneration(){
  if(!busy)return;
  try{stream?.abort();}catch{}
  stopUntil=Date.now()+1800;
  setTimeout(()=>lockUI(),1850);
  activeId++; // Ignore late stream callbacks from the cancelled generation.
  busy=false;stream=null;lockUI();
  let retryFallbackWasUsed=false;
  if(!candidate?.text?.trim()){
    retryFallbackWasUsed=Boolean(retryFallback?.text?.trim());
    candidate=retryFallbackWasUsed?retryFallback:null;
  }
  retryFallback=null;
  if(candidate){
    if(retryFallbackWasUsed)candidate.note=(candidate.note||'')+'／再生成を停止して前の候補に戻しました。';
    else candidate.note='停止しました。途中までの文章を採用するか編集できます。';
  }
  state.pendingCandidate=candidate;showCandidate();persist(0);
  if(typeof activeStop==='function'){const cancel=activeStop;activeStop=null;cancel();}
  status('停止しました。');
}
async function exportAs(ext){
  if(!ready)return;
  try{
    const light=ext==='compact-json';
    const content=light?compactBackup(state):ext==='json'?JSON.stringify(state):readableText(state,ext);
    const tooLarge=(ext==='json'||light)&&new TextEncoder().encode(content).length>TRANSFER_MAX_BYTES;
    backupSizeWarning=tooLarge?'このJSONは50MB超で再読み込みできません。軽量JSONや分岐整理後の再保存が必要です。':'';
    safety();
    const name=filename(state.title+(light?'_軽量分岐':''),light?'json':ext);
    const mime=(ext==='json'||light)?'application/json':ext==='md'?'text/markdown':'text/plain';
    const result=await writeFile(host,name,content,mime);
    lastExport={name,text:content,mime};
    el('open-export-manual').hidden=false;
    status((backupSizeWarning?backupSizeWarning+'／':'')+result.message,tooLarge||result.kind==='manual'||result.kind==='unconfirmed');
    if(result.kind==='manual'){
      el('manual-export').hidden=false;el('manual-name').textContent=name;
      el('manual-text').value=result.text;el('download-manual').dataset.name=name;
      el('download-manual').dataset.mime=mime;
      el('manual-export').scrollIntoView({block:'nearest'});
    }
    if(editRev!==savedRev)void saveNow(); // Never overwrite an identical saved generation.
  }catch(e){status('書き出しに失敗しました: '+String(e.message||e),true);}
}
async function beforeDestructive(action,{checkpoint=true}={}){
  if(!store?.hasStorage){status('端末保存ができません。外部JSONバックアップを取ってください。',true);return false;}
  try{
    if(!await saveNow())throw Error('現在の状態を保存できません。');
    if(checkpoint)await store.checkpoint(state,action);
    return true;
  }catch(e){
    status('操作前の安全保存に失敗したため中止しました: '+String(e.message||e),true);
    return false;
  }
}
async function handleImport(file){
  if(!file||!ready||busy||bodyBackupBusy)return;
  try{
    if(file.size>TRANSFER_MAX_BYTES)throw Error('50MB以下のファイルを選んでください。');
    const parsed=parseImport(file.name,await file.text(),state);
    const type=parsed.full?'設定・記憶・本文・履歴すべて':'本文と履歴のみ';
    if(await modal(file.name+' を読み込みます。置換対象: '+type+'。事前に外部JSONバックアップを取っていますか？')!=='yes')return;
    if(saveBlocked){
      if(store?.recoveryRequired)throw Error('先に復旧元を選択してください。');
      if(await modal('現在の保存先は読み取り専用です。既存の異常データが残る場合があります。外部バックアップを確認した上で復旧を許可しますか？')!=='yes')return;
      await store.allowImportRecovery();saveBlocked=false;
    }else if(!await beforeDestructive('import'))return;
    state=parsed.state;state.updatedAt=new Date().toISOString();
    candidate=state.pendingCandidate;fullBody=false;paint();rebuildSettings();
    editRev++;if(await saveNow(true))status('ファイルを読み込み保存しました。');
    else status('読み込みましたが保存に失敗しました。外部JSONへ書き出してください。',true);
  }catch(e){status('読み込みに失敗しました: '+String(e.message||e),true);}
}
async function resetStory(){
  if(!ready||busy||bodyBackupBusy||saveBlocked)return;
  if(await modal('新しい作品にすると本文・設定・保存済みのすべての分岐が置き換わります。事前にJSONを外部保存してください。')!=='yes')return;
  if(!await beforeDestructive('reset'))return;
  state=freshState();candidate=null;paint();rebuildSettings();editRev++;await saveNow(true);
}
async function restoreCheckpoint(){
  if(!ready||saveBlocked||busy||bodyBackupBusy)return;
  try{
    const versions=await store.checkpointList();
    if(!versions.length){status('復元できる以前の保存点はありません。');return;}
    const choices=versions.map((v,i)=>[String(i),String(i+1)+'：'+
      new Date(v.at).toLocaleString('ja-JP')+'／'+(v.reason||'保存点')+'／'+(v.chars??'不明')+'文字']);
    choices.push(['cancel','キャンセル']);
    const selection=await modal('復元する時点を選んでください。復元前の現在の状態も保存点に退避します。',choices);
    if(selection==='cancel')return;
    const n=Number(selection);
    if(!Number.isSafeInteger(n)||n<0||n>=versions.length)return;
    const selected=await store.loadCheckpoint(versions[n].id);
    if(!await beforeDestructive('選択した復元点を開く'))return;
    state=selected;candidate=state.pendingCandidate;fullBody=false;
    editRev++;paint();rebuildSettings();
    if(await saveNow(true))status('第'+(n+1)+'候補の復元点へ戻しました。');
    else status('復元内容を保存できませんでした。JSONで退避してください。',true);
  }catch(e){status('復元できません: '+String(e.message||e),true);}
}
async function recoverChoice(){
  if(!store?.recoveryRequired)return;
  const info=store.recoveryInfo();
  const describe=(name,value)=>name+'：'+(value?value.title+'／'+value.chars+'文字／'+value.turns+'ターン／更新 '+(value.at||'不明'):'読み取り不可');
  const choice=await modal('保存データの衝突です。どちらを採用しますか？\n'+
    describe('SQLite',info.sqlite)+'\n'+describe('IndexedDB',info.idb)+
    '\n選ばなかった側も復元点へ保存します。決められない場合は保留してJSONを書き出してください。',
    [['idb','IndexedDBの退避を使う'],['sqlite','SQLiteの保存を使う'],['cancel','保留する']]);
  if(choice!=='idb'&&choice!=='sqlite')return;
  try{
    const recovered=await store.chooseRecovery(choice);
    state=cleanState(recovered);candidate=state.pendingCandidate;
    saveBlocked=false;saveError='';ready=true;
    editRev++;savedRev=editRev;
    paint();rebuildSettings();lockUI();safety();
    status('指定した保存元から復元・保存しました。設定欄も最新表示に更新しました。');
  }catch(e){
    saveBlocked=true;
    status('復旧に失敗しました。再度選択できます: '+String(e.message||e),true);
    lockUI();safety();
  }
}

async function exportRaw(){
  try{
    const raw=await store.rawDump();
    const result=await writeFile(host,filename('talking-story-raw-recovery','json'),raw,'application/json');
    lastExport={name:filename('talking-story-raw-recovery','json'),text:raw,mime:'application/json'};
    el('open-export-manual').hidden=false;
    status(result.message,result.kind==='manual');
    if(result.kind==='manual'){
      el('manual-export').hidden=false;
      const name=filename('talking-story-raw-recovery','json');
      el('manual-name').textContent=name;
      el('manual-text').value=result.text;
      el('download-manual').dataset.name=name;
      el('download-manual').dataset.mime='application/json';
      el('manual-export').scrollIntoView({block:'nearest'});
    }
  }catch(e){status('生データを書き出せません: '+String(e.message||e),true);}
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
async function applyStoryChange(transform,note,{destructive=false}={}){
  if(!ready||busy||branchBusy||bodyBackupBusy||saveBlocked)return false;
  branchBusy=true;lockUI();
  const original=state,oldCandidate=candidate;
  try{
    if(!await beforeDestructive('分岐操作',{checkpoint:destructive}))return false;
    const changed=transform(original);
    if(!changed||typeof changed!=='object')throw Error('変更後の状態が不正です。');
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
      turn.user,{max:15000,options:[['generate','変更して再生成'],['draft','入力欄に戻す'],['cancel','キャンセル']]}
    );
    if(!decision)return;
    if(await applyStoryChange(s=>editUserAt(s,index,decision.text),'過去の入力を編集した分岐を作成しました')){
      showMain();
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
    if(await modal('第'+(index+1)+'ターンの返信を再生成します。\n元のストーリー全体は別の分岐に残し、選択ターンの前から再生成します。')!=='yes')return;
    const input=turn.user;
    if(await applyStoryChange(s=>regenerateAt(s,index),'再生成用の分岐を作成しました')){
      showMain();el('prompt-section').scrollIntoView({block:'start'});await startGeneration({inputOverride:input});
    }
    return;
  }
  if(action==='undo'&&state.branches.length>=MAX_ARCHIVED_BRANCHES){
    if(await modal('分岐30件の上限です。元の状態を復元点へ保存して直前のターンを取り消しますか？')!=='yes')return;
    const succeeded=await applyStoryChange(s=>rewindLastWithoutFork(s),'直前のターンを取り消しました（元の展開は復元点に保管）。',{destructive:true});
    if(succeeded)showMain();
    return;
  }
  if(action==='rewind'||action==='undo'||action==='restart'){
    const label=action==='restart'?'第1ターンの前':'第'+(index+1)+'ターン'+(action==='rewind'?'終了時':'開始前');
    if(await modal(label+'に戻りますか？\n以降の展開は削除せず、元の分岐として保存します。')!=='yes')return;
    const changed=await applyStoryChange(s=>
      action==='restart'?forkAt(s,{index:0,after:false,label:'第1ターンの前からやり直す'}):
      action==='undo'?rewindBefore(s,index):rewindAfter(s,index),
    '指定位置へ戻した分岐を作成しました');
    if(changed){showMain();el('prompt-section').scrollIntoView({block:'start'});}
  }
}
async function branchAction(action,id){
  if(!ready||busy||branchBusy||saveBlocked)return;
  const found=id===state.activeBranch?.id?state.activeBranch:state.branches.find(b=>b.id===id);
  if(!found){status('分岐が見つかりません。',true);return;}
  if(action==='switch'){
    const selection=await modal('「'+found.name+'」に切り替えます。人物設定・世界観・自由記憶・ユーザー設定はどうしますか？\n生成パラメータは常に現在の値を引き継ぎます。',
      [['branch','切替先分岐の設定を使用'],['inherit','現在の設定を引き継ぐ'],['cancel','キャンセル']]);
    if(selection!=='branch'&&selection!=='inherit')return;
    if(await applyStoryChange(s=>switchBranch(s,id,{inheritLore:selection==='inherit'}),'分岐を切り替えました'))showMain();
  }else if(action==='rename'){
    const result=await textModal('分岐の名前を編集します。',found.name,{max:90,multiline:false});
    if(result)await applyStoryChange(s=>renameBranch(s,id,result.text),'分岐名を変更しました');
  }else if(action==='delete'){
    if(await modal('保存されている分岐「'+found.name+'」を削除しますか？\n現在の分岐は削除しません。削除前の状態は復元点へ保存しますが、外部JSONバックアップも推奨します。')!=='yes')return;
    await applyStoryChange(s=>deleteInactiveBranch(s,id),'指定分岐を削除しました',{destructive:true});
  }
}

function setup(){
  app.innerHTML=
    '<header><div class="bar"><img class="logo" src="./icon.jpg" alt="緑の時計"><div class="titles"><div class="subtitle">LAYLA MINI-APP · LOCAL STORY</div><div class="brand" id="title-view">新しい物語</div></div><span class="badge">物語</span></div>'+
    '<div id="status" class="status" role="status" aria-live="polite">データ読み込み中…</div><button id="recover-now" hidden class="small warn">復旧元を選択</button><button id="open-export-manual" hidden class="small ghost">共有できない場合：手動で救出</button></header><div id="safety" class="safety error" role="alert">初期化中</div>'+
    '<main><div id="screen-main">'+
    '<section class="panel"><div class="split" style="justify-content:space-between"><h2>確定した物語</h2><span class="mini" id="counter"></span></div><p id="meta" class="hint"></p><div class="story" id="body-view"></div><div class="actions"><button id="view-full">全文を表示</button><button id="jump-bottom">入力欄へ移動</button><button id="undo">直前のターンを分岐して取り消す</button></div></section>'+
    '<section class="panel" id="prompt-section"><h2>あなたの台詞・行動</h2><p class="hint">本人が話す台詞・取る行動、次の場面の希望を記入してください。</p><textarea id="user-input" rows="5" maxlength="15000" placeholder="例：『おはよう』と笑って、隣に座る。"></textarea><div class="actions"><button id="generate" class="primary">続きを生成</button><button id="stop" class="warn" disabled>生成停止</button></div><div id="candidate-box" hidden><label for="candidate-edit">未採用の候補（編集可能）</label><textarea id="candidate-edit" rows="9"></textarea><p id="candidate-status" class="hint"></p><div class="actions"><button id="accept" class="primary">この文章を採用</button><button id="retry">もう一度生成</button><button id="discard" class="warn">破棄</button></div></div></section>'+
    '<section class="panel" id="history-section"><details><summary>会話履歴を編集・再生成・巻き戻す</summary><p class="hint">本文の軽い手直しでは履歴位置を自動補正します。複数ターンを一度に書き換えた場合は、復元点作成後に履歴をリセットできます。</p><button id="reset-history" class="small warn">本文を保持して履歴だけ再設定</button><div class="history-toolbar"><button id="turn-older" class="small ghost">前の30件</button><span id="turn-range" class="hint"></span><button id="turn-newer" class="small ghost">次の30件</button></div><div class="history-toolbar"><label for="turn-number">ターン番号</label><input id="turn-number" type="number" inputmode="numeric" min="1" placeholder="番号"><button id="turn-go" class="small ghost">移動</button><button id="turn-start" class="small warn">第1ターンの前に戻す</button></div><div id="turn-log" class="history-log"></div></details></section><section class="panel" id="branches-section"><h2>ストーリー分岐</h2><p class="hint">元の展開はここからいつでも開けます。分岐ごとの本文・設定・記憶・下書きを保存します。</p><strong id="branch-current"></strong><p id="branch-count" class="hint"></p><div id="branch-list"></div></section></div>'+
    '<div id="screen-settings" hidden><section class="panel"><h2>作品設定</h2><p class="hint">日本語の文章と [海:名称≡&lt;虎田海&gt;] 形式は混在できます。</p><div id="settings-fields"></div></section>'+
    '<section class="panel"><h2>生成設定</h2><div id="preference-fields"></div><p class="hint" id="prompt-meta"></p></section>'+
    '<section class="panel"><h2>確定本文の編集</h2><p class="hint">ここが正本です。長編の場合は編集前にJSONをバックアップしてください。</p><p id="edit-count" class="hint"></p><p id="edit-warning" class="safety" hidden>本文を大きく削除しました。誤操作であれば、直ちに「直前の状態を復元」を利用してください。</p><textarea id="edit-body" class="long" rows="12"></textarea></section>'+
    '<section class="panel"><h2>バックアップ・復元</h2><p class="hint">JSONは設定・自由記憶・本文・履歴を保存。TXTとMDは本文用。保存先はiOS「ファイル」で確認してください。</p><div class="actions"><button id="export-json" class="primary">全データ JSON</button><button id="export-light-json">軽量JSON（分岐共有）</button><button id="export-txt">本文 TXT</button><button id="export-md">本文 MD</button></div><div class="actions"><button id="import">ファイルを読み込む</button><button id="restore">直前の状態を復元</button><button id="new-story" class="warn">新しい作品</button></div><div class="actions"><button id="recover">復旧元を選択</button><button id="raw-backup">保存生データの救出</button></div><input id="file-picker" type="file" accept=".json,.txt,.md" hidden></section></div>'+
    '<section class="panel" id="manual-export" hidden><h3>緊急書き出し</h3><p id="manual-name" class="hint"></p><p class="hint">コピーするか、通常ブラウザではダウンロードを選択してください。Layla内では保存されたか必ず確認してください。</p><textarea id="manual-text" rows="6" readonly></textarea><div class="actions"><button id="copy-manual">テキストをコピー</button><button id="download-manual">ブラウザ用ダウンロード</button><button id="close-manual">閉じる</button></div></section>'+
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
  el('export-txt').onclick=()=>void exportAs('txt');
  el('export-md').onclick=()=>void exportAs('md');
  el('import').onclick=()=>el('file-picker').click();
  el('file-picker').onchange=e=>{const file=e.target.files?.[0];e.target.value='';if(file)void handleImport(file);};
  el('new-story').onclick=()=>void resetStory();
  el('restore').onclick=()=>void restoreCheckpoint();
  el('recover').onclick=()=>void recoverChoice();
  el('recover-now').onclick=()=>void recoverChoice();
  el('reset-history').onclick=async()=>{
    if(!state.turns.length)return;
    if(await modal('現在の本文は保持し、送信履歴だけ削除します。元の履歴は復元点に保存します。続行しますか？')!=='yes')return;
    if(await applyStoryChange(s=>clearHistoryAgainstBody(s),'本文を保持して履歴をリセットしました。',{destructive:true}))rebuildSettings();
  };
  el('raw-backup').onclick=()=>void exportRaw();
  el('close-manual').onclick=()=>{el('manual-text').value='';el('manual-export').hidden=true;};
  el('open-export-manual').onclick=()=>{
    if(!lastExport)return;
    el('manual-export').hidden=false;el('manual-name').textContent=lastExport.name;
    el('manual-text').value=lastExport.text;
    el('download-manual').dataset.name=lastExport.name;
    el('download-manual').dataset.mime=lastExport.mime;
    el('manual-export').scrollIntoView({block:'center'});
  };
  el('download-manual').onclick=()=>{
    const name=el('download-manual').dataset.name||'story.txt';
    const mime=el('download-manual').dataset.mime||'text/plain';
    const blob=new Blob([el('manual-text').value],{type:mime+';charset=utf-8'});
    if(browserDownload(name,blob))status('ブラウザにダウンロードを指示しました。実際の保存を確認してください。');
    else status('この環境ではダウンロードできません。コピーで救出してください。',true);
  };
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
    store=await openStore(host,(message,isError=false)=>status(message,isError),{validator:cleanState});
    if(store.initial){
      try{state=cleanState(store.initial);}
      catch(e){saveBlocked=true;saveError='データ読み込みエラー: '+e.message;ready=true;paint();safety();return;}
    }
    candidate=state.pendingCandidate;
    if(candidate){
      if(!candidate.text?.trim()){candidate=null;state.pendingCandidate=null;}
      else if(candidate.note?.includes('生成中'))candidate.note='中断前に保存された未採用候補です。確認してください。';
    }
    ready=true;saveBlocked=store.readOnly||!store.hasStorage;
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
  }catch(e){
    ready=true;saveBlocked=true;saveError='初期化に失敗: '+String(e.message||e);
    status(saveError,true);paint();safety();
  }
}
void init();
