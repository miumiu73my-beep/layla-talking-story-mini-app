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
test('reply regeneration creates a fork before the selected turn',()=>{
  const s=story(),r=regenerateAt(s,2);
  assert.equal(r.turns.length,2);
  assert.equal(r.draft,'ドアを開く');
  assert.ok(!r.body.includes('ドアの向こうから声がした。'));
  assert.equal(r.branches[0].turns.length,3);
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
  const s=rewindAfter(story(),0);s.branches[0].id=s.activeBranch.id;
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
