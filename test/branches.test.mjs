import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanState,freshState,acceptTurn,parseImport,bodyFingerprint} from '../src/logic.js';
import {timeline,timelineAt,forkAt,rewindAfter,rewindBefore,editUserAt,
  editReplyAt,regenerateAt,switchBranch,renameBranch,deleteInactiveBranch,MAX_ARCHIVED_BRANCHES} from '../src/branches.js';

function story(){
  let s=freshState();
  s.characters='主人公は海';s.memory='第1章の約束';s.world='異能学園';
  s=acceptTurn(s,{user:'おはよう',text:'一歌が笑った。',sourceDraft:''});
  s=acceptTurn(s,{user:'教室へ行こう',text:'ふたりは教室へ向かった。',sourceDraft:''});
  s=acceptTurn(s,{user:'ドアを開く',text:'ドアの向こうから声がした。',sourceDraft:''});
  return s;
}
test('all turn offsets are verifiable and their bodies are individually addressable',()=>{
  const s=story(),t=timeline(s);
  assert.equal(t.length,3);
  assert.equal(t[1].reply,'ふたりは教室へ向かった。');
  assert.equal(t[0].start,0);
  assert.equal(s.turns[2].replyHash,bodyFingerprint(t[2].reply));
});
test('arbitrary rewind leaves the original plot intact in an archived branch',()=>{
  const original=story();
  const rewound=rewindAfter(original,0);
  assert.equal(rewound.turns.length,1);
  assert.equal(rewound.body,'一歌が笑った。');
  assert.equal(rewound.branches.length,1);
  assert.equal(rewound.branches[0].body,original.body);
  assert.equal(rewound.branches[0].turns.length,3);
  assert.equal(rewound.activeBranch.parentId,'main');
  assert.equal(original.turns.length,3); // pure, no mutation
  const restored=switchBranch(rewound,'main');
  assert.equal(restored.body,original.body);
  assert.equal(restored.turns.length,3);
  assert.equal(restored.branches.length,1);
  const forked=switchBranch(restored,rewound.activeBranch.id);
  assert.equal(forked.body,rewound.body);
});
test('prior user messages can be edited and regenerated from that turn',()=>{
  const s=story();
  const edited=editUserAt(s,1,'今日は図書室へ行こう');
  assert.equal(edited.draft,'今日は図書室へ行こう');
  assert.equal(edited.turns.length,1);
  assert.equal(edited.branches[0].turns[1].user,'教室へ行こう');
  const continued=acceptTurn(edited,{user:edited.draft,text:'ふたりは図書室へ向かった。',sourceDraft:edited.draft});
  assert.ok(continued.body.includes('図書室へ向かった'));
  assert.ok(!continued.body.includes('ふたりは教室へ向かった'));
  assert.equal(continued.turns[1].user,'今日は図書室へ行こう');
  const restored=switchBranch(continued,'main');
  assert.ok(restored.body.includes('ふたりは教室へ向かった'));
});
test('past assistant replies can be manually edited while preserving old future',()=>{
  const s=story();
  const edited=editReplyAt(s,1,'一歌が図書室へ案内した。');
  assert.equal(edited.turns.length,2);
  assert.equal(edited.turns[1].user,'教室へ行こう');
  assert.equal(timelineAt(edited,1).reply,'一歌が図書室へ案内した。');
  assert.ok(!edited.body.includes('ドアの向こうから声がした。'));
  assert.ok(edited.branches[0].body.includes('ドアの向こうから声がした。'));
});
test('latest regeneration uses reply trash; earlier regeneration still forks',()=>{
  const s=story(),r=regenerateAt(s,2);
  assert.equal(r.turns.length,2);
  assert.equal(r.draft,'ドアを開く');
  assert.ok(!r.body.includes('ドアの向こうから声がした。'));
  assert.equal(r.branches.length,0);
  assert.equal(r.replyTrash[0],'ドアの向こうから声がした。');
  const prior=regenerateAt(s,1);assert.equal(prior.branches[0].turns.length,3);
});
test('rewind before last and before first turn preserves full original body',()=>{
  const original=story();
  const last=rewindBefore(original,2);
  assert.equal(last.turns.length,2);
  const start=forkAt(original,{index:0,after:false,label:'最初から'});
  assert.equal(start.turns.length,0);assert.equal(start.body,'');
  assert.equal(start.branches[0].body,original.body);
});
test('branch names can be edited and deleted only for inactive branches',()=>{
  const original=story(),b=rewindBefore(original,2);
  const renamed=renameBranch(b,'main','元のハッピーエンド');
  assert.equal(renamed.branches[0].name,'元のハッピーエンド');
  const removed=deleteInactiveBranch(renamed,'main');
  assert.equal(removed.branches.length,0);
  assert.throws(()=>deleteInactiveBranch(removed,removed.activeBranch.id));
  assert.throws(()=>renameBranch(removed,removed.activeBranch.id,''));
});
test('full branch archive survives v1 JSON export and import, including settings',()=>{
  const original=story(),branched=rewindAfter(original,0);
  branched.memory='新しい分岐の記憶';
  const loaded=parseImport('all.json',JSON.stringify(branched),freshState()).state;
  assert.equal(loaded.branches.length,1);
  assert.equal(loaded.branches[0].memory,'第1章の約束');
  assert.equal(loaded.memory,'新しい分岐の記憶');
  const old=switchBranch(loaded,'main');
  assert.equal(old.memory,'第1章の約束');
  assert.equal(old.world,'異能学園');
  assert.equal(old.turns.length,3);
});
test('legacy single-branch v1 JSON loads with main branch initialized',()=>{
  const old=story();delete old.branches;delete old.activeBranch;
  const migrated=cleanState(old);
  assert.equal(migrated.activeBranch.id,'main');
  assert.deepEqual(migrated.branches,[]);
  const generated=rewindAfter(migrated,1);
  assert.equal(generated.branches[0].id,'main');
});
test('manual modification of a turn is detected before any branching',()=>{
  const s=story(),broken={...s,body:s.body.replace('ふたりは教室へ向かった。','ふたりは外へ向かった。')};
  assert.throws(()=>timeline(broken),/編集済み|一致しません/);
  assert.throws(()=>editUserAt(broken,1,'新しい入力'));
  assert.equal(s.body.includes('教室へ向かった'),true);
});
test('older full-reply v1 turns without explicit offsets can be branched',()=>{
  const s=freshState();s.body='古い応答1。\n\n古い応答2。';
  s.turns=[{user:'A',reply:'古い応答1。'},{user:'B',reply:'古い応答2。'}];
  assert.equal(timeline(s)[1].reply,'古い応答2。');
  const fork=editReplyAt(s,1,'新しい応答2。');
  assert.equal(fork.turns.length,2);
  assert.equal(timelineAt(fork,1).reply,'新しい応答2。');
});
test('branch IDs cannot silently collide on JSON restore',()=>{
  const s=rewindAfter(story(),0);s.branches[0]={...s.branches[0],id:s.activeBranch.id};
  assert.throws(()=>cleanState(s),/重複/);
});
test('branch count limit fails safely without discarding originals',()=>{
  let s=story();
  for(let n=0;n<MAX_ARCHIVED_BRANCHES;n++){
    s=forkAt(s,{index:0,after:false,label:'試行 '+n});
    s=acceptTurn(s,{user:'再開',text:'再開 '+n,sourceDraft:''});
  }
  assert.equal(s.branches.length,MAX_ARCHIVED_BRANCHES);
  assert.throws(()=>forkAt(s,{index:0}),/外部JSONバックアップ/);
  assert.equal(s.branches.length,MAX_ARCHIVED_BRANCHES);
});

