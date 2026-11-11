import test from 'node:test';
import assert from 'node:assert/strict';
import { scenario } from '../dist/scenario.js';
import { initialState, restoreState, submitAnswer } from '../dist/engine.js';
import { restorePlayView, pendingConversation } from '../dist/save-view.js';

test('旧Q4・Q4.1で中断した場合、新Q4を未回答で開き、他の進行と旧Q4.2の下書きだけを引き継ぐ', () => {
  for (const selected of ['Q4', 'Q4.1']) {
    const old = { ...initialState(scenario), scenarioRevision: 2, selected,
      solved: ['Q3', 'Q4', 'Q4.1'], hints: { Q4: 1, 'Q4.1': 1, 'Q4.2': 0 } };
    const state = restoreState(scenario, JSON.stringify(old));
    assert.equal(state.selected, 'Q4');
    assert.deepEqual(state.solved, ['Q3']);
    assert.deepEqual(state.hints, { Q4: 0 });
    const view = restorePlayView(scenario, state, { isPlaying: true, composerExpanded: false,
      answerDrafts: { Q4: ['隠し部屋', '脚立'], 'Q4.1': ['サダヲ'], 'Q4.2': ['マヤ', '00'] } }, 2, old);
    assert.equal(view.composerExpanded, false);
    assert.equal(view.isPlaying, false);
    assert.deepEqual(view.answerDrafts, { Q4: ['マヤ', '00'] });
  }
});

test('旧Q4.2の会話途中は、新Q4でも同じ台詞の続きから再開する', () => {
  const dialogue = scenario.problems.find(p => p.id === 'Q4').dialogue
    .map(line => ({ ...line, problemId: 'Q4.2', kind: 'dialogue' }));
  const old = { ...initialState(scenario), scenarioRevision: 2, selected: 'Q4.2',
    solved: ['Q4', 'Q4.1', 'Q4.2'], messages: [
      { speaker: 'タツ', text: '旧Q4', kind: 'dialogue', problemId: 'Q4' },
      { speaker: 'タツ', text: '旧Q4.1', kind: 'dialogue', problemId: 'Q4.1' },
      ...dialogue,
    ] };
  const state = restoreState(scenario, JSON.stringify(old));
  const view = restorePlayView(scenario, state, { isPlaying: true, sceneStart: 2,
    displayedMessages: dialogue.slice(0, 1) }, 2, old);
  assert.deepEqual(state.solved, ['Q4']);
  assert.equal(state.selected, 'Q4');
  assert.equal(view.displayedMessages[0].problemId, 'Q4');
  assert.deepEqual(pendingConversation(state, view).map(m => m.text), [dialogue[1].text]);
  assert.deepEqual(restoreState(scenario, JSON.stringify(state)), state);
});

test('旧N4.2の回答待ちはN4.1の正解後会話へ移り、旧N4.1未解答は入力を維持する', () => {
  const old = { ...initialState(scenario), scenarioRevision: 1, selected: 'N4.2', solved: ['N4', 'N4.1'], messages: [] };
  const state = restoreState(scenario, JSON.stringify(old));
  const view = restorePlayView(scenario, state, { composerExpanded: true, sceneStart: 0, displayedMessages: [],
    puzzleImageIndex: 2, answerDrafts: { 'N4.2': ['2'] } }, 1);
  assert.equal(view.isPlaying, true);
  assert.equal(view.composerExpanded, false);
  assert.equal(view.puzzleImageIndex, 2);
  assert.deepEqual(view.answerDrafts, {});
  assert.equal(pendingConversation(state, view).length, 8);
  const waiting = restoreState(scenario, JSON.stringify({ ...old, selected: 'N4.1', solved: ['N4'] }));
  const waitingView = restorePlayView(scenario, waiting, { composerExpanded: true,
    answerDrafts: { 'N4.1': ['人間・環境学研究科棟'] } }, 1);
  assert.equal(waitingView.isPlaying, false);
  assert.equal(waitingView.composerExpanded, true);
  assert.deepEqual(waitingView.answerDrafts['N4.1'], ['人間・環境学研究科棟']);
});

test('旧N4.2の会話途中と完了後をN4.1へ復元し、再生位置を保持する', () => {
  const dialogue = scenario.problems.find(p => p.id === 'N4.1').dialogue
    .map(line => ({ ...line, kind: 'dialogue', problemId: 'N4.2' }));
  const old = { ...initialState(scenario), scenarioRevision: 1, selected: 'N4.2', solved: ['N4', 'N4.1', 'N4.2'], messages: dialogue };
  const state = restoreState(scenario, JSON.stringify(old));
  for (const shown of [2, 8]) {
    const view = restorePlayView(scenario, state, { sceneStart: 0, displayedMessages: dialogue.slice(0, shown), isPlaying: shown < 8 }, 1);
    assert.equal(view.displayedMessages.length, shown);
    assert.ok(view.displayedMessages.every(m => m.problemId === 'N4.1'));
    assert.equal(view.isPlaying, shown < 8);
    assert.equal(pendingConversation(state, view).length, 8 - shown);
    const again = restorePlayView(scenario, state, view, 2);
    assert.equal(pendingConversation(state, again).length, 8 - shown);
  }
});

