// Non-destructive branching for prior turns. No Layla-specific dependencies.
// Active branch stays in root body/turns/settings for v1 JSON compatibility;
// inactive branches are full snapshots so none are silently overwritten.
import {cleanState,bodyFingerprint,acceptTurn,FIELDS,isArchiveReference,rememberReply} from './logic.js';

export const MAX_ARCHIVED_BRANCHES=30;
export const SNAPSHOT_FIELDS=[
  ...FIELDS.map(([key])=>key).filter(key=>key!=='modelNote'),'body','turns','draft','pendingCandidate','undo'
];
const copy=x=>x===null||typeof x!=='object'?x:JSON.parse(JSON.stringify(x));
export function branchMeta(raw={},fallbackId='main',fallbackName='本編'){
  const id=typeof raw?.id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(raw.id)?raw.id:fallbackId;
  const name=typeof raw?.name==='string'&&raw.name.trim()?raw.name.trim().slice(0,90):fallbackName;
  const createdAt=typeof raw?.createdAt==='string'?raw.createdAt:new Date().toISOString();
  const parentId=typeof raw?.parentId==='string'?raw.parentId:null;
  const forkTurn=Number.isSafeInteger(raw?.forkTurn)?raw.forkTurn:null;
  return {id,name,createdAt,parentId,forkTurn};
}
export function snapshot(state,meta){
  const obj={...branchMeta(meta)};
  for(const key of SNAPSHOT_FIELDS)obj[key]=copy(state[key]);
  return obj;
}
function newId(){return 'b'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,10);}
export function timeline(state){
  if(typeof state.body!=='string'||!Array.isArray(state.turns))throw Error('本文または履歴が不正です。');
  const found=[];let end=0;
  for(let i=0;i<state.turns.length;i++){
    const t=state.turns[i];
    let start=t.bodyStart,stop=t.bodyEnd;
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(stop)){
      if(typeof t.reply!=='string'||!t.reply.length)
        throw Error('第'+(i+1)+'ターンに本文位置情報がありません。旧履歴はJSONで保管してください。');
      start=state.body.indexOf(t.reply,end);
      stop=start+t.reply.length;
    }
    if(start<end||stop<start||stop>state.body.length)
      throw Error('第'+(i+1)+'ターンの本文位置が一致しません。');
    const content=state.body.slice(start,stop);
    if(t.reply!==undefined&&content!==t.reply)
      throw Error('第'+(i+1)+'ターンの本文が送信履歴と異なります。');
    if(t.preview!==undefined&&!content.startsWith(t.preview))
      throw Error('第'+(i+1)+'ターンが直接編集され、履歴と一致しません。');
    if(t.replyHash&&bodyFingerprint(content)!==t.replyHash)
      throw Error('第'+(i+1)+'ターンの本文が編集済みです。');
    if(t.userPrelude&&(!content.startsWith(t.userPrelude)||t.userPrelude.length>=content.length))
      throw Error('第'+(i+1)+'ターンのユーザー入力併記部分が編集済みです。履歴を再設定してください。');
    found.push({start,end:stop,user:t.user,reply:t.userPrelude?content.slice(t.userPrelude.length):content,
      fullText:content,index:i});
    end=stop;
  }
  return found;
}
export function timelineAt(state,index){
  if(!Number.isSafeInteger(index)||index<0||index>=state.turns.length)
    throw Error('指定したターンは存在しません。');
  return timeline(state)[index];
}
function prefixBefore(body,position){
  return position>=2&&body.slice(position-2,position)==='\n\n'?position-2:position;
}
export function forkAt(state,{index,after=false,label='別の展開'}={}){
  const s=cleanState(state);
  const positions=timeline(s);
  if(!Number.isInteger(index)||index<0||index>positions.length|| (after&&index>=positions.length))
    throw Error('分岐先のターン番号が不正です。');
  const archived=s.branches||[];
  if(archived.length>=MAX_ARCHIVED_BRANCHES)
    throw Error('分岐が'+MAX_ARCHIVED_BRANCHES+'個あります。外部JSONバックアップ後、不要な分岐を明示的に削除してください。');
  const cut=after?positions[index].end:(index===positions.length?s.body.length:prefixBefore(s.body,positions[index].start));
  const keep=after?index+1:index;
  const archivedCurrent=snapshot(s,s.activeBranch);
  const forkName=String(label||'別の展開').trim().slice(0,90);
  const forked={
    ...s,body:s.body.slice(0,cut),turns:s.turns.slice(0,keep),
    draft:'',pendingCandidate:null,undo:null,
    branches:[...archived,archivedCurrent],
    activeBranch:branchMeta({id:newId(),name:forkName,parentId:s.activeBranch.id,forkTurn:keep})
  };
  // A timeline whose last turn is manually edited should never get silently reinterpreted.
  timeline(forked);
  return cleanState(forked);
}
export function rewindAfter(state,index){
  return forkAt(state,{index,after:true,label:'第'+(index+1)+'ターンまで戻した分岐'});
}
export function rewindBefore(state,index){
  return forkAt(state,{index,label:'第'+(index+1)+'ターンを取り消した分岐'});
}
export function editUserAt(state,index,replacement){
  const text=String(replacement||'').trim();
  if(!text||text.length>15000)throw Error('編集後の入力は1〜15000文字にしてください。');
  const old=timelineAt(state,index);
  const next=forkAt(state,{index,label:'第'+(index+1)+'ターンの入力を編集'});
  next.draft=text;return next;
}
export function editReplyAt(state,index,replacement){
  const text=String(replacement||'').trim();
  if(!text)throw Error('編集後の返信が空です。');
  const old=timelineAt(state,index);
  const next=forkAt(state,{index,label:'第'+(index+1)+'ターンの返信を編集'});
  next.draft=old.user;
  return acceptTurn(next,{user:old.user,text,sourceDraft:old.user});
}
export function regenerateAt(state,index){
  const old=timelineAt(state,index);
  if(index===state.turns.length-1){
    if(old.end!==state.body.length)throw Error('最終ターン後に独立した追記があります。元の展開を守るため、分岐で巻き戻してから再生成してください。');
    const next=rewindLastWithoutFork(state);next.draft=old.user;return next;
  }
  const next=forkAt(state,{index,label:'第'+(index+1)+'ターンの返信を再生成'});
  next.draft=old.user;
  return next;
}
export function switchBranch(state,id,{inheritLore=false}={}){
  const s=cleanState(state);
  if(id===s.activeBranch.id)return s;
  const i=s.branches.findIndex(b=>b.id===id);
  if(i<0)throw Error('分岐が見つかりません。');
  const target=s.branches[i];
  if(isArchiveReference(target))throw Error('切替先の分岐を先に読み込んでください。');
  const archivedCurrent=snapshot(s,s.activeBranch);
  const next={...s,branches:[...s.branches.slice(0,i),...s.branches.slice(i+1),archivedCurrent],
    activeBranch:branchMeta(target)};
  for(const key of SNAPSHOT_FIELDS)next[key]=copy(target[key]);
  // Sampler and model notes belong to the device/model, not one story fork.
  next.prefs=copy(s.prefs);next.modelNote=s.modelNote;
  if(inheritLore)for(const key of ['characters','world','memory','player'])next[key]=s[key];
  return cleanState(next);
}
export function renameBranch(state,id,name){
  const label=String(name||'').trim();
  if(!label||label.length>90)throw Error('分岐名は1〜90文字です。');
  const s=cleanState(state);
  if(s.activeBranch.id===id)s.activeBranch.name=label;
  else{
    const b=s.branches.find(b=>b.id===id);
    if(!b)throw Error('分岐が見つかりません。');
    if(isArchiveReference(b))throw Error('分岐名の変更前に分岐を読み込んでください。');
    s.branches=s.branches.map(entry=>entry.id===id?{...entry,name:label}:entry);
  }
  return cleanState(s);
}
export function deleteInactiveBranch(state,id){
  const s=cleanState(state);
  if(id===s.activeBranch.id)throw Error('現在表示中の分岐は削除できません。');
  if(!s.branches.some(b=>b.id===id))throw Error('分岐が見つかりません。');
  s.branches=s.branches.filter(b=>b.id!==id);
  return s;
}


