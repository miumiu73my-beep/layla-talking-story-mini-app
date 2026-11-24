// File export prefers Layla native save, then Web Share, then browser download.
// Never claim the file was actually saved by the OS until the user verifies it.
export function filename(title,ext,date=new Date()){
  const pad=x=>String(x).padStart(2,'0');
  const stamp=''+date.getFullYear()+pad(date.getMonth()+1)+pad(date.getDate())+'-'+pad(date.getHours())+
    pad(date.getMinutes())+pad(date.getSeconds())+String(date.getMilliseconds()).padStart(3,'0');
  const clean=(String(title||'').trim()||'story').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').slice(0,45);
  return clean+'_'+stamp+'.'+ext;
}
export function browserDownload(name,blob){
  if(typeof document==='undefined'||typeof URL==='undefined'||typeof URL.createObjectURL!=='function')
    return false;
  const url=URL.createObjectURL(blob);
  try{
    const a=document.createElement('a');
    a.href=url;a.download=name;a.style.display='none';
    document.body.append(a);a.click();a.remove();
    return true;
  }finally{
    // Release after the browser has had time to process the download click.
    setTimeout(()=>URL.revokeObjectURL(url),30000);
  }
}
// Layla SDK's native saveFile expects *raw base64*, not a Blob or data URL.
// Encode in blocks divisible by three to avoid corrupting base64 padding.
export function utf8ToBase64(text){
  const bytes=new TextEncoder().encode(text),block=24576,out=[];
  for(let i=0;i<bytes.length;i+=block){
    const part=bytes.subarray(i,Math.min(i+block,bytes.length));
    const chars=new Array(part.length);
    for(let j=0;j<part.length;j++)chars[j]=String.fromCharCode(part[j]);
    out.push(btoa(chars.join('')));
  }
  return out.join('');
}
export async function writeFile(host,name,text,mime){
  const blob=new Blob([text],{type:mime+';charset=utf-8'});
  let reason='';
  if(typeof host?.utils?.saveFile==='function'){
    try{
      const r=await host.utils.saveFile(name,utf8ToBase64(text),true);
      if(r?.success===true||r===true)
        return {kind:'share',message:'Layla側で保存・共有を開始しました。「ファイル」に保存されたことを確認してください。'};
      if(r?.cancelled||/cancel|キャンセル/i.test(String(r?.message||'')))
        return {kind:'cancelled',message:'保存をキャンセルしました。'};
      if(r===undefined||r===null)
        return {kind:'unconfirmed',message:'Laylaから保存結果が返っていません。実際にファイルがあるか確認し、必要なら「共有できない場合：手動で救出」を押してください。'};
      reason=String(r?.message||'Layla保存APIが成功を返しませんでした。');
    }catch(err){
      if(err?.name==='AbortError'||/cancel|キャンセル/i.test(String(err?.message||'')))
        return {kind:'cancelled',message:'保存をキャンセルしました。'};
      reason=String(err?.message||err);
    }
  }
  try{
    const file=new File([blob],name,{type:mime+';charset=utf-8'});
    if(typeof navigator!=='undefined'&&navigator.canShare?.({files:[file]})&&typeof navigator.share==='function'){
      await navigator.share({files:[file],title:name});
      return {kind:'share',message:'共有操作を開始しました。実際のファイル保存を確認してください。'};
    }
  }catch(err){
    if(err?.name==='AbortError')return {kind:'cancelled',message:'共有をキャンセルしました。'};
    reason=reason||String(err?.message||err);
  }
  // A second, manual browser-only option can be offered in the UI, since
  // a native WKWebView <a download> may silently do nothing.
  return {kind:'manual',
    message:'自動書き出しできませんでした'+(reason?'（'+reason+'）':'')+'。内容をコピーするか、ブラウザ用ダウンロードを選んでください。',
    text,name,mime};
}
