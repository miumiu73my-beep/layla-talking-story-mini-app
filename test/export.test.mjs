import test from 'node:test';
import assert from 'node:assert/strict';
import {filename,writeFile,utf8ToBase64,utf8ByteLength,manualExportPayload,manualPageOffsets,manualPageName,MANUAL_EXPORT_LIMIT,serializeBackup} from '../src/export.js';
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

test('UTF-8 Base64 conversion survives chunk boundaries and supplementary characters',()=>{
  const text='🌸一歌海'.repeat(8000)+'終';
  assert.equal(Buffer.from(utf8ToBase64(text),'base64').toString('utf8'),text);
});

test('native undefined or null exposes exact manual recovery payload without claiming success',async()=>{
  for(const value of [undefined,null]){
    const host={utils:{saveFile:async()=>value}};
    const result=await writeFile(host,'story.md','原稿😀','text/markdown');
    assert.equal(result.kind,'unconfirmed');
    assert.equal(result.text,'原稿😀');
    assert.equal(result.name,'story.md');
    assert.equal(result.mime,'text/markdown');
  }
});
test('explicit cancellation wins over a contradictory success flag',async()=>{
  const result=await writeFile({utils:{saveFile:async()=>({success:true,cancelled:true})}},'story.txt','本文','text/plain');
  assert.equal(result.kind,'cancelled');
});

test('long titles retain the compact backup suffix',()=>{
  const d=new Date(2026,10,24,0,4,5,678);
  assert.match(filename('物語'.repeat(60),'json',d,'_軽量分岐'),/_軽量分岐_20261124-000405678\.json$/);
});

test('UTF-8 byte length and base64 match platform encoding including lone surrogates',()=>{
  const text='あ😀\n'.repeat(10000)+'\ud800';
  assert.equal(utf8ByteLength(text),Buffer.byteLength(text,'utf8'));
  assert.equal(utf8ToBase64(text),Buffer.from(text,'utf8').toString('base64'));
});
test('large export skips native bridge and exposes full paged rescue; successful and cancelled release data',async()=>{
  const large='海'.repeat(MANUAL_EXPORT_LIMIT+1);
  let called=0;
  const r=await writeFile({utils:{saveFile:async()=>{called++;return undefined;}}},'large.txt',large,'text/plain');
  assert.equal(r.kind,'manual');assert.equal(called,0);assert.equal(r.text,undefined);
  assert.equal(manualExportPayload(large,r),large);
  assert.equal(manualExportPayload('small',{kind:'share'}),null);
  assert.equal(manualExportPayload('small',{kind:'cancelled'}),null);
  assert.equal(manualExportPayload('small',{kind:'manual'}),'small');
});
test('bounded backup serializer loads each branch once and uses readable v1/v2 formats',async()=>{
  const root={schema:'layla-talking-story-backup',version:1,body:'共通😀本文',branches:[{id:'a',body:'共通😀別'},{id:'b',body:'共通😀別追加'}]};
  for(const compact of [false,true]){
    let reads=0;
    const raw=await serializeBackup(root,async b=>{reads++;return b;},{compact});
    assert.equal(reads,2);const data=JSON.parse(raw);
    if(!compact)assert.deepEqual(data,root);
    else{
      const bodies=[];
      for(const entry of data.entries)bodies.push(entry.base===null?entry.suffix:bodies[entry.base].slice(0,entry.prefix)+entry.suffix);
      assert.equal(bodies[data.payload.body],root.body);
      assert.deepEqual(data.payload.branches.map(x=>bodies[x.body]),root.branches.map(x=>x.body));
    }
    assert.equal(await serializeBackup(root,async b=>b,{compact,maxBytes:5}),null);
  }
});

test('million-character manual rescue is complete and pages never split emoji pairs',()=>{
  const large='海'.repeat(199999)+'😀'+'物語😀\n'.repeat(200000);
  for(const kind of ['manual','unconfirmed']){
    const payload=manualExportPayload(large,{kind});
    const offsets=manualPageOffsets(payload),parts=offsets.slice(0,-1).map((start,i)=>payload.slice(start,offsets[i+1]));
    assert.equal(parts.join(''),large);
    assert.equal(parts[0].length,199999);
    assert.ok(parts.every(p=>p.length<=200000&&!/[\uD800-\uDBFF]$/.test(p)));
    assert.equal(manualPageName('story.json',0,parts.length),'story.json.part-1-of-'+parts.length+'.txt');
  }
});
