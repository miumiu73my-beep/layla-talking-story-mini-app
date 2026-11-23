import { LaylaSDK } from '@layla-network/sdk';
import { FIELDS, cleanState, freshState, buildMessages, samplerParams, parseImport, readableText } from './logic.js';
import { openStore } from './persistence.js';
import { writeFile, filename } from './export.js';
import './style.css';

const app=document.getElementById('app');
const layla=new LaylaSDK();
let state=freshState(),store=null,busy=false,stream=null,stopped=false,candidate=null,baseBody='';
let saveTimer=null,saveBlocked=false,lastInput='';
const el=id=>document.getElementById(id);
function node(tag,cls,text){const a=document.createElement(tag);if(cls)a.className=cls;if(text!==undefined)a.textContent=text;return a;}
function status(s,error=false){if(!el('status'))return;el('status').textContent=s;el('status').className='status'+(error?' error':'');}
function persist(delay=700){
  if(saveBlocked)return;
  state.updatedAt=new Date().toISOString();
  clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>{saveTimer=null;void saveNow();},delay);
  status('編集中… 自動保存します');
}
async function saveNow(){
  if(saveBlocked||!store)return;
  clearTimeout(saveTimer);saveTimer=null;
  try{await store.save(state);}
  catch(e){status('保存失敗。JSONを必ず外部に保存してください: '+e.message,true);}
}
function paint(){
  el('title-view').textContent=state.title||'新しい物語';
  el('body-view').textContent=state.body||'ここから物語が始まります。まず設定を記入して、主人公の行動を入力してください。';
  el('body-view').classList.toggle('empty',!state.body);
  el('counter').textContent=Array.from(state.body).length.toLocaleString('ja-JP')+'文字';
  el('meta').textContent='モデルはLayla本体で選択・変更 · '+(store?store.mode():'接続中');
  showHistory();
}
function showHistory(){
  const panel=el('turn-log');panel.replaceChildren();
  const list=state.turns.slice(-8);
  if(!list.length){panel.append(node('p','hint','まだ対話履歴はありません。'));return;}
  list.forEach(t=>{
    const item=node('div','turn'),tag=node('div','tag','あなたの入力'),user=node('div','',t.user);
    const output=node('div','hint','→ '+t.reply.slice(0,110).replace(/\n/g,' ') +(t.reply.length>110?'…':''));
    item.append(tag,user,output);panel.append(item);
  });
}
function showCandidate(message=''){
  const box=el('candidate-box');
  box.hidden=!candidate;
  el('candidate-view').textContent=candidate?.text||'生成待機中…';
  el('candidate-status').textContent=message;
  el('accept').disabled=busy||!candidate?.text?.trim();
  el('discard').disabled=busy||!candidate;
  el('retry').disabled=busy||!candidate;
}
function showMain(){
  el('screen-main').hidden=false;el('screen-settings').hidden=true;
  el('nav-main').classList.add('primary');el('nav-settings').classList.remove('primary');
  paint();
}
function showSettings(){
  if(busy){status('生成中は設定を開けません。停止してから操作してください。');return;}
  el('screen-main').hidden=true;el('screen-settings').hidden=false;
  el('nav-main').classList.remove('primary');el('nav-settings').classList.add('primary');
  rebuildSettings();window.scrollTo(0,0);
}
function field(parent,key,label,kind,hint){
  const id='field-'+key,l=document.createElement('label');l.htmlFor=id;l.textContent=label;
  const control=document.createElement(kind==='text'?'input':'textarea');
  if(kind==='text')control.type='text';else control.rows=key==='memory'||key==='characters'?6:3;
  control.id=id;control.placeholder=hint;control.value=state[key]||'';
  control.addEventListener('input',()=>{state[key]=control.value;persist();if(key==='title')el('title-view').textContent=control.value||'新しい物語';});
  parent.append(l,control);
  parent.append(node('div','hint',hint));
}
function sectionSettings(title,items,isOpen=false){
  const details=document.createElement('details');details.open=isOpen;
  details.append(node('summary','',title));
  items.forEach(key=>{const f=FIELDS.find(f=>f[0]===key);if(f)field(details,...f);});
  el('settings-fields').append(details);
}
function addPreference(parent,key,label,min,max,step,hint=''){
  const wrap=document.createElement('div'),l=node('label','',label);l.htmlFor='pref-'+key;
  const input=document.createElement('input');
  input.type='number';input.id='pref-'+key;input.min=String(min);input.max=String(max);input.step=String(step);
  input.value=String(state.prefs[key]??'');input.placeholder='空欄＝Layla既定値';
  input.addEventListener('input',()=>{state.prefs[key]=input.value;persist();});
  wrap.append(l,input);if(hint)wrap.append(node('p','hint',hint));parent.append(wrap);
}
function addChoice(parent,key,label,values){
  const wrap=document.createElement('div'),l=node('label','',label);l.htmlFor='pref-'+key;
  const select=document.createElement('select');select.id='pref-'+key;
  values.forEach(v=>{const opt=document.createElement('option');opt.value=v;opt.textContent=v;select.append(opt);});
  select.value=state.prefs[key];
  select.addEventListener('change',()=>{state.prefs[key]=select.value;persist();});
  wrap.append(l,select);parent.append(wrap);
}
function rebuildSettings(){
  el('settings-fields').replaceChildren();
  sectionSettings('作品の基本情報',['title','synopsis','goal'],true);
  sectionSettings('キャラ・世界観・プレイヤー',['characters','world','player'],true);
  sectionSettings('自由記憶（章ごとの管理不要）',['memory'],true);
  sectionSettings('禁止事項・執筆のルール',['avoidPlot','avoidWords','rules'],false);
  sectionSettings('モデルの記録（切替はLayla本体）',['modelNote'],false);
  const pref=el('preference-fields');pref.replaceChildren();
  const basic=node('div','formgrid');
  addPreference(basic,'targetChars','1回の生成目安（文字）',100,1000,50);
  addPreference(basic,'contextChars','参照する確定本文の末尾（文字）',500,12000,100);
  addChoice(basic,'pace','展開のテンポ',['ゆっくり','普通','速め']);
  addChoice(basic,'pov','物語の視点',['二人称寄り','一人称','三人称']);
  pref.append(basic);
  const advanced=document.createElement('details');advanced.append(node('summary','','詳細な生成設定（空欄＝Layla既定）'));
  const grid=node('div','formgrid');
  [['temperature','temperature',0,2,.05],['top_p','top_p',0,1,.05],['top_k','top_k',1,200,1],['min_p','min_p',0,1,.01],['repeat_penalty','繰り返しペナルティ',.5,3,.05],['repeat_last_n','検索範囲（実験的）',0,2048,1],['repeat_penalty_slope','傾斜（実験的）',0,2,.05],['frequency_penalty','frequency_penalty',-2,2,.1],['presence_penalty','presence_penalty',-2,2,.1],['max_tokens','max_tokens',1,8192,1]].forEach(args=>addPreference(grid,...args));
  advanced.append(grid,node('p','hint','検索範囲・傾斜はLayla本体のバージョンによって反映されない可能性があります。'));
  pref.append(advanced);
  const edit=el('edit-body');edit.value=state.body;
  edit.oninput=()=>{state.body=edit.value;persist();};
}
async function generate(){
  if(busy)return;
  if(candidate&&candidate.text?.trim()&&!confirm('未採用の生成文を破棄して新しく生成しますか？'))return;
  const input=el('user-input').value.trim()||'この場面を自然に続きを進める';
  lastInput=input;baseBody=state.body;stopped=false;candidate={user:input,text:''};
  busy=true;el('generate').disabled=true;el('stop').disabled=false;
  showCandidate('LaylaのローカルLLMで生成中…');status('生成中…');
  try{
    const messages=buildMessages(state,input),params=samplerParams(state.prefs);
    stream=layla.chat.completions.stream({messages,...params});
    stream.on('content',(_delta,snapshot)=>{
      if(stopped)return;
      candidate.text=String(snapshot||'');
      el('candidate-view').textContent=candidate.text;
    });
    const final=await stream.finalContent();
    if(!stopped){
      candidate.text=String(final||candidate.text||'').trim();
      if(!candidate.text)throw Error('生成結果が空でした。モデルと設定を確認してください。');
      const forbidden=String(state.avoidWords||'').split(/[,、，\n]/).map(v=>v.trim()).filter(v=>v.length>0);
      const hit=forbidden.find(word=>candidate.text.includes(word));
      if(hit||state.body!==baseBody){
        showCandidate(hit?'禁止ワード「'+hit+'」が含まれています。内容を確認してから採用してください。':'生成中に本文が更新されたため自動採用しませんでした。');
        status('候補は未採用です');
      }else{acceptCandidate();status('物語を進めました');}
    }
  }catch(e){
    if(!stopped)status('生成に失敗しました: '+String(e?.message||e),true);
  }finally{
    busy=false;stream=null;el('generate').disabled=false;el('stop').disabled=true;
    showCandidate(stopped?'途中停止しました。必要なら生成文を採用できます。':el('candidate-status').textContent);
  }
}
function acceptCandidate(){
  if(!candidate?.text?.trim())return;
  const text=candidate.text.trim();
  if(state.body.length+text.length+3>1500000){status('本文が容量上限に達しました。バックアップしてください。',true);return;}
  state.body+=(state.body?'\n\n':'')+text;
  state.turns.push({user:candidate.user,reply:text,at:new Date().toISOString()});
  if(state.turns.length>10000)state.turns=state.turns.slice(-10000);
  candidate=null;el('user-input').value='';showCandidate();paint();persist(0);
}
function stop(){if(!busy)return;stopped=true;try{stream?.abort();}catch{}status('生成を停止しました。');}
async function exportAs(ext){
  try{
    await saveNow();
    const text=ext==='json'?JSON.stringify(cleanState(state),null,2):readableText(state,ext);
    const mime=ext==='json'?'application/json':ext==='md'?'text/markdown':'text/plain';
    status(await writeFile(layla,filename(state.title,ext),text,mime));
  }catch(e){status('書き出しに失敗しました: '+String(e?.message||e),true);}
}
async function handleImport(file){
  if(!file||busy)return;
  try{
    if(file.size>8000000)throw Error('8MB以下のファイルを選んでください。');
    const result=parseImport(file.name,await file.text(),state);
    const note=result.full?'設定・記憶・本文・履歴をすべて置き換えます。':'本文と履歴を置き換え、現在の設定・記憶は残します。';
    if(!confirm(file.name+' を読み込みます。\n'+note+'\n現在の内容は事前にJSON保存してください。続行しますか？'))return;
    state=result.state;candidate=null;paint();rebuildSettings();showCandidate();
    await saveNow();status('読み込みました（'+(result.full?'完全復元':'本文のみ')+'）。');
  }catch(e){status('読み込みに失敗しました: '+String(e?.message||e),true);}
}
function setup(){
  app.innerHTML=
    '<header><div class="bar"><img class="logo" src="./icon.jpg" alt="緑色の時計"><div class="titles"><div class="subtitle">LAYLA MINI-APP · LOCAL STORY</div><div class="brand" id="title-view">新しい物語</div></div><span class="badge">物語</span></div></header>'+
    '<main><div id="screen-main">'+
    '<section class="panel"><div class="split" style="justify-content:space-between"><h2>物語の本文</h2><span class="mini" id="counter"></span></div><div class="hint" id="meta"></div><div id="body-view" class="story"></div></section>'+
    '<section class="panel"><h2>あなたの台詞・行動</h2><p class="hint">物語の中にいる自分のセリフ、行動、次の場面への希望などを自由に記入してください。</p><textarea id="user-input" rows="5" placeholder="例：『おはよう』と笑って、隣に座る。"></textarea><div class="actions"><button class="primary" id="generate">この先を進める</button><button class="warn" id="stop" disabled>生成停止</button></div><div id="candidate-box" hidden><div class="story-preview" id="candidate-view"></div><p id="candidate-status" class="hint"></p><div class="actions"><button id="accept">この文章を採用</button><button class="ghost" id="retry">もう一度生成</button><button class="warn" id="discard">破棄</button></div></div></section>'+
    '<section class="panel"><details><summary>直近のやりとり</summary><div id="turn-log" class="chatlog"></div></details></section>'+
    '</div><div id="screen-settings" hidden>'+
    '<section class="panel"><h2>作品の設定</h2><p class="hint">各欄に通常の文章と、[海:名称≡&lt;虎田海&gt;] などのキャラクターブック形式を混ぜて記入できます。記入内容はそのままモデルへ送信します。</p><div id="settings-fields"></div></section>'+
    '<section class="panel"><h2>ストーリー生成</h2><div id="preference-fields"></div></section>'+
    '<section class="panel"><h2>確定本文を直接編集</h2><p class="hint">ここで編集した本文が生成時の正本です。過去のやりとり履歴は自動では書き換わりません。</p><textarea id="edit-body" class="long" rows="12"></textarea></section>'+
    '<section class="panel"><h2>書き出し・読み込み</h2><p class="hint">JSONは設定全体・自由記憶・本文・履歴の完全復元用。TXTとMDは本文用です。再インポート前に必ずJSONを外部保存してください。</p><div class="actions"><button id="export-json" class="primary">全設定＋本文 JSON</button><button id="export-txt">本文 TXT</button><button id="export-md">本文 MD</button></div><div class="actions"><button id="import">ファイルを読み込む</button><button id="new-story" class="warn">新しい作品にする</button></div><input id="file-picker" type="file" accept=".json,.txt,.md,application/json,text/plain,text/markdown" hidden></section>'+
    '</div><p class="status" role="status" aria-live="polite" id="status">接続中…</p></main>'+
    '<nav class="nav" aria-label="画面切り替え"><button class="primary" id="nav-main">本文へ戻る</button><button id="nav-settings">設定</button><button id="quick-backup">JSON保存</button></nav>';
  el('nav-main').onclick=showMain;el('nav-settings').onclick=showSettings;el('quick-backup').onclick=()=>void exportAs('json');
  el('generate').onclick=()=>void generate();el('stop').onclick=stop;
  el('accept').onclick=()=>{if(!busy){acceptCandidate();status('生成候補を採用しました。');}};
  el('discard').onclick=()=>{if(!busy){candidate=null;showCandidate();status('生成候補を破棄しました。');}};
  el('retry').onclick=()=>{if(!busy){candidate=null;showCandidate();el('user-input').value=lastInput;void generate();}};
  el('export-json').onclick=()=>void exportAs('json');el('export-txt').onclick=()=>void exportAs('txt');el('export-md').onclick=()=>void exportAs('md');
  el('import').onclick=()=>el('file-picker').click();
  el('file-picker').onchange=e=>{const file=e.target.files?.[0];e.target.value='';if(file)void handleImport(file);};
  el('new-story').onclick=()=>{if(busy)return;if(!confirm('作品とすべての設定・記憶・本文・履歴を新規状態にします。事前にJSON保存しましたか？'))return;state=freshState();candidate=null;showCandidate();rebuildSettings();paint();persist(0);};
  showCandidate();paint();
}
async function init(){
  setup();
  try{
    store=await openStore(layla,message=>status(message));
    if(store.initial){
      try{state=cleanState(store.initial);}
      catch(e){saveBlocked=true;status('保存データを読み取れません。上書き防止のため自動保存停止: '+e.message,true);}
    }
    paint();status('準備完了。保存先: '+store.mode()+(store.corrupt?'（SQLiteを使用できません）':''));
  }catch(e){saveBlocked=true;status('初期化できません: '+String(e?.message||e),true);}
}
void init();
