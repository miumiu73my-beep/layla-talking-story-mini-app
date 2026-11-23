// Save via Layla's native file bridge where available.
export async function writeFile(layla,filename,text,mime){
  const blob=new Blob([text],{type:mime});
  if(layla?.utils?.saveFile){
    try{const result=await layla.utils.saveFile(filename,blob,true);
      if(result?.success)return 'Laylaの共有画面から保存先を選んでください。';}
    catch(e){/* fallback below */}
  }
  try{
    const file=new File([blob],filename,{type:mime});
    if(navigator.canShare?.({files:[file]})){await navigator.share({files:[file],title:filename});return '共有先への保存を確認してください。';}
  }catch(e){if(e?.name==='AbortError')return '共有をキャンセルしました。';}
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),12000);
  return 'ダウンロードを開始しました。実際に保存されたか確認してください。';
}
export function filename(title,ext){return (title||'story').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').slice(0,45)+'_'+new Date().toISOString().slice(0,10)+'.'+ext;}