test('old v1 backups have deterministic branch metadata for recovery comparison',()=>{
  const s=freshState();
  delete s.activeBranch;delete s.branches;delete s.updatedAt;
  const first=cleanState(s),second=cleanState(s);
  assert.deepEqual(first,second);
  assert.equal(first.activeBranch.createdAt,'legacy-v1');
});

test('direct edit inside earlier reply updates all following offsets safely',async()=>{
  const {reconcileBodyEdit}=await import('../src/branches.js');
  const s=story(),old=timeline(s);
  const replaced=s.body.replace('一歌が笑った。','一歌は嬉しそうに笑った。');
  const next=reconcileBodyEdit(s,replaced);
  const positions=timeline(next);
  assert.equal(positions.length,3);
  assert.equal(positions[0].reply,'一歌は嬉しそうに笑った。');
  assert.equal(positions[2].reply,old[2].reply);
  assert.ok(positions[2].start>old[2].start);
  assert.equal(next.branches.length,s.branches.length);
});
test('switching story forks keeps sampler preferences global',()=>{
  const s=story();
  const fork=rewindBefore(s,2);
  fork.prefs.contextTokens=32768;fork.prefs.temperature='0.5';
  const back=switchBranch(fork,'main');
  assert.equal(back.prefs.contextTokens,32768);
  assert.equal(back.prefs.temperature,'0.5');
  const inherited=switchBranch(fork,'main',{inheritLore:true});
  assert.equal(inherited.memory,fork.memory);
});


