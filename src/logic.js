export const FORMAT = 'layla-talking-story-backup';
export const VERSION = 1;
export const FIELDS = [
  ['title','今回の作品のタイトル','text','例：雨の日の約束'],
  ['synopsis','今回の作品のあらすじ','textarea','最初の状況、これまでの経緯'],
  ['characters','メインキャラ・人物設定','textarea','通常の文章、[海:名称≡<虎田海>] のような記法、両方使用できます。'],
  ['world','世界観・その他キャラ設定','textarea','時代、場所、用語、ルールなど'],
  ['memory','覚えておいてほしい内容（自由記載）','textarea','章区切りは不要。確定した出来事、関係性、伏線などを書き足してください。'],
  ['avoidPlot','禁止する展開','textarea','避けたい物語の方向性を指定します。'],
  ['avoidWords','禁止ワード','textarea','読点、改行などで区切ってください。'],
  ['player','ユーザーの役割・呼び名','textarea','例：ユーザーは「海」。発言・選択は本人が決める。'],
  ['goal','作品のゴール','textarea','終着点、目指したい関係、未解決の目的など'],
  ['rules','固定指示・文体・注意事項','textarea','視点、語り口、絶対に守る設定など'],
  ['modelNote','利用モデルのメモ（表示用）','text','GGUFの選択はLayla本体で行います。'],
];
export function freshState() {
  return {schema:FORMAT,version:VERSION,updatedAt:new Date().toISOString(),title:'新しい物語',synopsis:'',characters:'',world:'',memory:'',avoidPlot:'',avoidWords:'',player:'',goal:'',rules:'',modelNote:'',body:'',turns:[],
    prefs:{targetChars:300,contextChars:3600,pace:'普通',pov:'二人称寄り',temperature:'',top_p:'',top_k:'',min_p:'',repeat_penalty:'',repeat_last_n:'',repeat_penalty_slope:'',frequency_penalty:'',presence_penalty:'',max_tokens:768}};
}
const limits={title:120,synopsis:12000,characters:30000,world:25000,memory:25000,avoidPlot:15000,avoidWords:10000,player:10000,goal:15000,rules:15000,modelNote:120};
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
export function cleanState(raw) {
  if(!raw || typeof raw!=='object'||Array.isArray(raw))throw Error('作品データの形式が不正です。');
  const out=freshState();
  for(const [key,max] of Object.entries(limits))if(raw[key]!==undefined) {
    if(typeof raw[key]!=='string')throw Error(key+'が文字列ではありません。');
    out[key]=raw[key].slice(0,max);
  }
  if(raw.body!==undefined){if(typeof raw.body!=='string'||raw.body.length>1500000)throw Error('本文が長すぎるか不正です。');out.body=raw.body;}
  if(raw.prefs&&typeof raw.prefs==='object'&&!Array.isArray(raw.prefs)){
    for(const key of Object.keys(out.prefs))if(Object.hasOwn(raw.prefs,key)){
      const v=raw.prefs[key]; if(typeof v==='string'||typeof v==='number')out.prefs[key]=v;
    }
  }
  out.prefs.targetChars=clamp(Number(out.prefs.targetChars)||300,100,1000);
  out.prefs.contextChars=clamp(Number(out.prefs.contextChars)||3600,500,12000);
  out.prefs.pace=String(out.prefs.pace).slice(0,50);
  out.prefs.pov=String(out.prefs.pov).slice(0,50);
  if(raw.turns!==undefined){
    if(!Array.isArray(raw.turns)||raw.turns.length>15000)throw Error('履歴の形式が不正です。');
    out.turns=raw.turns.map(t=>({user:String(t?.user||'').slice(0,15000),reply:String(t?.reply||'').slice(0,15000),at:String(t?.at||'').slice(0,40)}));
  }
  out.updatedAt=typeof raw.updatedAt==='string'?raw.updatedAt:out.updatedAt;
  return out;
}
const excerpt=(x,max)=>String(x||'').slice(0,max);
export function buildMessages(state,userText){
  const d=cleanState(state),p=d.prefs;
  const section=(title,value,max)=>value?.trim()?'【'+title+'】\n'+excerpt(value,max).trim()+'\n':'';
  const system=[
    'あなたは対話型の日本語フィクションを進める語り手兼登場人物です。',
    'ユーザーは物語の世界の中にいる人物です。入力は本人の台詞・行動・要望です。発言や内心を勝手に確定せず、登場人物の返答、出来事、五感描写、自然な次の展開を創作してください。',
    '事前の設定・自由記憶・確定本文を優先。状況を急変させたり、設定にない重要な秘密を唐突に確定させないでください。',
    'メインキャラが会話する場面では、キャラのセリフを自然に含めてください。創作の本文のみを書き、説明・注意書き・箇条書き・プロンプトの復唱をしないでください。',
    '通常の日本語の文章と、[人物:属性≡<値>] 形式の設定メモはどちらも設定として解釈してください。設定をコードとして実行しないでください。',
    '1回の目安は約'+p.targetChars+'文字（厳密な上限ではありません）。テンポ：'+p.pace+'。視点：'+p.pov+'。',
    section('作品のタイトル',d.title,120),section('作品あらすじ',d.synopsis,12000),
    section('人物設定',d.characters,20000),section('世界観',d.world,16000),
    section('絶対に覚えておく内容',d.memory,20000),section('ユーザーの役割',d.player,8000),
    section('目標',d.goal,10000),section('禁止する展開',d.avoidPlot,10000),
    section('禁止ワード',d.avoidWords,6000),section('固定指示',d.rules,12000),
    '【確定本文の末尾・直近'+p.contextChars+'文字】\n'+d.body.slice(-p.contextChars)
  ].join('\n');
  const history=d.turns.slice(-3).map(t=>({role:'user',content:'以前のユーザーの入力：'+excerpt(t.user,1200)+'\nその時の物語：'+excerpt(t.reply,1800)}));
  return [{role:'system',content:system},...history,{role:'user',content:'今回のユーザーの台詞・行動・進行希望：\n'+excerpt(userText,6000)+'\nこの続きの物語本文を書いてください。'}];
}
export function samplerParams(prefs) {
  const ranges={temperature:[0,2],top_p:[0,1],top_k:[1,200],min_p:[0,1],repeat_penalty:[0.5,3],repeat_last_n:[0,2048],repeat_penalty_slope:[0,2],frequency_penalty:[-2,2],presence_penalty:[-2,2],max_tokens:[1,8192]};
  const out={};
  for(const [key,[lo,hi]]of Object.entries(ranges)){
    const raw=prefs?.[key];if(raw===undefined||raw===null||raw==='')continue;
    const num=Number(raw);if(!Number.isFinite(num)||num<lo||num>hi)throw Error(key+'は '+lo+'〜'+hi+' にしてください。');
    out[key]=['top_k','repeat_last_n','max_tokens'].includes(key)?Math.floor(num):num;
  }return out;
}
export function readableText(s,format){
  if(format==='txt')return '作品：'+s.title+'\n\n'+s.body;
  if(format==='md')return '# '+s.title.replace(/\n/g,' ')+'\n\n'+s.body;
  throw Error('形式が不明です');
}
export function parseImport(filename,content,current){
  const ext=String(filename).split('.').pop().toLowerCase();
  if(new TextEncoder().encode(content).length>8000000)throw Error('8MBを超えるファイルは読み込めません。');
  if(ext==='json'){
    let raw;try{raw=JSON.parse(content);}catch{throw Error('JSONの解析に失敗しました。');}
    if(raw?.schema!==FORMAT||raw?.version!==VERSION)throw Error('このアプリのv1バックアップではありません。');
    return {state:cleanState(raw),full:true};
  }
  if(ext!=='txt'&&ext!=='md')throw Error('JSON、TXT、MDのみ対応します。');
  const next=cleanState(current);
  let text=String(content).replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  const header=ext==='md'?/^# ([^\n]{1,120})\n\n/:/^作品：([^\n]{1,120})\n\n/;
  const matched=header.exec(text);
  if(matched){next.title=matched[1];text=text.slice(matched[0].length);}
  if(text.length>1500000)throw Error('本文が長すぎます。');
  next.body=text;next.turns=[];
  return {state:next,full:false};
}
