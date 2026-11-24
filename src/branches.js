// Non-destructive branching for prior turns. No Layla-specific dependencies.
// Active branch stays in root body/turns/settings for v1 JSON compatibility;
// inactive branches are full snapshots so none are silently overwritten.
import {cleanState,bodyFingerprint,acceptTurn,FIELDS} from './logic.js';

export const MAX_ARCHIVED_BRANCHES=30;
export const SNAPSHOT_FIELDS=[
  ...FIELDS.map(([key])=>key),'body','turns','draft','pendingCandidate','undo','prefs'
];
const copy=x=>JSON.parse(JSON.stringify(x));
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
    found.push({start,end:stop,user:t.user,reply:content,index:i});
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
  return forked;
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
    b.name=label;
  }
  return s;
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
  const d=cleanState({...state,branches:[]}),newBody=String(nextBody);
  const positions=timeline(d),oldBody=d.body;
  let left=0,right=0;
  while(left<oldBody.length&&left<newBody.length&&oldBody[left]===newBody[left])left++;
  while(right<oldBody.length-left&&right<newBody.length-left&&
    oldBody[oldBody.length-1-right]===newBody[newBody.length-1-right])right++;
  const oldEnd=oldBody.length-right,newEnd=newBody.length-right;
  const delta=newBody.length-oldBody.length;
  const changed=positions.filter(p=>
    (left===oldEnd ? left>p.start&&left<p.end : left<p.end&&oldEnd>p.start));
  if(changed.length>1)throw Error('複数のターンにまたがる編集です。本文は保持しますが、履歴の再同期が必要です。');
  const change=changed[0]||null;
  if(change&&(left<change.start||oldEnd>change.end))
    throw Error('本文のターン境界にまたがる編集です。履歴の再同期が必要です。');
  d.body=newBody;
  d.turns=d.turns.map((t,i)=>{
    const original=positions[i],copyTurn={...t};
    if(change?.index===i){
      copyTurn.bodyEnd=original.end+delta;
    }else if(original.start>=oldEnd){
      copyTurn.bodyStart=original.start+delta;
      copyTurn.bodyEnd=original.end+delta;
    }
    const updated=d.body.slice(copyTurn.bodyStart,copyTurn.bodyEnd);
    if(change?.index===i){
      copyTurn.preview=updated.slice(0,240);
      copyTurn.replyHash=bodyFingerprint(updated);
      if(typeof copyTurn.reply==='string')copyTurn.reply=updated; // old v1 compatibility
    }
    return copyTurn;
  });
  d.undo=null;
  timeline(d);
  d.branches=state.branches||[];
  return d;
}
export function clearHistoryAgainstBody(state){
  const d=cleanState(state);
  d.turns=[];d.undo=null;d.pendingCandidate=null;
  return d;
}