test('legacy v1 turns without offsets are corrected before rebuilding hashes',async()=>{
  const {reconcileBodyEdit}=await import('../src/branches.js');
  const s=story(),original=timeline(s);
  s.turns=s.turns.map((t,i)=>{
    const v={...t,reply:original[i].reply};
    delete v.bodyStart;delete v.bodyEnd;
    return v;
  });
  const edited=reconcileBodyEdit(s,s.body.replace('ふたりは教室へ向かった。','ふたりはゆっくり教室へ向かった。'));
  assert.equal(timeline(edited).length,3);
  assert.ok(Number.isInteger(edited.turns[0].bodyStart));
  assert.equal(timeline(edited)[1].reply,'ふたりはゆっくり教室へ向かった。');
});

test('inserting at reply start, end, and last end stays inside a turn',async()=>{
  const {reconcileBodyEdit}=await import('../src/branches.js');
  const s=story(),p=timeline(s);
  const atEnd=reconcileBodyEdit(s,s.body.slice(0,p[0].end)+'追記'+s.body.slice(p[0].end));
  assert.ok(timeline(atEnd)[0].reply.endsWith('追記'));
  const atStart=reconcileBodyEdit(s,s.body.slice(0,p[1].start)+'冒頭'+s.body.slice(p[1].start));
  assert.ok(timeline(atStart)[1].reply.startsWith('冒頭'));
  const final=reconcileBodyEdit(s,s.body+'末尾を追加');
  assert.ok(timeline(final)[2].reply.endsWith('末尾を追加'));
});

test('30 archived branches allow repeated safe undo without stale state.undo',async()=>{
  const {rewindLastWithoutFork}=await import('../src/branches.js');
  let s=story();
  s.branches=Array.from({length:30},(_,i)=>({id:'arch'+i,name:'古い展開'+i}));
  s.undo=null;
  const first=rewindLastWithoutFork(s);
  assert.equal(first.turns.length,2);
  assert.equal(first.branches.length,30);
  const second=rewindLastWithoutFork(first);
  assert.equal(second.turns.length,1);
  assert.equal(timeline(second).length,1);
  assert.equal(s.turns.length,3);
});

