// Single boundary for Layla-specific SDK calls. Can be swapped for a future LLM host.
import {LaylaSDK} from '@layla-network/sdk';
export function makeRuntime({sdk}={}){
  if(sdk===undefined){try{sdk=new LaylaSDK();}catch{sdk=null;}}
  return {
    sdk,
    db:sdk?.db??null,
    utils:sdk?.utils??null,
    available:()=>Boolean(sdk?.chat?.completions?.stream),
    generate({messages,params,onText,onError}){
      if(typeof sdk?.chat?.completions?.stream!=='function')throw Error('LaylaのLLMブリッジを利用できません。');
      const raw=sdk.chat.completions.stream({messages,...params});
      let acc='',finishReason=null;
      const capture=value=>{
        const reason=value?.finish_reason??value?.finishReason??value?.choices?.[0]?.finish_reason??value?.choices?.[0]?.finishReason;
        if(typeof reason==='string'&&reason)finishReason=reason;
      };
      // Optional events vary by SDK; never invent a reason.
      try{raw.on('chunk',capture);}catch{}
      try{raw.on('chatCompletion',capture);}catch{}
      raw.on('content',(delta,snapshot)=>{
        acc=typeof snapshot==='string'?snapshot:acc+String(delta||'');
        onText(acc);
      });
      if(typeof onError==='function'){
        try{raw.on('error',onError);}catch{/* Some versions surface errors only via finalContent. */}
      }
      return {final:async()=>{
        const value=await raw.finalContent();capture(value);
        const text=typeof value==='string'?value:value?.content??value?.choices?.[0]?.message?.content??acc;
        return {text:typeof text==='string'?text:acc,finishReason};
      },abort:()=>raw.abort(),text:()=>acc};
    }
  };
}
