import {cleanState,parseImport,TRANSFER_MAX_BYTES} from './logic.js';
import {serializeBackup} from './export.js';

// Validate the complete set before reading any file. Preserve fragment text
// exactly, including a BOM character that happens to start an interior page.
export async function readImportFiles(input){
  const files=Array.isArray(input)?input:[input];
  if(!files.length||files.some(f=>!f||!Number.isSafeInteger(f.size)||f.size<0))throw Error('ファイルを選択してください。');
  if(files.reduce((sum,f)=>sum+f.size,0)>TRANSFER_MAX_BYTES)throw Error('合計50MB以下のファイルを選んでください。');
  const pattern=/^(.+\.(?:json|txt|md))\.part-(\d+)-of-(\d+)\.txt$/i;
  const parts=files.map(f=>pattern.exec(f.name));
  if(files.length===1&&!parts[0]){
    if(/\.part-\d+-of-\d+(?:\.|$)/i.test(files[0].name))throw Error('分割保存の断片です。全ページをまとめて選択してください。');
    return {name:files[0].name,raw:await files[0].text()};
  }
  if(parts.some(p=>!p))throw Error('分割保存の全ページだけをまとめて選択してください。');
  const name=parts[0][1],total=Number(parts[0][3]),ordered=new Map();
  if(!Number.isSafeInteger(total)||total<2||total!==files.length)throw Error('分割保存の断片です。全ページをまとめて選択してください。');
  for(let i=0;i<files.length;i++){
    const p=parts[i],index=Number(p[2]);
    if(p[1]!==name||Number(p[3])!==total||!Number.isSafeInteger(index)||index<1||index>total||ordered.has(index))
      throw Error('異なるバックアップ、重複または不正なページ番号が含まれています。');
    ordered.set(index,files[i]);
  }
  const chunks=[];
  for(let i=1;i<=total;i++){
    const f=ordered.get(i);
    if(!f)throw Error('分割保存のページが不足しています。');
    chunks.push(typeof f.arrayBuffer==='function'
      ?new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(await f.arrayBuffer())
      :await f.text());
  }
  return {name,raw:chunks.join('')};
}

// The actual import workflow, with UI/storage dependencies supplied by the caller.
export async function runImport(input,{store,getState,isSaveBlocked,modal,beforeDestructive,apply,unlockRecovery}){
  if(!store||(!store.hasStorage&&!store.corrupt))throw Error('保存先がありません。ファイルを読み込めません。既存の作品は変更していません。保存先を復旧してから再試行してください。');
  const {name,raw}=await readImportFiles(input);
  const current=getState(),parsed=parseImport(name,raw,current);
  const blocked=isSaveBlocked();
  const canKeep=!blocked;
  const count=current.branches.length;
  let choice;
  if(parsed.full){
    const options=[...(canKeep?[['keep','現在の分岐を残して本編のみ置換']]:[]),['replace','ファイルの分岐で全置換'],['cancel','キャンセル']];
    choice=await modal(name+' を読み込みます。\nファイルの保存済み分岐 '+parsed.state.branches.length+' 件／現在の保存済み分岐 '+count+' 件。\n全置換では現在の分岐がファイルの分岐に置き換わります。本編のみ置換では設定・記憶・本文・履歴等を読み込み、現在の分岐とアクティブ分岐IDを維持します。ファイル内の分岐は取り込みません。'+(canKeep?'':'\n読み取り専用の復旧中は分岐保持を安全に保証できないため全置換のみ可能です。')+'\n事前に外部JSONバックアップを取っていますか？',options);
    if(choice!=='replace'&&!(choice==='keep'&&canKeep))return false;
  }else{
    if(blocked&&count)throw Error('読み取り専用の保存先では現在の分岐を安全に保持できません。先に保存先を復旧してください。');
    if(await modal(name+' を読み込みます。置換対象: 本文と履歴のみ。現在の分岐 '+count+' 件は保持します。事前に外部JSONバックアップを取っていますか？')!=='yes')return false;
    choice='text';
  }
  // Check the storage again after the dialog. Never authorize a stale keep choice.
  if(isSaveBlocked()){
    if(choice==='keep'||(choice==='text'&&count))throw Error('保存先の状態が変わりました。分岐を保護するため中止しました。');
    if(store.recoveryRequired)throw Error('先に復旧元を選択してください。');
    if(await modal('現在の保存先は読み取り専用です。既存の異常データが残る場合があります。外部バックアップを確認した上で復旧を許可しますか？')!=='yes')return false;
    await store.allowImportRecovery();unlockRecovery();
  }else{
    // A keep/text import only changes the active work. An active checkpoint
    // avoids materializing unrelated lazy or damaged archived branches.
    if(!await beforeDestructive(choice==='replace'?'import':'本編読み込前',{scope:choice==='replace'?'full':'active'}))return false;
  }
  const latest=getState();
  const next=choice==='keep'?cleanState({...parsed.state,activeBranch:latest.activeBranch,branches:latest.branches}):
    choice==='text'?parseImport(name,raw,latest).state:parsed.state;
  await apply(next);
  return true;
}

