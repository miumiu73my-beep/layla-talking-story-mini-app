// Pure data validation, prompt budgeting and reversible story state transitions.
export const FORMAT='layla-talking-story-backup',VERSION=1;
export const BODY_LIMIT=1500000,TRANSFER_MAX_BYTES=50000000;
export const REPLY_TRASH_LIMIT=20;
export const PROMPT_INPUT_LIMIT=6000;
export const AUTO_CONTINUE_INPUT='この場面を自然に続きを進める';
export const isSyntheticInput=value=>String(value??'').trim()===AUTO_CONTINUE_INPUT;
export const editableTurnInput=value=>isSyntheticInput(value)?'':String(value??'');
export function inputLimitWarning(text,prefs){
  const n=String(text||'').length;
  const limit=prefs?promptFrame(cleanState({prefs}).prefs).inputLimit:PROMPT_INPUT_LIMIT;
  return n>limit?'今回の入力は'+n+'文字です。送信上限は約'+limit+'文字です。入力を短くするかコンテキスト長・出力予約を見直してください（原文は保存されます）。':'';
}
// Keep recent replies, not entire story snapshots. Retain a single oversized
// reply intact rather than silently truncating it.
export function rememberReply(trash,text){
  if(typeof text!=='string'||!text.trim())return [...trash];
  const entries=[...new Set([text,...trash])].slice(0,REPLY_TRASH_LIMIT);
  let total=entries[0].length;
  return entries.filter((entry,i)=>{if(i===0)return true;total+=entry.length;return total<=BODY_LIMIT;});
}
export function restoreReplyCandidate(state,index){
  if(state.pendingCandidate)throw Error('先に未採用候補を採用するか破棄してください。');
  const text=state.replyTrash?.[index];
  if(typeof text!=='string'||!text.trim())throw Error('返信が見つかりません。');
  const user=state.draft.trim()||AUTO_CONTINUE_INPUT;
  return {user,text,sourceDraft:state.draft,baseFingerprint:bodyFingerprint(state.body),note:'ごみ箱から復元した候補です。現在の本文・入力に合うか確認してから採用してください。'};
}
// Return true only for a changed stream payload; callers advance the dirty revision.
export function updateStreamText(candidate,text){
  if(typeof text!=='string'||candidate.text===text)return false;
  candidate.text=text;return true;
}
export const LIMITS=Object.freeze({
  title:120,synopsis:12000,characters:30000,world:25000,memory:25000,
  avoidPlot:15000,avoidWords:10000,player:10000,goal:15000,rules:15000,modelNote:120
});
export const FIELDS=[
  ['title','今回の作品のタイトル','text','例：雨の日の約束'],
  ['synopsis','今回の作品のあらすじ','textarea','最初の状況、これまでの経緯'],
  ['characters','メインキャラ・人物設定','textarea','通常の文章、[海:名称≡<虎田海>] 形式を併用できます。'],
  ['world','世界観・その他キャラ設定','textarea','時代、場所、用語、ルールなど'],
  ['memory','覚えておいてほしい内容（自由記載）','textarea','章分けなし。最新の内容も参照されるよう送信時に予算管理します。'],
  ['avoidPlot','禁止する展開','textarea','避けたい展開'],
  ['avoidWords','禁止ワード','textarea','改行、読点、カンマで区切る'],
  ['player','ユーザーの役割・呼び名','textarea','例：ユーザーは海。発言や行動は本人が決める。'],
  ['goal','作品のゴール','textarea','物語の目標'],
  ['rules','固定指示・文体・注意事項','textarea','視点、口調、絶対に守ること'],
  ['modelNote','利用モデルのメモ（表示用）','text','モデル選択はLayla本体で行います。']
];
const own=(obj,key)=>Object.prototype.hasOwnProperty.call(obj,key);
export function checksum(src){let h=2166136261;for(let i=0;i<src.length;i++)h=Math.imul((h^src.charCodeAt(i)),16777619);return(h>>>0).toString(16);}
export function bodyFingerprint(value){const s=String(value||'');return s.length+':'+checksum(s);}
const bound=(x,lo,hi,defaultValue)=>Number.isFinite(+x)&&x!==''?Math.max(lo,Math.min(hi,+x)):defaultValue;
export function freshState(){
  return {schema:FORMAT,version:VERSION,updatedAt:new Date().toISOString(),
    title:'新しい物語',synopsis:'',characters:'',world:'',memory:'',
    avoidPlot:'',avoidWords:'',player:'',goal:'',rules:'',modelNote:'',
    body:'',turns:[],draft:'',pendingCandidate:null,undo:null,replyTrash:[],
    activeBranch:{id:'main',name:'本編',createdAt:new Date().toISOString(),parentId:null,forkTurn:null},branches:[],
    prefs:{targetChars:300,contextChars:3600,contextTokens:8192,pace:'普通',
      pov:'ユーザー視点（二人称寄り）',autoAdopt:false,includeInput:true,recordInputInBody:false,
      temperature:'',top_p:'',top_k:'',min_p:'',repeat_penalty:'',
      repeat_last_n:'',repeat_penalty_slope:'',frequency_penalty:'',
      presence_penalty:'',max_tokens:'',maxTokensVersion:1}};
}
// Only canonical, deeply immutable archived snapshots can bypass revalidation.
const canonicalArchives=new WeakSet(), archiveReferences=new WeakSet();
// References are internal capabilities, never accepted from imported JSON.
export function archiveReference(meta){
  const ref={id:meta.id,name:meta.name,createdAt:meta.createdAt,parentId:meta.parentId,forkTurn:meta.forkTurn,
    chars:meta.chars,turnCount:meta.turnCount,kind:'archive-reference'};
  Object.defineProperty(ref,'toJSON',{value(){throw Error('未読込の分岐をJSONにする前に分岐本文を読み込んでください。');}});
  archiveReferences.add(ref);return Object.freeze(ref);
}
export const isArchiveReference=value=>archiveReferences.has(value);
function freezeArchive(value){
  if(value&&typeof value==='object'&&!Object.isFrozen(value)){
    for(const child of Object.values(value))freezeArchive(child);
    Object.freeze(value);
  }
  return value;
}
export function cleanState(raw){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('作品の形式が不正です。');
  if(raw.schema!==undefined&&raw.schema!==FORMAT)throw Error('別の形式のバックアップです。');
  if(raw.version!==undefined&&raw.version!==VERSION)throw Error('対応していないバックアップのバージョンです。');
  const d=freshState();
  for(const key of Object.keys(LIMITS)){
    if(!own(raw,key)||raw[key]===null)continue;
    if(typeof raw[key]!=='string')throw Error('設定 '+key+' の形式が不正です。');
    d[key]=raw[key]; // Do NOT truncate already-saved data.
  }
  for(const key of ['body','draft']){
    if(!own(raw,key)||raw[key]===null)continue;
    if(typeof raw[key]!=='string')throw Error(key+' の形式が不正です。');
    d[key]=raw[key]; // Oversized legacy data must remain exportable.
  }
  if(raw.turns!==undefined){
    if(!Array.isArray(raw.turns)||raw.turns.length>20000)throw Error('履歴の形式が不正です。');
    d.turns=raw.turns.map(t=>{
      if(!t||typeof t!=='object'||typeof t.user!=='string')throw Error('履歴が壊れています。');
      const u={user:t.user,at:typeof t.at==='string'?t.at:''};
      if(typeof t.reply==='string')u.reply=t.reply; // v1 backwards compatibility.
      if(typeof t.preview==='string')u.preview=t.preview;
      if(Number.isSafeInteger(t.bodyStart))u.bodyStart=t.bodyStart;
      if(Number.isSafeInteger(t.bodyEnd))u.bodyEnd=t.bodyEnd;
      if(typeof t.replyHash==='string')u.replyHash=t.replyHash;
      if(typeof t.userPrelude==='string')u.userPrelude=t.userPrelude;
      return u;
    });
  }
  if(raw.replyTrash!==undefined){
    if(!Array.isArray(raw.replyTrash)||raw.replyTrash.length>REPLY_TRASH_LIMIT||raw.replyTrash.some(t=>typeof t!=='string'||!t.trim()))throw Error('返信ごみ箱の形式が不正です。');
    d.replyTrash=[...raw.replyTrash];
  }
  if(raw.pendingCandidate!==undefined&&raw.pendingCandidate!==null){
    const c=raw.pendingCandidate;
    if(!c||typeof c!=='object'||typeof c.user!=='string'||typeof c.text!=='string')throw Error('未採用候補が不正です。');
    d.pendingCandidate={user:c.user,text:c.text,sourceDraft:typeof c.sourceDraft==='string'?c.sourceDraft:'',baseFingerprint:typeof c.baseFingerprint==='string'?c.baseFingerprint:bodyFingerprint(c.baseBody||''),note:typeof c.note==='string'?c.note:'',...(c.preserveDraft===true?{preserveDraft:true}:{})};
  }
  if(raw.undo!==undefined&&raw.undo!==null){
    const u=raw.undo;
    if(!u||typeof u!=='object'||!Number.isInteger(u.beforeTurns))throw Error('取消履歴が不正です。');
    if(typeof u.beforeBody==='string'&&typeof u.afterBody==='string'){
      d.undo={beforeLength:u.beforeBody.length,added:u.afterBody.slice(u.beforeBody.length),afterHash:checksum(u.afterBody),beforeTurns:u.beforeTurns,input:typeof u.input==='string'?u.input:''};
    }else if(Number.isSafeInteger(u.beforeLength)&&typeof u.added==='string'&&typeof u.afterHash==='string'){
      d.undo={beforeLength:u.beforeLength,added:u.added,afterHash:u.afterHash,beforeTurns:u.beforeTurns,input:typeof u.input==='string'?u.input:''};
    }else throw Error('取消履歴が不正です。');
  }
  if(raw.prefs!==undefined){
    if(!raw.prefs||typeof raw.prefs!=='object'||Array.isArray(raw.prefs))throw Error('生成設定が不正です。');
    for(const key of Object.keys(d.prefs)){
      if(!own(raw.prefs,key))continue;
      const value=raw.prefs[key];
      if(typeof value==='string'||typeof value==='number'||typeof value==='boolean')d.prefs[key]=value;
    }
  }
  // Reset the legacy default once; a newly selected explicit 768 is preserved.
  if(raw.prefs?.maxTokensVersion!==1&&Number(d.prefs.max_tokens)===768)d.prefs.max_tokens='';
  d.prefs.maxTokensVersion=1;
  d.prefs.targetChars=bound(d.prefs.targetChars,100,1000,300);
  d.prefs.contextChars=bound(d.prefs.contextChars,500,12000,3600);
  d.prefs.contextTokens=bound(d.prefs.contextTokens,2048,65536,8192);
  d.prefs.autoAdopt=d.prefs.autoAdopt===true;
  d.prefs.includeInput=d.prefs.includeInput!==false;
  d.prefs.recordInputInBody=d.prefs.recordInputInBody===true;
  if(!['ゆっくり','普通','速め'].includes(d.prefs.pace))d.prefs.pace='普通';
  const views=['ユーザー視点（二人称寄り）','相手キャラの一人称','三人称（客観）'];
  const oldView={'二人称寄り':views[0],'一人称':views[1],'三人称':views[2]};
  d.prefs.pov=oldView[d.prefs.pov]|| (views.includes(d.prefs.pov)?d.prefs.pov:views[0]);
  // Old v1 backups have no branch metadata. Use a deterministic default so
  // SQLite/IndexedDB equivalence checks do not report phantom conflicts.
  if(raw.activeBranch===undefined||raw.activeBranch===null)d.activeBranch.createdAt='legacy-v1';
  if(raw.activeBranch!==undefined&&raw.activeBranch!==null){
    const m=raw.activeBranch;
    if(typeof m!=='object'||Array.isArray(m)||typeof m.id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(m.id))
      throw Error('有効な分岐情報を読み取れません。');
    d.activeBranch={id:m.id,name:typeof m.name==='string'&&m.name.trim()?m.name.slice(0,90):'本編',
      createdAt:typeof m.createdAt==='string'?m.createdAt:d.activeBranch.createdAt,
      parentId:typeof m.parentId==='string'?m.parentId:null,
      forkTurn:Number.isSafeInteger(m.forkTurn)?m.forkTurn:null};
  }
  if(raw.branches!==undefined){
    if(!Array.isArray(raw.branches)||raw.branches.length>30)
      throw Error('保存された分岐情報が不正です。JSONの生データは切り捨てません。');
    const used=new Set([d.activeBranch.id]);
    d.branches=raw.branches.map(b=>{
      if(!b||typeof b!=='object'||Array.isArray(b)||typeof b.id!=='string'||
        !/^[A-Za-z0-9_-]{1,100}$/.test(b.id)||used.has(b.id))throw Error('分岐IDが不正または重複しています。');
      used.add(b.id);
      if(isArchiveReference(b)||canonicalArchives.has(b))return b;
      if(b.kind==='archive-reference')throw Error('分岐本文を含まない参照形式はインポートできません。');
      const clean=cleanState({...b,activeBranch:null,branches:[]});
      const entry={
        id:b.id,name:typeof b.name==='string'&&b.name.trim()?b.name.slice(0,90):'無題の分岐',
        createdAt:typeof b.createdAt==='string'?b.createdAt:'',
        parentId:typeof b.parentId==='string'?b.parentId:null,
        forkTurn:Number.isSafeInteger(b.forkTurn)?b.forkTurn:null
      };
      for(const key of Object.keys(LIMITS))if(key!=='modelNote')entry[key]=clean[key];
      for(const key of ['body','turns','draft','pendingCandidate','undo'])entry[key]=clean[key];
      freezeArchive(entry);canonicalArchives.add(entry);
      return entry;
    });
  }
  d.updatedAt=typeof raw.updatedAt==='string'?raw.updatedAt:'legacy-v1';
  return d;
}
export function warningsForState(data){
  // The live state is validated; warnings only inspect string lengths.
  const d=data,warnings=[];
  for(const [key,max] of Object.entries(LIMITS)){
    if(typeof d[key]==='string'&&d[key].length>max)warnings.push(key+'：推奨入力上限を超過（既存データは保持）');
  }
  if(typeof d.body==='string'&&d.body.length>BODY_LIMIT)warnings.push('本文が150万字を超過しています。削除せず読み込みました。外部JSONへバックアップしてください。');
  return warnings;
}
function safeTail(input,n){
  const s=String(input||'');
  let pos=Math.max(0,s.length-n);
  if(pos>0){const c=s.charCodeAt(pos);if(c>=0xdc00&&c<=0xdfff)pos++;}
  let tail=s.slice(pos);
  if(pos>0){
    const prefix=tail.slice(0,100);
    const hit=prefix.search(/[。\n]/);
    if(hit>=0&&hit<tail.length-30)tail=tail.slice(hit+1);
  }
  return tail;
}
export function samplerParams(prefs){
  const ranges={temperature:[0,2],top_p:[0,1],top_k:[1,200],min_p:[0,1],repeat_penalty:[0.5,3],
    repeat_last_n:[0,2048],repeat_penalty_slope:[0,2],frequency_penalty:[-2,2],presence_penalty:[-2,2],max_tokens:[1,8192]};
  const out={};
  for(const [key,[min,max]]of Object.entries(ranges)){
    const raw=prefs?.[key];if(raw===null||raw===undefined||raw==='')continue;
    const n=Number(raw);
    if(!Number.isFinite(n)||n<min||n>max)throw Error(key+' は '+min+'〜'+max+' の範囲にしてください。');
    out[key]=['top_k','repeat_last_n','max_tokens'].includes(key)?Math.floor(n):n;
  }
  return out;
}
function promptFrame(p){
  const desiredTokens=Number(p.max_tokens)||Math.min(4096,Math.ceil(p.targetChars*2.2)+128);
  const outputTokens=Math.max(1,Math.min(desiredTokens,Math.floor(p.contextTokens/2)));
  const inputBudget=Math.max(0,Math.floor((p.contextTokens-outputTokens-160)*0.66));
  const directives=[
    'あなたはユーザーが参加する対話型日本語フィクションの語り手です。本文だけを書いてください。',
    'ユーザー本人の新しい台詞・行動・感情・思考・決断は勝手に創作してはいけません。入力された行動・台詞はそのまま物語の因果に取り込んでください。',
    '他の登場人物の台詞と反応、環境、出来事、自然な進展を描写してください。唐突な設定改変や大きな時間跳躍を避けてください。',
    '[見出し:項目≡<内容>] は人物・設定の項目と値を意味する記法です。記法自体は本文に出力しません。',
    '前のターンの描写や同じ表現を繰り返さず、過度に類似する返答を避けてください。入力併記用の見出し「【あなたの入力】」は出力しないでください。',
    '展開速度：'+p.pace+'。視点：'+p.pov+'。生成の目安：約'+p.targetChars+'文字。',
    p.recordInputInBody?'ユーザー入力はアプリ側で確定本文へ原文を追加します。あなたは入力文を繰り返さず、他の人物の反応と物語の続きを描写してください。入力されていない本人の台詞・行動・内心は創作しないでください。':p.includeInput?'今回の入力でユーザーが実際に記載した言葉・行動だけを本文へ必要に応じて自然に含めてください。記載のない本人の台詞・行動・内心は加えないでください。':'今回の入力内容を確定した事実として扱い、本人の入力を長々と繰り返さず相手の反応から描写してください。記載のない本人の台詞・行動・内心は創作しないでください。'
  ].join('\n');
  const prefix='今回の入力：\n',suffix='\n\n【最重要】ユーザー本人の新しい台詞・行動・内心を代筆しない。禁止ワード・展開を守る。設定記法を出力しない。物語本文のみ続ける。';
  return {desiredTokens,outputTokens,inputBudget,directives,prefix,suffix,
    inputLimit:Math.max(0,Math.min(PROMPT_INPUT_LIMIT,inputBudget-directives.length-prefix.length-suffix.length))};
}
export function buildRequest(state,userText){
  const d=cleanState({...state,branches:[]}),p=d.prefs;
  const {desiredTokens,outputTokens,inputBudget,directives,prefix,suffix,inputLimit}=promptFrame(p);
  const input=String(userText||'');
  const warning=inputLimitWarning(input);
  if(warning)throw Error(warning);
  const final=prefix+input+suffix;
  let remaining=Math.max(0,inputBudget-directives.length-final.length);
  const recent=d.turns.slice(-5).filter(t=>t.user.trim()&&!isSyntheticInput(t.user));
  const historyFor=turns=>turns.map((t,i)=>String(i+1)+'. '+t.user.trim().slice(0,300)).join('\n');
  const historyText=historyFor(recent);
  const sections=[
    ['ユーザーの役割','player',false],
    ['絶対に守るルール','rules',false],
    ['禁止する展開','avoidPlot',false],
    ['禁止ワード','avoidWords',false],
    ['人物設定','characters',false],
    ['自由記憶（最新の追記を優先）','memory',true],
    ['世界観','world',false],
    ['あらすじ','synopsis',false],
    ['物語のゴール','goal',false]
  ];
  const entries=sections.filter(([,key])=>d[key].trim()).map(([title,key,latest])=>({
    title,key,latest,quota:0,length:d[key].length,header:'\n\n【'+title+'】\n'
  }));
  // Count actual headings and separators. No minimum optional quota.
  const selected=[];
  for(const e of entries){
    if(remaining>=e.header.length+1){remaining-=e.header.length+1;e.quota=1;selected.push(e);}
  }
  const historyHeader='\n\n【直近のユーザー入力・行動（確定済み）】\n';
  const bodyHeader='\n\n【確定本文の末尾】\n';
  const bodyQuota=d.body&&remaining>=300?Math.min(d.body.length+bodyHeader.length,p.contextChars+bodyHeader.length,Math.floor(remaining*0.40)):0;
  if(bodyQuota>bodyHeader.length)remaining-=bodyQuota;
  const historyQuota=historyText&&remaining>=200?Math.min(historyText.length+historyHeader.length,700,Math.floor(remaining*0.15)):0;
  const historyBudget=Math.max(0,historyQuota-historyHeader.length);
  if(historyBudget)remaining-=historyQuota;
  let active=selected.filter(e=>e.quota<e.length);
  while(remaining>0&&active.length){
    const share=Math.max(1,Math.floor(remaining/active.length));
    for(const item of active){
      if(remaining===0)break;
      const take=Math.min(remaining,share,item.length-item.quota);
      item.quota+=take;remaining-=take;
    }
    active=active.filter(e=>e.quota<e.length);
  }
  function head(s,n){
    let end=Math.min(s.length,n);
    if(end>0&&end<s.length&&s.charCodeAt(end)>=0xdc00&&s.charCodeAt(end)<=0xdfff)end--;
    return s.slice(0,end);
  }
  const allocations=entries.map(e=>{
    const text=e.quota?(e.latest?safeTail(d[e.key],e.quota):head(d[e.key],e.quota)):'';
    return {title:e.title,key:e.key,omitted:e.length-text.length,text,header:e.header};
  });
  let system=directives;
  for(const e of allocations)if(e.text)system+=e.header+e.text;
  let space=Math.max(0,inputBudget-system.length-final.length);
  const preliminaryHistory=safeTail(historyText,historyBudget);
  const historySpace=preliminaryHistory&&space>=historyHeader.length+preliminaryHistory.length?historyHeader.length+preliminaryHistory.length:0;
  const body=safeTail(d.body,Math.max(0,Math.min(p.contextChars,space-historySpace-bodyHeader.length)));
  // Omit only input already present verbatim in the transmitted body tail.
  const tailStart=d.body.length-body.length;
  const userHistory=historySpace?safeTail(historyFor(recent.filter(t=>!(t.userPrelude&&Number.isSafeInteger(t.bodyStart)&&t.bodyStart>=tailStart&&d.body.slice(t.bodyStart,t.bodyStart+t.userPrelude.length)===t.userPrelude))),historyBudget):'';
  if(userHistory&&space>=historyHeader.length+userHistory.length){
    system+=historyHeader+userHistory;space-=historyHeader.length+userHistory.length;
  }
  if(body)system+=bodyHeader+body;
  else if(!d.body){
    const intro='\n\n【開始場面】\nまだ本文がありません。今回の入力と設定に合った物語の導入を描写してください。';
    if(space>=intro.length)system+=intro;
  }
  return {
    messages:[{role:'system',content:system},{role:'user',content:final}],
    meta:{characters:system.length+final.length,estimatedTokens:Math.ceil((system.length+final.length)/0.66),
      contextTokens:p.contextTokens,outputTokens,inputLimit,inputBudget,omitted:allocations.filter(a=>a.omitted>0),
      bodyOmitted:Math.max(0,d.body.length-body.length),
      overBudget:system.length+final.length>inputBudget,
      outputCapped:desiredTokens>outputTokens,
      outputTooShort:outputTokens<Math.ceil(p.targetChars*1.5)}
  };
}
export function buildMessages(state,userText){return buildRequest(state,userText).messages;}
export function acceptTurn(state,candidate){
  const d=cleanState({...state,branches:[]}),text=String(candidate?.text||'').trim();
  if(!text)throw Error('候補が空です。');
  if(d.turns.length>=20000)throw Error('履歴が20,000ターンの上限に達しました。外部JSONへ保存して整理してください。');
  const input=String(candidate.user||'');
  const synthetic=isSyntheticInput(input);
  // Reply edits pass the historical prelude, including an empty string.
  const prelude=synthetic?'':typeof candidate.userPrelude==='string'?candidate.userPrelude:
    d.prefs.recordInputInBody&&input.trim()?'【あなたの入力】\n'+input.trim()+'\n\n':'';
  const prefix=d.body?'\n\n':'';
  const bodySegment=prelude+text;
  if(d.body.length+prefix.length+bodySegment.length>BODY_LIMIT)
    throw Error('本文の入力上限を超えています。先にJSONを保存してください。');
  const before=d.body;
  d.body+=prefix+bodySegment;
  d.turns.push({user:input,...(prelude?{userPrelude:prelude}:{}),
    preview:bodySegment.slice(0,240),replyHash:bodyFingerprint(bodySegment),
    at:new Date().toISOString(),bodyStart:before.length+prefix.length,bodyEnd:d.body.length});
  // Latest-turn undo uses the validated timeline and reply trash, not a duplicate reply.
  d.undo=null;
  d.pendingCandidate=null;
  d.draft=!candidate.preserveDraft&&d.draft===candidate.sourceDraft?'':d.draft;
  d.branches=state.branches||[];
  return d;
}
// Legacy-only helper: old v1 undo records remain readable; the UI uses rewindLastWithoutFork.
export function undoTurn(state){
  const d=cleanState({...state,branches:[]}),u=d.undo;
  if(!u||d.body.length!==u.beforeLength+u.added.length||!d.body.endsWith(u.added)||checksum(d.body)!==u.afterHash||d.turns.length!==u.beforeTurns+1)throw Error('本文が編集されているため安全に取り消せません。');
  d.body=d.body.slice(0,u.beforeLength);d.turns=d.turns.slice(0,u.beforeTurns);
  if(!d.draft)d.draft=editableTurnInput(u.input);
  d.undo=null;d.branches=state.branches||[];return d;
}
export function readableText(state,format){
  const d=cleanState({...state,branches:[]}),title=(d.title.trim()||'無題の作品').replace(/[\r\n]/g,' ');
  if(format==='txt')return 'TALKING_STORY_TXT_V2\n作品：'+title+'\n\n'+d.body;
  if(format==='md')return '<!-- TALKING_STORY_MD_V2 -->\n# '+title+'\n\n'+d.body;
  throw Error('未対応の形式です。');
}