test('新規と旧保存は現在の進行に合った画面を復元する', () => {
  const fresh = initialState(scenario);
  assert.equal(restorePlayView(scenario, fresh, null).startView, true);
  const solved = submitAnswer(scenario, fresh, ['10']).state;
  const view = restorePlayView(scenario, solved, null);
  assert.equal(view.startView, false);
  assert.equal(view.composerExpanded, false);
  assert.ok(view.displayedMessages.length > 0);
});
test('会話途中では表示済みの会話の次から再生する', () => {
  const state = submitAnswer(scenario, initialState(scenario), ['10']).state;
  const scene = state.messages.filter(m => m.problemId === 'N1' && m.kind === 'dialogue');
  const view = restorePlayView(scenario, state, { sceneStart: 0, isPlaying: true, displayedMessages: scene.slice(0, 3) });
  assert.deepEqual(pendingConversation(state, view), scene.slice(3));
});
test('保存された不正な表示位置や廃止された問題を採用しない', () => {
  const state = initialState(scenario);
  const view = restorePlayView(scenario, state, { sceneStart: -1, chatScrollTop: Infinity, puzzleImageIndex: 999, investigationView: true, yoiEndView: true, repeatAnswer: true, displayedMessages: [{ text: 'bad', speaker: '', kind: 'dialogue', problemId: 'missing' }] });
  assert.equal(view.sceneStart, 0);
  assert.equal(view.chatScrollTop, 0);
  assert.equal(view.puzzleImageIndex, 0);
  assert.equal(view.investigationView, false);
  assert.equal(view.yoiEndView, false);
  assert.equal(view.repeatAnswer, false);
  assert.deepEqual(view.displayedMessages, []);
});
test('宵終了画面とQ8専用回答画面の復元条件を保持する', () => {
  const state = { ...initialState(scenario), selected: 'N5.5', solved: ['N5.5'] };
  assert.equal(restorePlayView(scenario, state, null).yoiEndView, false);
  assert.equal(restorePlayView(scenario, state, { yoiEndView: false, isPlaying: false }).yoiEndView, false);
  assert.equal(restorePlayView(scenario, state, { yoiEndView: true }).yoiEndView, true);
  const q8 = { ...state, selected: 'Q8', solved: ['Q7'] };
  assert.equal(restorePlayView(scenario, q8, { composerExpanded: true }).composerExpanded, true);
  assert.equal(restorePlayView(scenario, q8, { yoiEndView: true }).yoiEndView, false);
});

test('Q1の古い保存を再開してもN5.5の会話を背景に戻さず、冥の会話自体は保持する', () => {
  const saved = submitAnswer(scenario, { ...initialState(scenario), selected: 'N5.5' }, ['謎解き', '1人']).state;
  const oldMessages = saved.messages.filter(m => m.kind === 'dialogue' && m.problemId === 'N5.5');
  const q1 = { ...saved, selected: 'Q1' };
  const raw = { composerExpanded: true, displayedMessages: oldMessages, chatScrollTop: 120 };
  assert.deepEqual(restorePlayView(scenario, q1, raw).displayedMessages, []);
  assert.equal(restorePlayView(scenario, q1, raw).composerExpanded, true);
  const q11 = { ...q1, selected: 'Q1.1' };
  assert.deepEqual(restorePlayView(scenario, q11, raw).displayedMessages, []);
  const own = { ...scenario.problems.find(p => p.id === 'Q1.1').dialogue[0], kind: 'dialogue', problemId: 'Q1.1' };
  assert.deepEqual(restorePlayView(scenario, q11, { ...raw, displayedMessages: [own] }).displayedMessages, [own]);
});

test('旧N6の会話途中の表示位置をN5.5として復元し、残りから再生する', () => {
  const rawState = { ...initialState(scenario), scenarioRevision: undefined, selected: 'N6', solved: ['N6'],
    messages: ['前半', '後半'].map(text => ({ problemId: 'N6', speaker: 'タツ', kind: 'dialogue', text })) };
  const state = restoreState(scenario, JSON.stringify(rawState));
  const view = restorePlayView(scenario, state, { sceneStart: 0, isPlaying: true, displayedMessages: rawState.messages.slice(0, 1) }, 0);
  assert.equal(view.displayedMessages[0].problemId, 'N5.5');
  assert.deepEqual(pendingConversation(state, view).map(m => m.text), ['後半']);
});

test('文字・プルダウン・複数選択・途中の空欄を問題ごとに保存復元する', () => {
  const state = { ...initialState(scenario), selected: 'Q7' };
  const raw = { answerDrafts: {
    Q7: ['ｄ', '００３'], Q8: ['ハナ', '', '畏怖', ''], N2: ['法経済学部北館'],
    'Q3.2': ['2', '3'], N4: ['8', '', '↙'], N1: ['5'],
  } };
  const view = restorePlayView(scenario, state, raw);
  assert.deepEqual(view.answerDrafts, { ...raw.answerDrafts, Q7: ['D', '００３'] });
  assert.equal(view.repeatAnswer, false);
  assert.deepEqual(state.solved, [], '下書きは正解記録にしない');
  const n4 = restorePlayView(scenario, { ...state, selected: 'N4' }, raw);
  assert.deepEqual(n4.selectedSymbols, ['8', '', '↙']);
  const n1 = restorePlayView(scenario, { ...state, selected: 'N1' }, raw);
  assert.equal(n1.selectedPuzzleAnswer, '5');
});
test('下書きの廃止問題・不正な選択肢・重複・長すぎる値を復元しない', () => {
  const view = restorePlayView(scenario, initialState(scenario), { answerDrafts: {
    missing: ['answer'], N2: ['存在しない場所'], N4: ['8', 'bad', '↙'],
    'Q3.2': ['2', '2', 'not-an-option'], Q7: ['D'.repeat(300), '003'],
    Q8: { 0: 'ハナ' },
  } });
  assert.equal('missing' in view.answerDrafts, false);
  assert.equal('N2' in view.answerDrafts, false);
  assert.equal('Q8' in view.answerDrafts, false);
  assert.deepEqual(view.answerDrafts.N4, ['8', '', '↙']);
  assert.deepEqual(view.answerDrafts['Q3.2'], ['2']);
  assert.equal(view.answerDrafts.Q7[0], '');
});