export async function regenerateTurn({index,turn,state,modal,applyStoryChange,regenerateAt,showMain,scrollPrompt,startGeneration}){
  const latest=index===state.turns.length-1;
  const explanation=latest?'直前の返信はごみ箱へ移し、分岐を増やさず再生成します。未採用候補もごみ箱に移ります。入力途中の下書きは入力欄に残し、元のターンの入力で再生成します。':'元のストーリー全体は別の分岐に残し、選択ターンの前から再生成します。';
  if(await modal('第'+(index+1)+'ターンの返信を再生成します。\n'+explanation)!=='yes')return false;
  const preserveDraft=latest&&state.draft.length>0;
  if(!await applyStoryChange(s=>regenerateAt(s,index),latest?'直前の返信をごみ箱へ移しました。':'再生成用の分岐を作成しました'))return false;
  showMain({scroll:false});scrollPrompt();await startGeneration({inputOverride:turn.user,preserveDraft});
  return true;
}

export function stoppedCandidate(candidate,retryFallback){
  const used=!candidate?.text?.trim()&&Boolean(retryFallback?.text?.trim());
  const next=candidate?.text?.trim()?candidate:used?retryFallback:null;
  if(next)next.note=used?(next.note||'')+'／再生成を停止して前の候補に戻しました。':'停止しました。途中までの文章を採用するか編集できます。';
  return next;
}

// The completion timer and generation marker are injected for deterministic tests.
export function waitForStop({finalizing,requestedAt,isCurrent,onRelease,now=Date.now,schedule=setTimeout}){
  let released=false;
  const release=confirmed=>{
    if(released||!isCurrent())return;
    released=true;onRelease(confirmed);
  };
  if(finalizing)Promise.resolve(finalizing).then(()=>schedule(()=>release(true),Math.max(0,requestedAt+750-now())),()=>release(false));
  schedule(()=>release(false),5000);
}

export function exportPlan(ext,snapshot){
  const light=ext==='compact-json',mainOnly=ext==='main-json',json=light||mainOnly||ext==='json';
  const branchChars=snapshot.branches.reduce((n,b)=>n+(b.chars??b.body?.length??0),0);
  return {light,mainOnly,json,large:(light||ext==='json')&&branchChars+snapshot.body.length>5000000,
    mime:json?'application/json':ext==='md'?'text/markdown':'text/plain',
    suffix:light?'_軽量分岐':mainOnly?'_本編のみ':''};
}


// Only a branch read failure permits the explicitly confirmed main-only backup.
// Oversize JSON and unrelated serialization errors must not silently drop data.
export async function exportJsonWithFallback(snapshot,loadBranch,{compact=false,maxBytes=TRANSFER_MAX_BYTES,confirmMain}={}){
  let failedBranch=null;
  try{
    const content=await serializeBackup(snapshot,async b=>{
      try{return await loadBranch(b);}
      catch(e){failedBranch=b;throw e;}
    },{compact,maxBytes});
    return {content,mainOnly:false,cancelled:false};
  }catch(e){
    if(!failedBranch)throw e;
    if(!await confirmMain(failedBranch,e))return {content:null,mainOnly:false,cancelled:true};
    return {content:JSON.stringify({...snapshot,branches:[]}),mainOnly:true,cancelled:false};
  }
}

// Manual-only, cooperative cancellation between individual archive reads.
// A new manual invocation starts from the first branch, never reuses stale progress.
export async function checkArchivesManually(branches,{isCurrent,check,onResult,pause}){
  for(let i=0;i<branches.length;i++){
    if(!isCurrent())return false;
    const result=await check(branches[i]);
    if(!isCurrent())return false;
    onResult(branches[i],result,i+1,branches.length);
    await pause();
  }
  return isCurrent();
}