test('turn timeline separates user prelude from AI reply and branches safely',async()=>{
  const {reconcileBodyEdit}=await import('../src/branches.js');
  let s=freshState();s.prefs.recordInputInBody=true;
  s=acceptTurn(s,{user:'手を振る',text:'一歌が微笑んだ。',sourceDraft:'手を振る'});
  s=acceptTurn(s,{user:'近づく',text:'隣へ歩いてきた。',sourceDraft:'近づく'});
  const positions=timeline(s);
  assert.equal(positions[0].reply,'一歌が微笑んだ。');
  assert.equal(positions[1].reply,'隣へ歩いてきた。');
  const edited=reconcileBodyEdit(s,s.body.replace('一歌が微笑んだ。','一歌は嬉しそうに微笑んだ。'));
  assert.equal(timeline(edited)[0].reply,'一歌は嬉しそうに微笑んだ。');
  const rewound=rewindBefore(edited,1);
  assert.equal(rewound.turns.length,1);
  assert.ok(!rewound.body.includes('近づく'));
  assert.ok(rewound.branches[0].body.includes('近づく'));
  const rerendered=editReplyAt(edited,1,'一歌は手を取った。');
  assert.ok(rerendered.body.includes('【あなたの入力】\n近づく\n\n一歌は手を取った。'));
});

test('rewinding a corrected legacy turn retains start and end additions',async()=>{
  const {reconcileBodyEdit}=await import('../src/branches.js');
  const s=freshState();
  s.body='旧応答A。\n\n旧応答B。\n\n旧応答C。';
  s.turns=[{user:'A',reply:'旧応答A。'},{user:'B',reply:'旧応答B。'},{user:'C',reply:'旧応答C。'}];
  let pos=timeline(s)[1];
  const first=reconcileBodyEdit(s,s.body.slice(0,pos.start)+'冒頭。'+s.body.slice(pos.start));
  pos=timeline(first)[1];
  const last=reconcileBodyEdit(first,first.body.slice(0,pos.end)+'末尾。'+first.body.slice(pos.end));
  assert.equal(timeline(last)[1].reply,'冒頭。旧応答B。末尾。');
  assert.equal(rewindAfter(last,1).body,'旧応答A。\n\n冒頭。旧応答B。末尾。');
});

test('renaming an already canonical immutable archive preserves the original',()=>{
  const original=cleanState(rewindAfter(story(),0));
  const id=original.branches[0].id;
  const renamed=renameBranch(original,id,'新しい名前');
  assert.equal(renamed.branches[0].name,'新しい名前');
  assert.notEqual(original.branches[0].name,'新しい名前');
});

test('cumulative 40 percent deletions retain the original active snapshot across saves',async()=>{
  const {makeBodyRecovery}=await import('../src/branches.js');
  const r=makeBodyRecovery(),s=freshState();
  s.body='原'.repeat(10000);r.seed(s);
  assert.equal(r.plan(s,6000),null);
  s.body=s.body.slice(0,6000);
  const plan=r.plan(s,3600);
  assert.equal(plan.large,true);
  assert.equal(plan.snapshot.body.length,10000);
  assert.equal(plan.snapshot.branches.length,0);
  // An unsuccessful checkpoint does not permit or forget the deletion.
  r.failed(plan);assert.equal(r.plan(s,3600).snapshot.body.length,10000);
  s.body=s.body.slice(0,3600);r.completed(plan,s);
  assert.equal(r.plan(s,3599),null);
  assert.equal(r.plan(s,2160),null);
  const next=r.plan(s,1700);
  assert.equal(next.large,true);assert.equal(next.snapshot.body.length,3600);
  s.body='';r.completed(next,s);
  s.body='再開';assert.equal(r.plan(s,3),null);
});

test('first edit after growth and a new work use the correct recovery anchor',async()=>{
  const {makeBodyRecovery,dailyCheckpointDue}=await import('../src/branches.js');
  const r=makeBodyRecovery(),s=freshState();
  s.body='a'.repeat(1000);
  const first=r.plan(s,900);assert.equal(first.large,false);
  r.failed(first);assert.equal(r.plan(s,900).snapshot.body.length,1000);
  s.body='b'.repeat(10000);
  assert.equal(r.plan(s,6000),null);
  s.body=s.body.slice(0,6000);
  assert.equal(r.plan(s,2000).snapshot.body.length,10000);
  r.reset();s.body='別'.repeat(800);
  assert.equal(r.plan(s,300).snapshot.body,'別'.repeat(800));
  assert.equal(dailyCheckpointDue(null,1),true);
  assert.equal(dailyCheckpointDue(100,86400099),false);
  assert.equal(dailyCheckpointDue(100,86400100),true);
});