// V2 branch-prefix: sorted adjacent bodies share their longest common prefix,
// including siblings which diverged early from the active branch. Old v2 reads remain.
function commonPrefix(a,b){
  let n=0;const limit=Math.min(a.length,b.length);
  while(n<limit&&a.charCodeAt(n)===b.charCodeAt(n))n++;
  if(n>0&&n<b.length&&b.charCodeAt(n)>=0xdc00&&b.charCodeAt(n)<=0xdfff)n--;
  return n;
}
export function compactBackup(state){
  const d=cleanState(state);
  if(d.branches.some(isArchiveReference))throw Error('軽量JSONの作成前に分岐を読み込んでください。');
  const bodies=[d.body,...d.branches.map(b=>b.body)];
  const sorted=bodies.map((body,index)=>({body,index})).sort((a,b)=>a.body<b.body?-1:a.body>b.body?1:a.index-b.index);
  const indices=[],entries=[];
  sorted.forEach(({body,index},i)=>{
    const prefix=i?commonPrefix(sorted[i-1].body,body):0;
    entries.push({base:prefix?i-1:null,prefix,suffix:body.slice(prefix)});
    indices[index]=i;
  });
  const payload={...d,body:indices[0],branches:d.branches.map((b,i)=>({...b,body:indices[i+1]}))};
  return JSON.stringify({schema:FORMAT,version:2,kind:'branch-prefix',entries,payload});
}
export function expandCompactBackup(value){
  if(value?.schema!==FORMAT||value?.version!==2||!value.payload||typeof value.payload!=='object')
    throw Error('軽量JSONバックアップの形式が正しくありません。');
  const raw=value.payload;
  if(!Array.isArray(raw.branches)||raw.branches.length>30)
    throw Error('軽量JSONの分岐数が不正です。');
  let unpack;
  if(value.kind==='shared-prefix'&&typeof value.baseBody==='string'){
    unpack=entry=>{
      if(!entry||!Number.isSafeInteger(entry.prefix)||entry.prefix<0||
         entry.prefix>value.baseBody.length||typeof entry.suffix!=='string')
        throw Error('共有本文の参照位置が不正です。');
      return value.baseBody.slice(0,entry.prefix)+entry.suffix;
    };
  }else if(value.kind==='branch-prefix'&&Array.isArray(value.entries)&&value.entries.length===raw.branches.length+1){
    const decoded=[];
    for(const entry of value.entries){
      if(!entry||!Number.isSafeInteger(entry.prefix)||entry.prefix<0||typeof entry.suffix!=='string')
        throw Error('共有本文の参照位置が不正です。');
      if(entry.base===null){
        if(entry.prefix!==0)throw Error('共有本文の参照位置が不正です。');
        decoded.push(entry.suffix);continue;
      }
      if(!Number.isSafeInteger(entry.base)||entry.base<0||entry.base>=decoded.length||entry.prefix>decoded[entry.base].length)
        throw Error('共有本文の参照位置が不正です。');
      decoded.push(decoded[entry.base].slice(0,entry.prefix)+entry.suffix);
    }
    const used=new Set();
    unpack=index=>{
      if(!Number.isSafeInteger(index)||index<0||index>=decoded.length||used.has(index))
        throw Error('共有本文の分岐参照が不正です。');
      used.add(index);return decoded[index];
    };
  }else throw Error('軽量JSONバックアップの形式が正しくありません。');
  return cleanState({...raw,body:unpack(raw.body),branches:raw.branches.map(b=>({...b,body:unpack(b.body)}))});
}

