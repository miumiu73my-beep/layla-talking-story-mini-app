// Explicit user-operated export: do not claim success without checking iOS Files.
export function filename(title,ext,date=new Date()){
  const pad=x=>String(x).padStart(2,'0');
  const stamp=''+date.getFullYear()+pad(date.getMonth()+1)+pad(date.getDate())+'-'+pad(date.getHours())+pad(date.getMinutes())+pad(date.getSeconds())+String(date.getMilliseconds()).padStart(3,'0');
  const clean=(String(title||'').trim()||'story').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').slice(0,45);
  return clean+'_'+stamp+'.'+ext;
}
export async function writeFile(host,name,text,mime){
  const blob=new Blob([text],{type:mime+';charset=utf-8'});
  if(typeof host?.utils?.saveFile==='function'){
    try{
      const r=await host.utils.saveFile(name,blob,true);
      if(r?.success)return {kind:'share',message:'共有画面から「ファイルに保存」してください。実際の保存完了を確認してください。'};
      if(r?.cancelled||/cancel|キャンセル/i.test(String(r?.message||'')))
        return {kind:'cancelled',message:'保存をキャンセルしました。'};
      return {kind:'manual',message:'Laylaの書き出しに失敗しました。下の欄から本文をコピーして保存してください。',text};
    }catch(e){
      if(e?.name==='AbortError'||/cancel|キャンセル/i.test(String(e?.message||'')))
        return {kind:'cancelled',message:'保存をキャンセルしました。'};
      return {kind:'manual',message:'Laylaの保存APIが利用できません。下の欄からコピーしてください。',text};
    }
  }
  try{
    const file=new File([blob],name,{type:mime+';charset=utf-8'});
    if(typeof navigator!=='undefined'&&navigator.canShare?.({files:[file]})&&typeof navigator.share==='function'){
      await navigator.share({files:[file],title:name});
      return {kind:'share',message:'共有先の「ファイル」で実際に保存されたか確認してください。'};
    }
  }catch(e){
    if(e?.name==='AbortError')return {kind:'cancelled',message:'共有をキャンセルしました。'};
  }
  return {kind:'manual',message:'この環境では共有に失敗しました。下の欄からコピーして外部へ保存してください。',text};
}
