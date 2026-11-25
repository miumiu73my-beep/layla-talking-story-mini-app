// Pure data validation, prompt budgeting and reversible story state transitions.
export const FORMAT='layla-talking-story-backup',VERSION=1;
export const BODY_LIMIT=1500000,TRANSFER_MAX_BYTES=50000000;
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
    body:'',turns:[],draft:'',pendingCandidate:null,undo:null,
    activeBranch:{id:'main',name:'本編',createdAt:new Date().toISOString(),parentId:null,forkTurn:null},branches:[],
    prefs:{targetChars:300,contextChars:3600,contextTokens:8192,pace:'普通',
      pov:'ユーザー視点（二人称寄り）',autoAdopt:false,includeInput:true,recordInputInBody:false,
      temperature:'',top_p:'',top_k:'',min_p:'',repeat_penalty:'',
      repeat_last_n:'',repeat_penalty_slope:'',frequency_penalty:'',
      presence_penalty:'',max_tokens:''}};
}
// Only canonical, deeply immutable archived snapshots can bypass revalidation.
const canonicalArchives=new WeakSet();
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
  if(raw.pendingCandidate!==undefined&&raw.pendingCandidate!==null){
    const c=raw.pendingCandidate;
    if(!c||typeof c!=='object'||typeof c.user!=='string'||typeof c.text!=='string')throw Error('未採用候補が不正です。');
    d.pendingCandidate={user:c.user,text:c.text,sourceDraft:typeof c.sourceDraft==='string'?c.sourceDraft:'',baseFingerprint:typeof c.baseFingerprint==='string'?c.baseFingerprint:bodyFingerprint(c.baseBody||''),note:typeof c.note==='string'?c.note:''};
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
      if(canonicalArchives.has(b))return b;
      const clean=cleanState({...b,activeBranch:null,branches:[]});
      const entry={
        id:b.id,name:typeof b.name==='string'&&b.name.trim()?b.name.slice(0,90):'無題の分岐',
        createdAt:typeof b.createdAt==='string'?b.createdAt:'',
        parentId:typeof b.parentId==='string'?b.parentId:null,
        forkTurn:Number.isSafeInteger(b.forkTurn)?b.forkTurn:null
      };
      for(const key of Object.keys(LIMITS))entry[key]=clean[key];
      for(const key of ['body','turns','draft','pendingCandidate','undo','prefs'])entry[key]=clean[key];
      freezeArchive(entry);canonicalArchives.add(entry);
      return entry;
    });
  }
  d.updatedAt=typeof raw.updatedAt==='string'?raw.updatedAt:'legacy-v1';
  return d;
}
export function warningsForState(data){
  const d=cleanState({...data,branches:[]}),warnings=[];
  for(const [key,max] of Object.entries(LIMITS)){
    if(d[key].length>max)warnings.push(key+'：推奨入力上限を超過（既存データは保持）');
  }
  if(d.body.length>BODY_LIMIT)warnings.push('本文が150万字を超過しています。削除せず読み込みました。外部JSONへバックアップしてください。');
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
export function buildRequest(state,userText){
  const d=cleanState({...state,branches:[]}),p=d.prefs;
  const desiredTokens=Number(p.max_tokens)||Math.min(4096,Math.ceil(p.targetChars*2.2)+128);
  const outputTokens=Math.max(1,Math.min(desiredTokens,Math.floor(p.contextTokens/2)));
  const inputBudget=Math.max(600,Math.floor((p.contextTokens-Math.min(outputTokens,Math.floor(p.contextTokens*0.5))-160)*0.66));
  const input=String(userText||'').slice(0,6000);
  const directives=[
    'あなたはユーザーが参加する対話型日本語フィクションの語り手です。本文だけを書いてください。',
    'ユーザー本人の新しい台詞・行動・感情・思考・決断は勝手に創作してはいけません。入力された行動・台詞はそのまま物語の因果に取り込んでください。',
    '他の登場人物の台詞と反応、環境、出来事、自然な進展を描写してください。唐突な設定改変や大きな時間跳躍を避けてください。',
    '[見出し:項目≡<内容>] は人物・設定の項目と値を意味する記法です。記法自体は本文に出力しません。',
    '前のターンの描写や同じ表現を繰り返さず、過度に類似する返答を避けてください。',
    '展開速度：'+p.pace+'。視点：'+p.pov+'。生成の目安：約'+p.targetChars+'文字。',
    p.recordInputInBody?'ユーザー入力はアプリ側で確定本文へ原文を追加します。あなたは入力文を繰り返さず、他の人物の反応と物語の続きを描写してください。入力されていない本人の台詞・行動・内心は創作しないでください。':p.includeInput?'今回の入力でユーザーが実際に記載した言葉・行動だけを本文へ必要に応じて自然に含めてください。記載のない本人の台詞・行動・内心は加えないでください。':'今回の入力内容を確定した事実として扱い、本人の入力を長々と繰り返さず相手の反応から描写してください。記載のない本人の台詞・行動・内心は創作しないでください。'
  ].join('\n');
  const final='今回の入力：\n'+input+'\n\n【最重要】ユーザー本人の新しい台詞・行動・内心を代筆しない。禁止ワード・展開を守る。設定記法を出力しない。物語本文のみ続ける。';
  let available=Math.max(150,inputBudget-directives.length-final.length-200);
  // Keep previous USER intentions without re-sending assistant prose or stacking user roles.
  // The root body is still the authoritative narrative.
  const recent=d.turns.slice(-5).map(t=>t.user.trim()).filter(Boolean);
  let userHistory=recent.map((v,i)=>String(i+1)+'. '+v.slice(0,300)).join('\n');
  userHistory=safeTail(userHistory,Math.min(700,Math.floor(available*0.15)));
  available=Math.max(0,available-userHistory.length);
  const bodyReserve=d.body?Math.min(d.body.length,p.contextChars,Math.floor(available*0.40)):0;
  let remaining=Math.max(0,available-bodyReserve);
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
    title,key,latest,quota:0,length:d[key].length
  }));
  // Water filling: short fields free their unused share for longer ones.
  let active=entries.filter(e=>e.length);
  while(remaining>0&&active.length){
    const share=Math.max(1,Math.floor(remaining/active.length));
    for(const item of active){
      if(remaining===0)break;
      const take=Math.min(remaining,share,item.length-item.quota);
      item.quota+=take;remaining-=take;
    }
    active=active.filter(e=>e.quota<e.length);
  }
  const allocations=entries.map(e=>({
    title:e.title,key:e.key,omitted:e.length-e.quota,
    text:e.latest?safeTail(d[e.key],e.quota):d[e.key].slice(0,e.quota)
  }));
  const body=safeTail(d.body,Math.min(p.contextChars,bodyReserve+remaining));
  const parts=allocations.filter(a=>a.text).map(a=>'【'+a.title+'】\n'+a.text);
  if(userHistory)parts.push('【直近のユーザー入力・行動（すでに確定済み。返信本文は確定本文にあります）】\n'+userHistory);
  if(body)parts.push('【確定本文の末尾】\n'+body);
  else parts.push('【開始場面】\nまだ本文がありません。今回の入力と設定に合った物語の導入を描写してください。');
  const system=directives+'\n\n'+parts.join('\n\n');
  return {
    messages:[{role:'system',content:system},{role:'user',content:final}],
    meta:{characters:system.length+final.length,estimatedTokens:Math.ceil((system.length+final.length)/0.66),
      contextTokens:p.contextTokens,outputTokens,omitted:allocations.filter(a=>a.omitted>0),
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
  const synthetic=input.trim()==='この場面を自然に続きを進める'&&!String(candidate.sourceDraft||'').trim();
  const prelude=d.prefs.recordInputInBody&&!synthetic&&input.trim()
    ?'【あなたの入力】\n'+input.trim()+'\n\n':'';
  const prefix=d.body?'\n\n':'';
  const bodySegment=prelude+text;
  if(d.body.length+prefix.length+bodySegment.length>BODY_LIMIT)
    throw Error('本文の入力上限を超えています。先にJSONを保存してください。');
  const before=d.body,beforeTurns=d.turns.length;
  d.body+=prefix+bodySegment;
  d.turns.push({user:input,...(prelude?{userPrelude:prelude}:{}),
    preview:bodySegment.slice(0,240),replyHash:bodyFingerprint(bodySegment),
    at:new Date().toISOString(),bodyStart:before.length+prefix.length,bodyEnd:d.body.length});
  d.undo={beforeLength:before.length,added:prefix+bodySegment,afterHash:checksum(d.body),beforeTurns,input};
  d.pendingCandidate=null;
  d.draft=d.draft===candidate.sourceDraft?'':d.draft;
  d.branches=state.branches||[];
  return d;
}
export function undoTurn(state){
  const d=cleanState({...state,branches:[]}),u=d.undo;
  if(!u||d.body.length!==u.beforeLength+u.added.length||!d.body.endsWith(u.added)||checksum(d.body)!==u.afterHash||d.turns.length!==u.beforeTurns+1)throw Error('本文が編集されているため安全に取り消せません。');
  d.body=d.body.slice(0,u.beforeLength);d.turns=d.turns.slice(0,u.beforeTurns);
  if(!d.draft)d.draft=u.input;
  d.undo=null;d.branches=state.branches||[];return d;
}
export function readableText(state,format){
  const d=cleanState({...state,branches:[]}),title=(d.title.trim()||'無題の作品').replace(/[\r\n]/g,' ');
  if(format==='txt')return 'TALKING_STORY_TXT_V2\n作品：'+title+'\n\n'+d.body;
  if(format==='md')return '<!-- TALKING_STORY_MD_V2 -->\n# '+title+'\n\n'+d.body;
  throw Error('未対応の形式です。');
}

// Optional smaller JSON backup: keep v1 full backup available, while the v2
// variant shares long common body prefixes across archived branches.
// The normal app state and SQLite layout remain the original v1 schema.
export function compactBackup(state){
  const d=cleanState(state);
  const bodies=[d.body,...d.branches.map(b=>b.body)];
  const base=bodies.reduce((a,b)=>b.length>a.length?b:a,'');
  const pack=body=>{
    let common=0;
    while(common<body.length&&common<base.length&&body.charCodeAt(common)===base.charCodeAt(common))common++;
    if(common>0&&common<body.length&&common<base.length){
      const code=body.charCodeAt(common);
      if(code>=0xdc00&&code<=0xdfff)common--;
    }
    return {prefix:common,suffix:body.slice(common)};
  };
  const payload={...d,body:pack(d.body),
    branches:d.branches.map(b=>({...b,body:pack(b.body)}))};
  return JSON.stringify({schema:FORMAT,version:2,kind:'shared-prefix',baseBody:base,payload});
}
export function expandCompactBackup(value){
  if(value?.schema!==FORMAT||value?.version!==2||value.kind!=='shared-prefix'||
    typeof value.baseBody!=='string'||!value.payload||typeof value.payload!=='object')
    throw Error('軽量JSONバックアップの形式が正しくありません。');
  const unpack=entry=>{
    if(!entry||!Number.isSafeInteger(entry.prefix)||entry.prefix<0||
       entry.prefix>value.baseBody.length||typeof entry.suffix!=='string')
      throw Error('共有本文の参照位置が不正です。');
    return value.baseBody.slice(0,entry.prefix)+entry.suffix;
  };
  const raw=value.payload;
  if(!Array.isArray(raw.branches)||raw.branches.length>30)
    throw Error('軽量JSONの分岐数が不正です。');
  return cleanState({...raw,body:unpack(raw.body),
    branches:raw.branches.map(b=>({...b,body:unpack(b.body)}))});
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