// Reconcile a normal single-range direct text edit with per-turn offsets.
// Only resync when the change is confined to one reply or to material outside
// replies; multi-turn replacements must go through explicit history reset.
export function reconcileBodyEdit(state,nextBody){
  // Validation and position discovery are limited to the active branch.
  const d=cleanState({...state,branches:[]}),newBody=String(nextBody);
  if(newBody===d.body){d.branches=state.branches||[];return d;}
  const positions=timeline(d),oldBody=d.body;
  // Compare unchanged spans in blocks; only inspect individual code units
  // inside the two boundary blocks (UTF-16 offsets match textarea positions).
  const block=4096,limit=Math.min(oldBody.length,newBody.length);
  let left=0,right=0;
  while(left+block<=limit&&oldBody.slice(left,left+block)===newBody.slice(left,left+block))left+=block;
  while(left<limit&&oldBody[left]===newBody[left])left++;
  const remaining=limit-left;
  while(right+block<=remaining&&
    oldBody.slice(oldBody.length-right-block,oldBody.length-right)===newBody.slice(newBody.length-right-block,newBody.length-right))right+=block;
  while(right<remaining&&oldBody[oldBody.length-1-right]===newBody[newBody.length-1-right])right++;
  const oldEnd=oldBody.length-right;
  const delta=newBody.length-oldBody.length;
  const insertion=left===oldEnd;
  // When inserting exactly at a reply boundary, attach new text to the
  // previous reply at its end; at a reply's start attach it to that reply.
  let changed=positions.filter(p=>insertion?
    (left>p.start&&left<p.end):
    (left<p.end&&oldEnd>p.start));
  if(insertion&&changed.length===0){
    const preceding=positions.filter(p=>p.end===left);
    if(preceding.length)changed=[preceding[preceding.length-1]];
    else changed=positions.filter(p=>p.start===left).slice(0,1);
  }
  if(changed.length>1)throw Error('複数ターンにまたがる本文編集です。履歴の再設定が必要です。');
  const change=changed[0]||null;
  if(change&&!insertion&&(left<change.start||oldEnd>change.end))
    throw Error('ターン境界を跨ぐ本文編集です。履歴の再設定が必要です。');
  d.body=newBody;
  d.turns=d.turns.map((turn,i)=>{
    const old=positions[i],t={...turn,bodyStart:old.start,bodyEnd:old.end};
    if(change?.index===i)t.bodyEnd+=delta;
    else if(old.start>=oldEnd){t.bodyStart+=delta;t.bodyEnd+=delta;}
    if(change?.index===i){
      const reply=d.body.slice(t.bodyStart,t.bodyEnd);
      if(t.userPrelude&&(!reply.startsWith(t.userPrelude)||t.userPrelude.length>=reply.length))
        throw Error('ユーザー入力併記部分が編集済みです。履歴を再設定してください。');
      t.preview=reply.slice(0,240);
      t.replyHash=bodyFingerprint(reply);
      if(typeof t.reply==='string')t.reply=reply; // legacy v1 backup
    }
    return t;
  });
  d.undo=null;
  // The original timeline was fully verified. Outside the changed range the
  // bytes are identical, so only the edited reply needs a new fingerprint.
  // Check the resulting offsets without re-slicing/re-hashing every reply.
  let previousEnd=0;
  for(const t of d.turns){
    if(t.bodyStart<previousEnd||t.bodyEnd<t.bodyStart||t.bodyEnd>newBody.length)
      throw Error('補正後の本文位置が一致しません。');
    previousEnd=t.bodyEnd;
  }
  d.branches=state.branches||[];
  return d;
}
// Latest-turn undo does not create a branch or depend on legacy state.undo.
// Keep only the discarded reply (plus any displaced pending candidate).
export function rewindLastWithoutFork(state){
  const d=cleanState({...state,branches:[]});
  const turns=timeline(d);
  if(!turns.length)throw Error('取り消せるターンがありません。');
  const last=turns[turns.length-1];
  d.replyTrash=rememberReply(d.replyTrash,d.pendingCandidate?.text);
  d.replyTrash=rememberReply(d.replyTrash,last.reply);
  // Preserve any independent manually appended text after the last turn.
  d.body=d.body.slice(0,prefixBefore(d.body,last.start))+d.body.slice(last.end);
  d.turns.pop();
  if(!d.draft.trim())d.draft=last.user||d.draft;
  d.undo=null;d.pendingCandidate=null;
  d.branches=state.branches||[];
  return d;
}
export function clearHistoryAgainstBody(state){
  const d=cleanState(state);
  d.turns=[];d.undo=null;d.pendingCandidate=null;
  return d;
}

// Session-local recovery anchor: a validated active-only snapshot. Do not
// advance it on a series of small deletions or on ordinary autosaves.
export function makeBodyRecovery(){
  let anchor=null;
  return {
    reset(){anchor=null;},
    seed(state){if(!anchor&&state.body.length)anchor=cleanState({...state,branches:[]});},
    plan(state,nextLength){
      if(!state.body.length)return null;
      const shrinking=nextLength<state.body.length;
      const fresh=!anchor;
      if(fresh||(shrinking&&state.body.length>anchor.body.length))
        anchor=cleanState({...state,branches:[]});
      const large=anchor.body.length>500&&nextLength<anchor.body.length*0.5;
      if(large)return {snapshot:anchor,reason:'本文の累積・大幅削除前',large:true};
      if(fresh)return {snapshot:anchor,reason:'本文編集開始前',large:false};
      return null;
    },
    completed(plan,current){if(plan.large)anchor=cleanState({...current,branches:[]});},
    failed(plan){if(!plan.large&&anchor===plan.snapshot)anchor=null;}
  };
}
export const dailyCheckpointDue=(last,now=Date.now())=>last===null||now-last>=86400000;