test('million-character edits preserve unchanged reply hashes and rewind includes appended text',async()=>{
  const {reconcileBodyEdit}=await import('../src/branches.js');
  let s=freshState();
  s=acceptTurn(s,{user:'A',text:'甲'.repeat(500000),sourceDraft:''});
  s=acceptTurn(s,{user:'B',text:'乙'.repeat(500000),sourceDraft:''});
  const before=timeline(s),offset=before[0].end;
  const changed=reconcileBodyEdit(s,s.body.slice(0,offset)+'追記。'+s.body.slice(offset));
  assert.equal(changed.turns[1].replyHash,s.turns[1].replyHash);
  assert.equal(timeline(changed)[0].reply.slice(-3),'追記。');
  assert.equal(rewindAfter(changed,0).body.length,500003);
  assert.throws(()=>reconcileBodyEdit(s,s.body.slice(0,offset-1)+s.body.slice(before[1].start+1)),/複数ターン|境界/);
});

test('optimized reconciliation still rejects changed user preludes',async()=>{
  const {reconcileBodyEdit}=await import('../src/branches.js');
  let s=freshState();s.prefs.recordInputInBody=true;
  s=acceptTurn(s,{user:'入力',text:'回答',sourceDraft:''});
  assert.throws(()=>reconcileBodyEdit(s,s.body.replace('入力','変更')),/併記/);
});

test('edited last reply can be undone at capacity and restored as an editable candidate',async()=>{
  const {reconcileBodyEdit,rewindLastWithoutFork}=await import('../src/branches.js');
  const {restoreReplyCandidate,compactBackup}=await import('../src/logic.js');
  const s=story();s.branches=Array.from({length:30},(_,i)=>({id:'arch'+i,name:'旧分岐'}));
  const edited=reconcileBodyEdit(s,s.body+'追記。');
  assert.equal(edited.undo,null);
  const r=rewindLastWithoutFork(edited);
  assert.equal(r.branches.length,30);assert.equal(r.activeBranch.id,s.activeBranch.id);
  assert.equal(r.replyTrash[0],'ドアの向こうから声がした。追記。');
  const restored=restoreReplyCandidate(r,0);
  assert.equal(restored.text,r.replyTrash[0]);assert.equal(restored.baseFingerprint,bodyFingerprint(r.body));
  assert.equal(r.turns.length,2);
  const portable=cleanState({...r,branches:[]});
  assert.deepEqual(parseImport('full.json',JSON.stringify(portable),freshState()).state.replyTrash,r.replyTrash);
  assert.deepEqual(parseImport('light.json',compactBackup(portable),freshState()).state.replyTrash,r.replyTrash);
});
test('reply trash is bounded; candidate text changes mark only actual stream updates',async()=>{
  const {rememberReply,restoreReplyCandidate,updateStreamText}=await import('../src/logic.js');
  let trash=[];for(let i=0;i<24;i++)trash=rememberReply(trash,'reply '+i);
  assert.equal(trash.length,20);assert.equal(trash[0],'reply 23');assert.equal(trash[19],'reply 4');
  const s=story();s.replyTrash=trash;const c=restoreReplyCandidate(s,0);
  assert.equal(updateStreamText(c,'途中'),true);assert.equal(updateStreamText(c,'途中'),false);
  assert.equal(updateStreamText(c,'途中まで'),true);s.pendingCandidate=c;
  assert.equal(cleanState(s).pendingCandidate.text,'途中まで');
  assert.throws(()=>restoreReplyCandidate(s,0));
});