export function parseImport(filename,content,current){
  const src=String(content||'');
  if(new TextEncoder().encode(src).length>TRANSFER_MAX_BYTES)throw Error('ファイル容量が50MBを超えています。');
  const ext=String(filename||'').split('.').pop().toLowerCase();
  if(ext==='json'){
    let raw;try{raw=JSON.parse(src.replace(/^\uFEFF/,''));}catch{throw Error('JSONを解析できません。');}
    if(raw?.schema!==FORMAT||![1,2].includes(raw?.version))throw Error('対応しているv1/v2バックアップではありません。');
    return {state:raw.version===2?expandCompactBackup(raw):cleanState(raw),full:true};
  }
  if(!['txt','md'].includes(ext))throw Error('JSON、TXT、MDのみ読み込めます。');
  const d=cleanState(current);
  let text=src.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  const marker=ext==='md'?'<!-- TALKING_STORY_MD_V2 -->\n':'TALKING_STORY_TXT_V2\n';
  const legacyName=/_\d{4}-\d{2}-\d{2}\.(txt|md)$/i.test(String(filename));
  if(text.startsWith(marker)||legacyName){
    if(text.startsWith(marker))text=text.slice(marker.length);
    const header=ext==='md'?/^# ([^\n]*)\n\n/:/^作品：([^\n]*)\n\n/;
    const match=header.exec(text);
    if(match){d.title=match[1]||'無題の作品';text=text.slice(match[0].length);}
  }
  d.body=text;d.turns=[];d.undo=null;d.pendingCandidate=null;
  return {state:d,full:false};
}
