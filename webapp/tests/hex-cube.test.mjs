import test from 'node:test';
import assert from 'node:assert/strict';
import { scenario } from '../dist/scenario.js';
import { initialState, restoreState, completeMinigame, unlockedCards } from '../dist/engine.js';
import { initialPuzzle, applyPuzzleMove, squareFor, verifyPuzzleSolution, readMinigameEntry } from '../dist/hex-cube-model.js';
import { createLocalD1 } from '../scripts/local-d1.mjs';
import { handlePlaySave } from '../server/play-saves.js';

const solution=[[4],[3,4]];
test('3Dの正方形は6通りあり、選んだ2つを保って残り4エリアを反転する',()=>{
  for(let mask=0;mask<63;mask++)for(let a=0;a<6;a++)for(let b=0;b<6;b++){
    const state={colors:Array.from({length:6},(_,i)=>Boolean(mask&(1<<i))),mode:3};
    const valid=(a+1)%6===b||(b+1)%6===a;
    assert.equal(Boolean(squareFor(a,b)),valid);
    if(!valid){assert.throws(()=>applyPuzzleMove(state,[a,b]));continue;}
    const next=applyPuzzleMove(state,[a,b]);assert.equal(next.mode,2);
    next.colors.forEach((color,i)=>assert.equal(color,i===a||i===b?state.colors[i]:!state.colors[i]));
  }
  for(let i=0;i<6;i++){
    const initial=initialPuzzle(),next=applyPuzzleMove(initial,[i]);assert.equal(next.mode,3);
    next.colors.forEach((color,j)=>assert.equal(color,[(i+5)%6,(i+1)%6].includes(j)?!initial.colors[j]:initial.colors[j]));
  }
});
test('実際の初期状態からクリアした操作だけを受け付ける',()=>{
  assert.equal(verifyPuzzleSolution(solution),true);
  for(const bad of [null,[],[[0]],[[0],[5,2]],[[0,1]],[[6]],[[1.5]],[...solution,[0]]])assert.equal(verifyPuzzleSolution(bad),false);
});
test('3手で全面を塗っても失敗になり、報酬を付与しない',()=>{
  const moves=[[0],[0,1],[5]];
  const board=moves.reduce(applyPuzzleMove,initialPuzzle());
  assert.equal(board.colors.every(Boolean),true);
  assert.equal(verifyPuzzleSolution(moves),false);
  const start=initialState(scenario);
  const result=completeMinigame(scenario,start,'hex-cube',moves);
  assert.equal(result.status,'incorrect');
  assert.equal(result.state,start);
});
test('クリア後は会話を追加せずシステムメッセージと仮カードを一度だけ取得する',()=>{
  const start=initialState(scenario),result=completeMinigame(scenario,start,'hex-cube',solution);
  assert.equal(result.status,'correct');assert.equal(result.state.selected,start.selected);assert.deepEqual(result.state.solved,start.solved);
  const added=result.state.messages.slice(start.messages.length);assert.equal(added.length,1);assert.equal(added[0].speaker,'システム');assert.equal(added[0].kind,'success');
  assert.equal(unlockedCards(scenario,result.state).filter(card=>card.id==='hex-cube-note').length,1);
  const again=completeMinigame(scenario,result.state,'hex-cube',solution);assert.equal(again.status,'already-solved');assert.equal(again.state,result.state);
  assert.equal(completeMinigame(scenario,start,'hex-cube',[[0]]).status,'incorrect');assert.equal(completeMinigame(scenario,start,'unknown',solution).status,'unavailable');
});
test('保存を再開してもクリアと取得カードを保持し、旧記録はそのまま読み込める',()=>{
  const start=initialState(scenario),cleared=completeMinigame(scenario,start,'hex-cube',solution).state;
  const restored=restoreState(scenario,JSON.stringify(cleared));assert.deepEqual(restored.minigames,['hex-cube']);assert.equal(unlockedCards(scenario,restored).filter(card=>card.id==='hex-cube-note').length,1);
  const legacy={...start};delete legacy.minigames;assert.deepEqual(restoreState(scenario,JSON.stringify(legacy)).minigames,[]);
  assert.deepEqual(restoreState(scenario,JSON.stringify({...start,minigames:['unknown','hex-cube','hex-cube']})).minigames,['hex-cube']);
});
test('控え室と本編で開いたヒントは別々に復元される', () => {
  const saved = initialState(scenario);
  saved.hints = { 'Q2.2': 2, 'hex-cube': 3 };
  assert.deepEqual(restoreState(scenario, JSON.stringify(saved)).hints, saved.hints);
  saved.hints['hex-cube'] = 99;
  assert.equal(restoreState(scenario, JSON.stringify(saved)).hints['hex-cube'], 5);
});
test('QR用の入口は11月の救祭の日本語URLと旧リダイレクトURLを認識する',()=>{
  assert.equal(readMinigameEntry('https://example.test/11月の救祭/app/?minigame=hex-cube'),'hex-cube');
  assert.equal(readMinigameEntry('https://example.test/app/?minigame=hex-cube'),'hex-cube');
  for(const value of ['',undefined,'https://example.test/takehome/app/?minigame=hex-cube','https://example.test/11月の救祭/app/?minigame=unknown'])assert.equal(readMinigameEntry(value),null);
});
test('11月の救祭の既存保存APIでカード取得を保存し6桁番号から復元できる',async t=>{
  const db=createLocalD1(':memory:');t.after(()=>db.close());
  const env={PLAY_SAVES:db,PLAY_SAVE_SECRET:'hex-nf-test-only-not-a-production-secret'},view={startView:false,displayedMessages:[],isPlaying:false};
  const request=async body=>{
    const response=await handlePlaySave(new Request('https://example.test/api/play-saves',{method:'POST',headers:{Origin:'https://example.test','Content-Type':'application/json','CF-Connecting-IP':'127.0.0.1'},body:JSON.stringify({scenarioId:scenario.id,...body})}),env);
    const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));return result;
  };
  const start=initialState(scenario);
  const created=await request({action:'create',creationId:crypto.randomUUID(),state:start,view});
  const cleared=completeMinigame(scenario,start,'hex-cube',solution).state;
  const saved=await request({action:'save',code:created.code,revision:created.revision,state:cleared,view});
  const loaded=await request({action:'load',code:created.code});assert.equal(loaded.revision,saved.revision);
  const state=restoreState(scenario,JSON.stringify(loaded.state));assert.deepEqual(state.minigames,['hex-cube']);assert.equal(unlockedCards(scenario,state).filter(card=>card.id==='hex-cube-note').length,1);
});
