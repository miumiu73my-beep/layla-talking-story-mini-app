// File export prefers Layla native save, then Web Share, then browser download.
// Never claim the file was actually saved by the OS until the user verifies it.
export function filename(title,ext,date=new Date(),suffix=''){
  const pad=x=>String(x).padStart(2,'0');
  const stamp=''+date.getFullYear()+pad(date.getMonth()+1)+pad(date.getDate())+'-'+pad(date.getHours())+
    pad(date.getMinutes())+pad(date.getSeconds())+String(date.getMilliseconds()).padStart(3,'0');
  const sanitize=value=>String(value).replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_');
  const ending=sanitize(suffix).slice(0,20);
  let clean=sanitize(String(title||'').trim()||'story').slice(0,45-ending.length);
  if(/[\uD800-\uDBFF]$/.test(clean))clean=clean.slice(0,-1);
  return clean+ending+'_'+stamp+'.'+ext;
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
  const encoder=new TextEncoder(),block=8192,out=[];
  let carry=new Uint8Array(0);
  for(let i=0;i<text.length;){
    let end=Math.min(i+block,text.length);
    if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]))end--;
    const encoded=encoder.encode(text.slice(i,end));i=end;
    const bytes=new Uint8Array(carry.length+encoded.length);bytes.set(carry);bytes.set(encoded,carry.length);
    const n=bytes.length-bytes.length%3;
    const part=bytes.subarray(0,n);carry=bytes.slice(n);
    const chars=new Array(part.length);
    for(let j=0;j<part.length;j++)chars[j]=String.fromCharCode(part[j]);
    out.push(btoa(chars.join('')));
  }
  if(carry.length)out.push(btoa(String.fromCharCode(...carry)));
  return out.join('');
}
// Count UTF-8 without allocating a second full-size byte buffer.
export function utf8ByteLength(text){
  let n=0;
  for(let i=0;i<text.length;i++){
    const c=text.charCodeAt(i);
    if(c<128)n++;else if(c<2048)n+=2;
    else if(c>=0xd800&&c<=0xdbff&&text.charCodeAt(i+1)>=0xdc00&&text.charCodeAt(i+1)<=0xdfff){n+=4;i++;}
    else n+=3;
  }
  return n;
}
export const MANUAL_EXPORT_LIMIT=250000;
export function manualExportPayload(text,result){
  return (result.kind==='manual'||result.kind==='unconfirmed')&&text.length<=MANUAL_EXPORT_LIMIT?text:null;
}
export async function writeFile(host,name,text,mime){
  const fallback=()=>text.length<=MANUAL_EXPORT_LIMIT?{text,name,mime}:{name,mime};
  let reason='';
  if(typeof host?.utils?.saveFile==='function'){
    try{
      const r=await host.utils.saveFile(name,utf8ToBase64(text),true);
      if(r?.cancelled||/cancel|キャンセル/i.test(String(r?.message||'')))
        return {kind:'cancelled',message:'保存をキャンセルしました。'};
      if(r?.success===true||r===true)
        return {kind:'share',message:'Layla側で保存・共有を開始しました。「ファイル」に保存されたことを確認してください。'};
      if(r===undefined||r===null)
        // The first share sheet may already have opened. Offer manual rescue instead of opening a second one.
        return {kind:'unconfirmed',message:'Laylaから保存結果が返っていません。実際にファイルがあるか確認してください。保存されていなければ手動で救出できます。',...fallback()};
      reason=String(r?.message||'Layla保存APIが成功を返しませんでした。');
    }catch(err){
      if(err?.name==='AbortError'||/cancel|キャンセル/i.test(String(err?.message||'')))
        return {kind:'cancelled',message:'保存をキャンセルしました。'};
      reason=String(err?.message||err);
    }
  }
  try{
    if(typeof navigator!=='undefined'&&typeof navigator.canShare==='function'&&typeof navigator.share==='function'){
      const file=new File([text],name,{type:mime+';charset=utf-8'});
      if(navigator.canShare({files:[file]})){
      await navigator.share({files:[file],title:name});
      return {kind:'share',message:'共有操作を開始しました。実際のファイル保存を確認してください。'};
      }
    }
  }catch(err){
    if(err?.name==='AbortError')return {kind:'cancelled',message:'共有をキャンセルしました。'};
    reason=reason||String(err?.message||err);
  }
  // A second, manual browser-only option can be offered in the UI, since
  // a native WKWebView <a download> may silently do nothing.
  return {kind:'manual',
    message:'自動書き出しできませんでした'+(reason?'（'+reason+'）':'')+'。内容をコピーするか、ブラウザ用ダウンロードを選んでください。',
    ...fallback()};
}

// Bounded serializer for v1 and existing v2 branch-prefix backups. Keep only
// the active body and preceding archive body, rather than materializing every
// archive. Each prefix refers to an earlier entry (v2 reader supports this).
export async function serializeBackup(snapshot,loadBranch,{compact=false,maxBytes=50000000}={}){
  const {branches,...root}=snapshot;
  const pieces=[],entries=[],payload=[];
  let bytes=0;
  function add(list,value){
    const part=JSON.stringify(value);
    bytes+=utf8ByteLength(part)+(list.length?1:0);
    if(bytes>maxBytes)return false;
    list.push(part);return true;
  }
  const prefix=(a,b)=>{
    let i=0;while(i<a.length&&i<b.length&&a.charCodeAt(i)===b.charCodeAt(i))i++;
    return i;
  };
  const head=JSON.stringify(compact?{...root,body:0}:root).slice(0,-1)+',"branches":[';
  bytes=utf8ByteLength(head)+2;
  if(compact){
    bytes+=utf8ByteLength('{"schema":"layla-talking-story-backup","version":2,"kind":"branch-prefix","entries":[],"payload":}');
    if(!add(entries,{base:null,prefix:0,suffix:root.body}))return null;
  }
  if(bytes>maxBytes)return null;
  let previous=root.body;
  for(let i=0;i<branches.length;i++){
    const branch=await loadBranch(branches[i]);
    if(compact){
      const a=prefix(root.body,branch.body),b=prefix(previous,branch.body);
      const count=Math.max(a,b),base=count?(b>a?i:0):null;
      if(!add(entries,{base,prefix:count,suffix:branch.body.slice(count)})||
         !add(payload,{...branch,body:i+1}))return null;
      previous=branch.body;
    }else if(!add(payload,branch))return null;
  }
  pieces.push(head,payload.join(','),']}');
  const body=pieces.join('');
  const result=compact?'{"schema":"layla-talking-story-backup","version":2,"kind":"branch-prefix","entries":['+entries.join(',')+'],"payload":'+body+'}':body;
  return utf8ByteLength(result)<=maxBytes?result:null;
}
