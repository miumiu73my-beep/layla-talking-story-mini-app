import test from 'node:test';
import assert from 'node:assert/strict';
import {filename,writeFile} from '../src/export.js';
test('filename uses local date including milliseconds and excludes dangerous characters',()=>{
  const d=new Date(2026,10,24,0,4,5,678);
  assert.equal(filename('   ','json',d),'story_20261124-000405678.json');
  assert.equal(filename('hello/world','txt',d),'hello_world_20261124-000405678.txt');
});
test('Layla file export success is not claimed as saved in Files',async()=>{
  const host={utils:{saveFile:async()=>({success:true})}};
  const response=await writeFile(host,'test.json','{"v":1}','application/json');
  assert.equal(response.kind,'share');
  assert.match(response.message,/確認/);
});
test('cancel does not attempt another share fallback',async()=>{
  const host={utils:{saveFile:async()=>({success:false,message:'ユーザーがキャンセル'})}};
  const response=await writeFile(host,'test.txt','text','text/plain');
  assert.equal(response.kind,'cancelled');
});
test('native export failure exposes a copyable text fallback',async()=>{
  const host={utils:{saveFile:async()=>({success:false,message:'unexpected'})}};
  const response=await writeFile(host,'test.txt','大切な本文','text/plain');
  assert.equal(response.kind,'manual');
  assert.equal(response.text,'大切な本文');
});

test('native saveFile exception exposes copyable fallback',async()=>{
  const host={utils:{saveFile:async()=>{throw Error('Native bridge is absent');}}};
  const result=await writeFile(host,'backup.json','{"safe":true}','application/json');
  assert.equal(result.kind,'manual');assert.equal(result.text,'{"safe":true}');
});

test('Layla native file save receives raw UTF-8 base64, not Blob',async()=>{
  let passed;
  const host={utils:{saveFile:async(name,base64,share)=>{
    passed={name,base64,share};return {success:true};
  }}};
  const text='海😀\n一歌と会話する';
  const result=await writeFile(host,'my-story.txt',text,'text/plain');
  assert.equal(result.kind,'share');
  assert.equal(passed.name,'my-story.txt');
  assert.equal(passed.share,true);
  assert.equal(typeof passed.base64,'string');
  assert.equal(Buffer.from(passed.base64,'base64').toString('utf8'),text);
});
test('native no-result cannot be reported as verified success',async()=>{
  const host={utils:{saveFile:async()=>undefined}};
  const result=await writeFile(host,'story.json','{}','application/json');
  assert.equal(result.kind,'unconfirmed');
  assert.match(result.message,/保存結果が返っていません/);
});
