import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { scenario } from '../dist/scenario.js';
import * as engine from '../dist/engine.js';
import { createConversationPlayer, latestSceneStart, readingDelay } from '../dist/conversation.js';
import { createPlaySaveController, normalizePlayCode } from '../dist/play-save.js';
import { isConversationLine, restorePlayView, pendingConversation, sanitizeAnswerDraft } from '../dist/save-view.js';
import { createOverlayHistory } from '../dist/navigation.js';
import { bindVisualViewport } from '../dist/viewport.js';
import { MOTION, createHaptics, answerReadiness, isComposingSubmit, bindImageViewer, bindSheetDismiss } from '../dist/interaction.js';
import { animateEmphasis, toggleDisclosure, animateCombination, copyWithFeedback } from '../dist/feedback.js';

// 仮想タイマーで待ち時間を進める。実際のブラウザは起動しない。
function clock() {
  const pending = new Map();
  let id = 0;
  return {
    pending,
    schedule(callback, delay) { pending.set(++id, { callback, delay }); return id; },
    cancel(id) { pending.delete(id); },
    tick() {
      const [id, job] = pending.entries().next().value ?? [];
      assert.ok(job, '次の表示タイマーが必要');
      pending.delete(id);
      job.callback();
      return job.delay;
    },
    drain() { let limit = 100; while (pending.size && limit--) this.tick(); assert.ok(limit > 0); },
  };
}

function appHarness(saved = null, reducedMotion = false, { entryOnly = false, records = {}, fetchImpl, webMCP = false, entryAnimations = false, entryUrl = '', minigameMount = () => ({destroy(){},refresh(){}}) } = {}) {
  const storageItems = new Map(Object.entries(records));
  if (saved !== null && entryOnly) storageItems.set(`webbot:${scenario.id}`, saved);
  const storageCalls = [];
  const storage = {
    getItem(key) { storageCalls.push(['get', key]); return storageItems.get(key) ?? null; },
    setItem(key, value) { storageCalls.push(['set', key, value]); storageItems.set(key, value); },
    removeItem(key) { storageCalls.push(['remove', key]); storageItems.delete(key); },
  };
  const windowListeners = {};
  const networkCalls = [];
  const registeredTools = [];
  const timer = clock();
  const gestureTimer = clock();
  const listeners = {};
  const chatListeners = {};
  const notice = { hidden: true, textContent: '' };
  const answerField = { value: '', focusCount: 0, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; }, focus() { this.focusCount++; } };
  const answerError = { textContent: '' };
  const errorAnimations = [];
  const answerClasses = new Set();
  const answerFields = { animate(frames, options) { const animation = { frames, options, cancelled: false, cancel() { this.cancelled = true; } }; errorAnimations.push(animation); return animation; } };
  const answerForm = {
    classList: { toggle(name, enabled) { if (enabled) answerClasses.add(name); else answerClasses.delete(name); }, contains(name) { return answerClasses.has(name); } },
    querySelector() { return answerFields; }, querySelectorAll() { return [answerField]; },
  };
  const choiceLabel = { textContent: '' };
  const symbolSubmit = { disabled: true };
  const symbolSlots = Array.from({ length: 3 }, () => ({ textContent: '', attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, focus() {} }));
  const visual = { innerHTML: '', querySelector() { return null; } };
  const fullImage = { src: '', alt: '' };
  const galleryPages = { innerHTML: '' };
  const resumeDigits = Array.from({ length: 6 }, (_, index) => ({
    id: `resume-digit-${index}`, dataset: { resumeDigit: String(index) }, value: '',
    focused: false, selected: false, attributes: {},
    focus() { resumeDigits.forEach(input => { input.focused = false; }); this.focused = true; },
    select() { this.selected = true; },
    setAttribute(name, value) { this.attributes[name] = value; },
    closest() { return null; },
  }));
  const resumeError = { textContent: '' };
  const panelListeners = {};
  let markup = '';
  const renders = [];
  let insertedWorkspaceMarkup = '';
  const workspaceClasses = new Set();
  const workspace = {
    className: 'workspace', inert: false,
    get innerHTML() { return markup + insertedWorkspaceMarkup; },
    set innerHTML(content) {
      app.innerHTML = `<div class="shell"><main id="main" ${this.inert ? 'inert' : ''} class="${this.className}">${content}</main></div>`;
    },
    classList: { add(name) { workspaceClasses.add(name); }, remove(name) { workspaceClasses.delete(name); }, contains(name) { return workspaceClasses.has(name) || markup.includes(`workspace ${name}`); } },
    insertAdjacentHTML(position, html) {
      if (position === 'afterend') markup = markup.replace('</main></div>', `</main>${html}</div>`);
      else { assert.equal(position, 'beforeend'); insertedWorkspaceMarkup += html; }
    },
  };
  const historyBody = { scrollTop: 0 };
  const historyScreen = { remove() { insertedWorkspaceMarkup = insertedWorkspaceMarkup.replace(/<section class="history-screen"[\s\S]*?<\/section>/g, ''); } };
  const entryTransitions = [];
  const entryShell = {
    animate(frames, options) {
      let finish;
      const animation = { frames, options, markup,
        finished: new Promise(resolve => { finish = resolve; }),
        cancel() {}, finish() { finish(); } };
      entryTransitions.push(animation);
      return animation;
    },
  };
  const travelGallery = { scrollLeft: 0 };
  const app = {
    get innerHTML() { return markup; },
    set innerHTML(value) {
      markup = value;
      travelGallery.scrollLeft = 0;
      renders.push(value);
      insertedWorkspaceMarkup = '';
      const section = value.match(/<section id="composer-area"[^>]*>/)?.[0];
      composer.hidden = section?.includes(' hidden') ?? true;
      navigation.innerHTML = value.match(/<div id="problem-navigation"[^>]*>([\s\S]*?<\/nav>)/)?.[1] ?? '';
      problemMenu.hidden = !navigation.innerHTML.includes('aria-expanded="true"');
      if (value.includes('class="puzzle-symbol-answer"')) symbolSubmit.disabled = value.match(/<button type="submit"[^>]*>/)?.[0].includes('disabled') ?? true;
    },
  };
  const composer = { innerHTML: '', querySelector() { return null; }, hidden: true, inert: false, isConnected: true, scrollTop: 0, contains() { return false; }, focusCount: 0, focus() { this.focusCount++; } };
  const fab = { hidden: false, setAttribute() {}, focus() {} };
  const navigation = { innerHTML: '' };
  const problemMenu = { hidden: true, inert: false, isConnected: true };
  const problemToggle = { setAttribute(name, value) { if (name === 'aria-expanded') navigation.innerHTML = navigation.innerHTML.replace(/aria-expanded="[^"]*"/, `aria-expanded="${value}"`); }, focus() {} };
  const appended = [];
  const animations = [];
  const scrolls = [];
  const chat = { scrollTop: 0, scrollHeight: 300, clientHeight: 500, scrollTo(value) { scrolls.push(value); }, addEventListener(name, callback) { chatListeners[name] = callback; } };
  const messages = {
    insertAdjacentHTML(position, html) { assert.equal(position, 'beforeend'); appended.push(html); },
    lastElementChild: { classList: { add(value) { animations.push(value); } } },
  };
  const panelClasses = new Set();
  const panel = {
    open: false, innerHTML: '', dataset: {},
    classList: {
      add(name) { panelClasses.add(name); }, remove(name) { panelClasses.delete(name); },
      contains(name) { return panelClasses.has(name); },
      toggle(name, enabled) { if (enabled) panelClasses.add(name); else panelClasses.delete(name); },
    },
    querySelector(selector) { return selector.startsWith('#resume-digit-') ? resumeDigits[Number(selector.at(-1))] : ({ '.puzzle-full-image': fullImage, '.puzzle-gallery-pages': galleryPages, '#resume-error': resumeError })[selector] ?? null; },
    querySelectorAll(selector) { return selector === '[data-resume-digit]' ? resumeDigits : []; },
    showModal() { this.open = true; }, close() { this.open = false; }, addEventListener(name, callback) { panelListeners[name] = callback; }, removeEventListener(name, callback) { if (panelListeners[name] === callback) delete panelListeners[name]; }, style: { removeProperty() {} },
  };
  const menuListeners = {};
  const menu = {
    open: false, isConnected: true, inert: false,
    addEventListener(name, callback) { menuListeners[name] = callback; },
    showModal() { this.open = true; }, close() { this.open = false; },
  };
  const context = vm.createContext({
    mountHexCube: minigameMount, scenario, MOTION, createHaptics, answerReadiness, isComposingSubmit, bindImageViewer, bindSheetDismiss, animateEmphasis, toggleDisclosure, animateCombination, copyWithFeedback, createOverlayHistory, sanitizeAnswerDraft, ...engine, latestSceneStart, normalizePlayCode, isConversationLine, restorePlayView, pendingConversation, bindVisualViewport, crypto: globalThis.crypto, AbortController,
    createPlaySaveController: options => createPlaySaveController({ ...options, debounceMs: 60000, persistDebounceMs: 0, maxAutoRetries: 0,
      fetchImpl: async (url, init) => { networkCalls.push(JSON.parse(init.body)); if (fetchImpl) return fetchImpl(url, init); throw new Error('Harness network is offline'); } }),
    createConversationPlayer: options => createConversationPlayer({ ...options, schedule: timer.schedule, cancel: timer.cancel }),
    document: {
      ...(webMCP ? { modelContext: { registerTool(tool) { registeredTools.push(tool); } } } : {}),
      querySelector: selector => entryAnimations && ['.title-shell', '.shell'].includes(selector) ? entryShell : ({ '.chat-area .travel-guide-gallery': markup.includes('class="travel-guide-gallery"') ? travelGallery : null, '.workspace': markup.includes('class="workspace') ? workspace : null, '.history-screen': workspace.innerHTML.includes('class="history-screen"') ? historyScreen : null, '.history-body': workspace.innerHTML.includes('class="history-screen"') ? historyBody : null, '#app': app, '#panel': panel, '#messages': messages, '.chat-area': chat, '#conversation-notice': notice, '.composer-area': composer, '.answer-fab': fab, '#answer': answerField, '#answer-form': answerForm, '#answer-error': answerError, '#answer-choice-label': choiceLabel, '#problem-navigation': navigation, '#problem-menu': problemMenu, '.problem-toggle': problemToggle, '#navigation-menu': menu, '.puzzle-visual': visual, '.puzzle-symbol-answer button[type="submit"]': symbolSubmit, '#symbol-slot-0': symbolSlots[0], '#symbol-slot-1': symbolSlots[1], '#symbol-slot-2': symbolSlots[2] })[selector] ?? null,
      querySelectorAll() { return []; },
    getElementById(id) { return id.startsWith('symbol-slot-') ? symbolSlots[Number(id.at(-1))] : null; },
      addEventListener(name, callback) { const previous = listeners[name]; listeners[name] = previous ? event => { previous(event); callback(event); } : callback; },
    },
    window: { location: {href:entryUrl}, localStorage: storage, addEventListener(name, callback) { windowListeners[name] = callback; }, matchMedia() { return { matches: reducedMotion }; } },
    localStorage: storage,
    requestAnimationFrame(callback) { callback(); },
    getComputedStyle: () => ({ opacity: '1', transform: 'none' }),
    setTimeout: gestureTimer.schedule,
    clearTimeout: gestureTimer.cancel,
  });
  vm.runInContext(readFileSync(new URL('../dist/app.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, ''), context);
  // Puzzle regressions run in an explicit unsaved debug session. Snapshot helpers below
  // inspect in-memory engine state; persistence is verified separately in entry tests.
  if (!entryOnly) vm.runInContext(`{ const seed = ${saved === null ? 'initialState(scenario)' : `restoreState(scenario, ${JSON.stringify(saved)})`}; enterPlay(playSaves.enterDebug(seed, restorePlayView(scenario, seed, null))); }`, context);
  return {
    storageItems, storageCalls, networkCalls, registeredTools, renders, resumeDigits, entryTransitions,
    windowEvent(name, event = {}) { windowListeners[name]?.(event); },
    dispose() { vm.runInContext('conversationPlayer.stop(); playSaves.dispose()', context); },
    timer, gestureTimer, app, workspace, historyBody, historyScreen, composer, panel, answerField, answerForm, answerError, errorAnimations, choiceLabel, navigation, problemMenu, menu, menuListeners, appended, animations, scrolls, chat, notice, visual, fullImage, galleryPages, symbolSubmit, symbolSlots,
    panelEvent(name, event) { panelListeners[name](event); },
    chatEvent(name, event = {}) { chatListeners[name](event); },
    documentEvent(name, event = {}) { listeners[name](event); },
    evaluate: code => vm.runInContext(code, context),
    snapshot: () => vm.runInContext('JSON.stringify(state)', context),
    click(action, id, index = id) { listeners.click({ target: { closest: selector => selector === '[data-action]' ? { dataset: { action, id, index } } : selector === '.problem-navigation' && ['toggle-problems', 'select'].includes(action) ? {} : selector === '.navigation-menu' && action === 'toggle-menu' ? {} : null } }); },
  };
}

function finishScene(h) {
  if (h.timer.pending.size) h.timer.drain();
  const limit = h.evaluate('state.messages.length + 1');
  for (let i = 0; i < limit && h.evaluate('isPlaying'); i++) h.click(h.evaluate('epiloguePhase') ? 'epilogue-next' : 'novel-next');
  assert.equal(h.evaluate('isPlaying'), false);
}

test('正誤判定で一度だけ振動を要求し、自動会話や履歴の再表示では振動しない', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.evaluate(`globalThis.hapticEvents = []; haptics.trigger = (kind = 'selection') => hapticEvents.push(kind);`);
  h.evaluate("answer(['1'])");
  h.evaluate("answer(['10'])");
  assert.deepEqual(Array.from(h.evaluate('hapticEvents')), ['error', 'success']);
  h.click('novel-next');
  assert.deepEqual(Array.from(h.evaluate('hapticEvents')), ['error', 'success', 'dialogue']);
  h.evaluate('openHistoryScreen(); closeHistoryScreen()');
  assert.deepEqual(Array.from(h.evaluate('hapticEvents')), ['error', 'success', 'dialogue']);
});

test('N1正解で手がかりを取得しても会話・指示の後にノートの通知を出さない', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.evaluate("answer(['10'])");
  finishScene(h);
  assert.deepEqual(Array.from(h.evaluate('unlockedCards(scenario, state).map(c => c.id)')), ['A1']);
  assert.ok(h.app.innerHTML.includes('class="travel-guide-gallery"'));
  assert.doesNotMatch(h.renders.join(''), /class="clue-notice"|新しい手がかりをノートに|data-action="notebook"/);
});

test('Q3の円は付箋の新規正解でだけ前の角度から広がり、動きを減らす設定では即座に反映する', t => {
  for (const reduced of [false, true]) {
    const h = appHarness(null, reduced);
    t.after(() => h.dispose());
    h.evaluate(`globalThis.sweeps = [];
      const query = document.querySelector;
      document.querySelector = selector => selector === '.investigation-progress'
        ? { animate: frames => sweeps.push(frames.map(f => f['--answered-angle'])) } : query(selector);`);
    h.click('select', 'Q3');
    for (const id of ['Q3.3', 'Q3.3.1', 'Q3', 'Q3.2']) {
      h.evaluate(`state.solved.push('${id}'); showInvestigation(); showInvestigation();`);
    }
    assert.deepEqual(JSON.parse(h.evaluate('JSON.stringify(sweeps)')), reduced ? [] : [
      ['0deg', '120deg'], ['120deg', '240deg'], ['240deg', '360deg'],
    ]);
    assert.ok(h.app.innerHTML.includes('--answered-angle: 360deg'));
  }
});

test('Q3の最後の新規正解は完了用の振動に置き換え、二重に振動しない', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.evaluate(`state.solved = scenario.investigation.problemIds.filter(id => id !== 'Q3.3.1');
    composerExpanded = true; selectProblem('Q3.3.1', { answering: true, investigationDetail: true });
    globalThis.completionEvents = []; haptics.trigger = kind => completionEvents.push(kind);
    answer('かべおせ');`);
  assert.deepEqual(JSON.parse(h.evaluate('JSON.stringify(completionEvents)')), ['complete']);
});

test('冥の章演出は宵から進む操作でだけ表示し、動きを減らす設定では省略する', t => {
  for (const reduced of [false, true]) {
    const h = appHarness(null, reduced);
    t.after(() => h.dispose());
    h.evaluate(`state.selected = 'N5.5'; state.solved = ['N5.5']; yoiEndView = true;`);
    h.click('continue-at-venue');
    assert.equal(h.workspace.innerHTML.includes('class="chapter-transition"'), !reduced);
    assert.ok(!h.workspace.innerHTML.includes('<strong>冥</strong>'));
    assert.equal(h.evaluate('state.selected'), 'Q1');
    h.evaluate('render()');
    assert.ok(!h.workspace.innerHTML.includes('class="chapter-transition"'));
  }
});

test('複数の空欄がそろった通知は正誤を判定せず、復元・IME変換途中では振動しない', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.click('select', 'N4');
  h.evaluate(`globalThis.readyEvents = []; haptics.trigger = kind => readyEvents.push(kind);
    { const form = document.querySelector('#answer-form'); form.elements = []; form.dataset = {};
      form.querySelectorAll = () => []; form.querySelector = () => null; }
    selectedSymbols = ['0', '', '']; updateAnswerReadiness();
    composingAnswer = true; selectedSymbols = ['0', '1', '2']; updateAnswerReadiness({ feedback: true });`);
  assert.deepEqual(JSON.parse(h.evaluate('JSON.stringify(readyEvents)')), []);
  h.evaluate('composingAnswer = false; updateAnswerReadiness({ feedback: true }); updateAnswerReadiness({ feedback: true })');
  assert.deepEqual(JSON.parse(h.evaluate('JSON.stringify(readyEvents)')), ['ready']);
  assert.equal(h.evaluate('state.solved.includes("N4")'), false);
});

test('表示中の回答パネルがなければ正解後はすぐ会話へ進む', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  assert.equal(h.evaluate("answer(['10']).status"), 'correct');
  assert.equal(h.evaluate('isPlaying'), true);
  assert.equal(h.composer.hidden, true);
  assert.equal(h.gestureTimer.pending.size, 0);
  assert.equal(h.timer.pending.size, 0);
  assert.equal(h.evaluate('displayedMessages.length'), 1);
});

test('正解したフレームで最初の台詞と進行を保存し、二重送信や移動後の再生を防ぐ', t => {
  for (const reducedMotion of [false, true]) {
    const h = appHarness(null, reducedMotion);
    t.after(() => h.dispose());
    h.click('select', 'N1');
    h.composer.animate = () => assert.fail('回答パネルの退出を待たない');
    assert.equal(h.evaluate("answer(['10']).status"), 'correct');
    assert.equal(h.composer.hidden, true);
    const record = h.evaluate('playSaves.getRecord()');
    assert.ok(record.state.solved.includes('N1'));
    assert.equal(record.view.displayedCount, 1);
    assert.equal(h.evaluate("answer(['10']).status"), 'busy');
    h.click('start');
    assert.equal(h.evaluate('isPlaying'), false);
    assert.equal(h.evaluate('displayedMessages.length'), 0);
  }
});

function menuButton(h, action) {
  return {
    dataset: { action },
    closest(selector) {
      if (selector === '[data-action]' || selector === '.menu-items [data-action]') return this;
      if (selector === '.navigation-menu' || selector === '#navigation-menu') return h.menu;
      if (selector === '[inert]' && h.menu.inert) return h.menu;
      return null;
    },
  };
}

test('開いたメニューの履歴を押すと、メニューが閉じて会話履歴が開く', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  const historyButton = menuButton(h, 'history');
  h.click('toggle-menu');
  assert.equal(h.menu.inert, false);
  h.documentEvent('click', { target: historyButton });
  assert.equal(h.menu.inert, true);
  assert.equal(h.evaluate('historyView'), true);
  assert.match(h.workspace.innerHTML, /class="menu-button clue-back" data-action="history-back" aria-label="戻る"/);
  assert.doesNotMatch(h.workspace.innerHTML, /data-action="history-back"[^>]*>[\s\S]*?<span>トーク<\/span><\/button>/);
  h.click('history-back');
  h.documentEvent('click', { target: historyButton });
  assert.equal(h.evaluate('historyView'), false, '閉じかけのメニューからは再度開かない');
});

test('メニューの手がかりはQ1から上部ボタンと同じ画面を開く', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  const nav = () => h.app.innerHTML.match(/<nav id="navigation-menu"[^>]*>([\s\S]*?)<\/nav>/)[1];
  for (const id of [null, 'N5.5', 'Q1', 'Q2', 'N1']) {
    if (id) h.click('select', id);
    assert.doesNotMatch(nav(), /ノート|data-action="notebook"/);
    assert.equal(nav().includes('data-action="clues"'), ['Q1', 'Q2'].includes(id));
  }
  h.click('select', 'Q1');
  h.click('toggle-menu');
  h.documentEvent('click', { target: menuButton(h, 'clues') });
  assert.ok(h.menu.inert);
  assert.ok(h.panel.open);
  assert.match(h.panel.innerHTML, /aria-labelledby="clue-tab-cards"/);
});

for (const [action, heading] of [['hints', 'ヒント'], ['trouble', 'トラブル'], ['save-info', 'デバッグモード']]) {
  test(`メニューから「${heading}」を選ぶと対応する画面を表示する`, t => {
    const h = appHarness();
    t.after(() => h.dispose());
    h.click('toggle-menu');
    h.documentEvent('click', { target: menuButton(h, action) });
    assert.ok(h.menu.inert);
    assert.ok(h.panel.open);
    assert.ok(h.panel.innerHTML.includes('>' + heading + '</h2>'));
    assert.doesNotMatch(h.panel.innerHTML, /NOVEMBER ARCHIVE/);
    if (action === 'hints') {
      assert.doesNotMatch(h.panel.innerHTML, /class="panel-intro"/);
      assert.ok(h.panel.innerHTML.includes(scenario.problems[0].hints[0]));
    }
  });
}

test('履歴はダイアログを使わず専用画面へ移り、閉じても入力内容と会話位置を維持する', async t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.click('open-composer');
  assert.ok(h.panel.innerHTML.includes('「次へ」ボタンについて'));
  h.click('start-answer-confirm');
  await Promise.resolve();
  const chatMarkup = h.app.innerHTML;
  h.chat.scrollTop = 86;
  h.answerField.value = '入力途中';
  h.click('history');
  assert.equal(h.panel.open, false);
  assert.equal(h.evaluate('historyView'), true);
  assert.equal(h.app.innerHTML, chatMarkup, '回答欄のDOMを差し替えない');
  assert.ok(h.workspace.innerHTML.includes('class="history-screen"'));
  assert.ok(h.workspace.innerHTML.includes('まだ会話履歴はありません。'));
  assert.equal(h.evaluate('capturePlayView().chatScrollTop'), 86);
  const before = h.snapshot();
  assert.equal(h.evaluate("answer(['10']).status"), 'unavailable');
  assert.equal(h.snapshot(), before);
  h.click('history-back');
  assert.equal(h.evaluate('historyView'), false);
  assert.equal(h.workspace.innerHTML.includes('class="history-screen"'), false);
  assert.equal(h.answerField.value, '入力途中');
  assert.equal(h.chat.scrollTop, 86);
  assert.equal(h.composer.hidden, false);
});

test('履歴は新しい問題順で、閲覧中の問題にかかわらず先頭の1つだけを開く', t => {
  let saved = engine.initialState(scenario);
  saved = engine.submitAnswer(scenario, saved, ['10']).state;
  saved = engine.submitAnswer(scenario, { ...saved, selected: 'N2' }, '法経済学部北館').state;
  const h = appHarness(JSON.stringify(saved));
  t.after(() => h.dispose());
  h.click('select', 'N1');
  h.click('history');
  const history = h.evaluate('historyScreenMarkup()');
  assert.ok(history.indexOf('data-history-problem="N2"') < history.indexOf('data-history-problem="N1"'));
  assert.equal(h.evaluate('JSON.stringify([...historyOpenProblems])'), '["N2"]');
  assert.equal((history.match(/data-history-problem="[^"]+" open/g) ?? []).length, 1);
  h.documentEvent('toggle', { target: { dataset: { historyProblem: 'N1' }, open: true } });
  h.click('history-back');
  h.click('history');
  assert.equal(h.evaluate('JSON.stringify([...historyOpenProblems])'), '["N2"]');
});

test('履歴に未表示の会話を先出しせず、閉じた後に同じ台詞から進める', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.evaluate("selectProblem('N2'); answer('法経済学部北館')");
  const scene = scenario.problems.find(p => p.id === 'N2').dialogue;
  h.click('history');
  const history = h.evaluate('historyScreenMarkup()');
  assert.ok(history.includes(scene[0].text));
  assert.ok(!history.includes(scene[1].text));
  h.historyBody.scrollTop = 48;
  h.documentEvent('toggle', { target: { dataset: { historyProblem: 'N2' }, open: false } });
  h.click('novel-next');
  assert.equal(h.evaluate('displayedMessages.length'), 1);
  assert.equal(h.evaluate('historyView'), true);
  assert.ok(h.workspace.innerHTML.includes('class="history-screen"'));
  assert.ok(!h.workspace.innerHTML.includes(scenario.problems.find(p => p.id === 'N2').travelGuide.steps[0].directions));
  assert.equal(h.evaluate('historyOpenProblems.has("N2")'), false);
  assert.equal(h.historyBody.scrollTop, 48);
  h.documentEvent('keydown', { key: 'Escape' });
  assert.equal(h.evaluate('historyView'), false);
  h.click('novel-next');
  assert.ok(h.app.innerHTML.includes(scene[1].text));
});

test('文章量にかかわらず1.4秒間隔で順次表示し、終了を一度だけ通知する', () => {
  for (const kind of ['dialogue', 'narration', 'instruction']) {
    for (const text of ['短いセリフ', 'あ'.repeat(100), '長い文章\n'.repeat(100)]) {
      assert.equal(readingDelay({ kind, text }), 1400);
    }
  }
  const timer = clock();
  const shown = [];
  let complete = 0;
  const player = createConversationPlayer({ onMessage: m => shown.push(m.text), onComplete: () => complete++, schedule: timer.schedule, cancel: timer.cancel });
  const longText = '長い文章'.repeat(100);
  player.play([{ kind: 'dialogue', text: '先' }, { kind: 'dialogue', text: longText }]);
  assert.deepEqual(shown, []);
  assert.equal(timer.tick(), 300);
  assert.deepEqual(shown, ['先']);
  assert.equal(timer.tick(), 1400);
  assert.deepEqual(shown, ['先', longText]);
  assert.equal(complete, 0);
  assert.equal(timer.tick(), 1400);
  assert.equal(complete, 1);
  assert.equal(timer.pending.size, 0);
});

test('正解直後の自動会話は最初の行が即時に表示され、次の行は通常の間隔で続く', () => {
  const timer = clock();
  const shown = [];
  const player = createConversationPlayer({ onMessage: line => shown.push(line.text), onComplete() {}, schedule: timer.schedule, cancel: timer.cancel });
  player.play([{ kind: 'dialogue', text: '一行目' }, { kind: 'dialogue', text: '二行目' }], { immediate: true });
  assert.deepEqual(shown, ['一行目']);
  assert.equal(timer.tick(), 1400);
  assert.deepEqual(shown, ['一行目', '二行目']);
  player.stop();
});

test('再生の置き換えと中断では、古いタイマーから会話が混入しない', () => {
  const timer = clock();
  const shown = [];
  const player = createConversationPlayer({ onMessage: m => shown.push(m.text), onComplete() {}, schedule: timer.schedule, cancel: timer.cancel });
  player.play([{ kind: 'dialogue', text: '古い会話' }]);
  const stale = [...timer.pending.values()][0].callback;
  player.play([{ kind: 'dialogue', text: '新しい会話' }]);
  stale();
  timer.tick();
  assert.deepEqual(shown, ['新しい会話']);
  player.stop();
  assert.equal(timer.pending.size, 0);
});

test('N1正解後は立ち絵と台詞を一つずつ手動で進め、最後に移動案内と回答を表示する', async () => {
  const h = appHarness();
  const problem = scenario.problems[0];
  h.evaluate("answer(['10'])");
  for (const [index, line] of problem.dialogue.entries()) {
    if (line.text.startsWith('指示：')) break;
    assert.equal(h.timer.pending.size, 0);
    assert.equal(h.evaluate('displayedMessages.length'), index + 1);
    assert.equal((h.app.innerHTML.match(/class="novel-line"/g) ?? []).length, 1);
    assert.ok(h.app.innerHTML.includes(line.text));
    if (problem.dialogue[index + 1]?.text.startsWith('指示：')) {
      assert.ok(h.app.innerHTML.includes('aria-hidden="true">▷'));
      assert.ok(!h.app.innerHTML.includes('移動案内へ'));
    }
    assert.ok(!h.app.innerHTML.includes('class="answer-fab"'));
    const portrait = scenario.portraits[line.speaker];
    assert.equal(h.app.innerHTML.includes('class="novel-stage novel-right"'), line.speaker === 'タツ');
    assert.equal(h.app.innerHTML.includes('<div class="novel-portrait"><img'), Boolean(portrait));
    if (portrait) assert.ok(h.app.innerHTML.includes(portrait));
    if (!index) {
      assert.equal(h.evaluate("answer(['10']).status"), 'busy');
      h.click('history');
      assert.ok(h.workspace.innerHTML.includes(line.text));
      assert.ok(!h.workspace.innerHTML.includes(problem.dialogue[1].text));
      h.click('history-back');
      assert.equal(h.evaluate('displayedMessages.length'), 1);
    }
    h.click('novel-next');
  }
  assert.equal(h.evaluate('isPlaying'), false);
  assert.equal(h.evaluate('displayedMessages.length'), problem.dialogue.length);
  assert.ok(!h.app.innerHTML.includes(problem.dialogue[0].text));
  assert.ok(h.app.innerHTML.includes(problem.travelGuide.steps[0].directions));
  assert.ok(h.app.innerHTML.includes('class="answer-fab"'));
  assert.ok(!h.app.innerHTML.includes('〈N2が貼ってある場所の写真をここに挿入〉'));
  h.chat.scrollTop = 48;
  h.click('travel-next');
  h.click('travel-found');
  assert.equal(h.evaluate('state.selected'), 'N2');
  assert.equal(h.scrolls.at(-1).behavior, 'instant');
  assert.equal(h.scrolls.at(-1).top, 48);
  assert.equal(h.evaluate("document.querySelector('.answer-fab').disabled"), true);
  assert.ok(h.composer.innerHTML.includes('class="composer-hint"'));
  assert.ok(!h.composer.innerHTML.includes('data-action="close-composer"'));
  assert.ok(h.evaluate('headerActionsMarkup()').includes('data-action="history"'));
  await Promise.resolve();
  await Promise.resolve();
  h.documentEvent('keydown', { key: 'Escape' });
  assert.equal(h.evaluate('historyView'), true);
  assert.equal(h.evaluate('state.selected'), 'N2');
  h.click('history-back');
  assert.equal(h.evaluate('historyView'), false);
  assert.equal(h.evaluate("document.querySelector('.answer-fab').disabled"), true);
});

test('N1〜N3・N4.1の移動写真と説明は指示カード内にまとめ、履歴の問題の写真も個別に拡大する', async t => {
  const h = appHarness();
  t.after(() => h.dispose());
  for (const id of ['N1', 'N2', 'N3', 'N4.1']) {
    const problem = scenario.problems.find(p => p.id === id);
    const instruction = { ...problem.dialogue.find(line => line.text.startsWith('指示：')), kind: 'dialogue', problemId: id };
    const markup = h.evaluate(`messageMarkup(${JSON.stringify(instruction)})`);
    assert.ok(markup.indexOf('instruction-card-copy') < markup.indexOf('travel-guide-photo'));
    assert.ok(markup.indexOf('travel-guide-photo') < markup.indexOf('</article>'));
    assert.ok(markup.includes(problem.travelGuide.steps[0].directions));
    assert.ok(markup.includes(`data-action="travel-image" data-id="${id}"`));
    for (const line of problem.dialogue.filter(line => line.travelGuidePart)) {
      // 保存済みの旧メッセージに表示用の属性がなくても二重に表示しない。
      const legacy = { speaker: line.speaker, text: line.text, kind: 'dialogue', problemId: id };
      const legacyMarkup = h.evaluate(`messageMarkup(${JSON.stringify(legacy)})`);
      assert.equal(legacyMarkup, '');
    }
    const photos = { N1: [2, 3, 4, 5], N2: [7, 8, 9, 10, 11], N3: [13, 14, 15, 16, 17, 18, 19], 'N4.1': [21, 22] };
    assert.deepEqual(Array.from(markup.matchAll(/src="..\/assets\/travel\/(\d+)\.preview\.webp"/g), match => Number(match[1])), photos[id]);
    assert.ok(!markup.includes('仮の写真'));
    const before = h.snapshot();
    for (const [index, step] of problem.travelGuide.steps.entries()) {
      assert.ok(markup.includes(`data-id="${id}" data-index="${index}"`));
      assert.ok(markup.includes(step.directions));
      h.click('travel-image', id, index);
      assert.equal(h.panel.open, true);
      assert.equal(h.panel.classList.contains('image-viewer'), true);
      assert.equal(h.panel.classList.contains('image-gallery'), false);
      assert.ok(h.panel.innerHTML.includes(`${problem.travelGuide.destination}の案内写真${index + 1}</h2>`));
      assert.ok(h.panel.innerHTML.includes(`src="${step.image}"`));
      assert.ok(h.panel.innerHTML.includes('data-action="image-zoom-in"'));
      assert.equal(h.snapshot(), before);
      h.click('close');
      await Promise.resolve();
    }
  }
});

test('メニューのトラブル欄からN5の補助写真を拡大し、一覧へ戻れる', async t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.click('toggle-menu');
  assert.ok(h.app.innerHTML.includes('data-action="trouble"'));
  h.click('trouble');
  assert.match(h.panel.innerHTML, /<details class="trouble-photos"><summary>N5の現地資料が見られないとき/);
  for (const [index, number] of [24, 25, 26, 27].entries()) {
    assert.ok(h.panel.innerHTML.includes(`src="../assets/travel/${number}.preview.webp"`));
    h.click('travel-image', 'trouble', index);
    assert.ok(h.panel.innerHTML.includes(`class="puzzle-full-image" src="../assets/travel/${number}.webp"`));
    h.click('close');
    assert.ok(h.panel.innerHTML.includes('class="trouble-photos"'));
  }
  h.click('close');
  await Promise.resolve();
  assert.equal(h.panel.open, false);
});

test('不正解は回答欄を赤く揺らし、回答欄・入力・会話を保持してすぐ再回答できる', async () => {
  const h = appHarness();
  h.click('open-composer');
  assert.ok(h.panel.innerHTML.includes('「次へ」ボタンについて'));
  h.click('start-answer-confirm');
  await Promise.resolve();
  h.click('choose-answer', '1');
  const before = h.evaluate('JSON.stringify(state.messages)');
  const markup = h.app.innerHTML;
  assert.equal(h.evaluate("answer(['1']).status"), 'incorrect');
  assert.equal(h.composer.hidden, false);
  assert.equal(h.answerField.value, '1');
  assert.equal(h.evaluate('JSON.stringify(state.messages)'), before);
  assert.equal(h.app.innerHTML, markup);
  assert.equal(h.evaluate('isPlaying'), false);
  assert.equal(h.timer.pending.size, 0);
  assert.equal(h.answerForm.classList.contains('is-incorrect'), true);
  assert.equal(h.answerField.attributes['aria-invalid'], 'true');
  assert.ok(h.answerError.textContent.includes('答えが違います'));
  assert.equal(h.errorAnimations.length, 1);
  assert.equal(h.errorAnimations[0].frames.length, 7);
  h.evaluate("answer(['1'])");
  assert.equal(h.errorAnimations.length, 2);
  assert.equal(h.errorAnimations[0].cancelled, true);
  h.click('choose-answer', '10');
  assert.equal(h.answerForm.classList.contains('is-incorrect'), false);
  assert.equal(h.answerError.textContent, '');
  h.evaluate("answer(['10'])");
  finishScene(h);
  assert.ok(!JSON.parse(h.snapshot()).messages.some(m => m.kind === 'error'));
  h.click('replay');
  assert.equal(h.evaluate('displayedMessages.length'), 1);
  finishScene(h);
  assert.equal(h.evaluate('displayedMessages.length'), 11);
});

test('文字入力・記号選択・選択式でも不正解後の会話と回答を保ち、編集で赤色を解除する', () => {
  for (const [id, value] of [['N2', '不正解'], ['N4', '88↙'], ['Q2', ['2']]]) {
    const h = appHarness();
    h.click('select', id);
    h.answerField.value = String(value);
    const before = h.evaluate('JSON.stringify({ state, displayedMessages })');
    assert.equal(h.evaluate(`answer(${JSON.stringify(value)}).status`), 'incorrect');
    assert.equal(h.evaluate('JSON.stringify({ state, displayedMessages })'), before);
    assert.equal(h.composer.hidden, false);
    assert.equal(h.answerField.value, String(value));
    assert.equal(h.answerForm.classList.contains('is-incorrect'), true);
    h.documentEvent('input', { target: { closest: () => h.answerForm } });
    assert.equal(h.answerForm.classList.contains('is-incorrect'), false);
    assert.equal(h.answerField.attributes['aria-invalid'], undefined);
  }
});

test('動きを減らす設定では不正解の赤色のみ表示する', () => {
  const h = appHarness(null, true);
  h.click('open-composer');
  h.evaluate("answer(['1'])");
  assert.equal(h.answerForm.classList.contains('is-incorrect'), true);
  assert.equal(h.errorAnimations.length, 0);
});

test('デバッグで進行中にリセットすると、会話再生を中断して最初の問題へ戻る', () => {
  const h = appHarness();
  h.evaluate("answer(['10'])");
  h.click('confirm-reset');
  assert.equal(h.timer.pending.size, 0);
  assert.equal(h.evaluate('isPlaying'), false);
  assert.ok(h.app.innerHTML.includes('問題番号 <strong>スタート</strong>'));
  assert.equal(JSON.parse(h.snapshot()).solved.length, 0);
  assert.equal(h.storageCalls.filter(([action]) => action !== 'get').length, 0);
});

function playScrollTestConversation(h) {
  h.evaluate(`state.messages.push(...['最初の行', '次の行'].map(text => ({ problemId: state.selected, kind: 'dialogue', speaker: '', text })));
    playConversation(state.messages.length - 2)`);
}

test('動きを減らす設定では自動スクロールを瞬時に行う', () => {
  const h = appHarness(null, true);
  playScrollTestConversation(h);
  h.chat.scrollHeight = 900;
  h.timer.tick();
  assert.equal(h.scrolls.at(-1).behavior, 'auto');
  h.timer.drain();
});

test('触っている間は自動追従を止め、会話が追加されたことを表示する', () => {
  const h = appHarness();
  playScrollTestConversation(h);
  h.timer.tick();
  h.chat.scrollHeight = 900;
  h.chatEvent('touchstart');
  const pausedScrolls = h.scrolls.length;
  h.timer.tick();
  assert.equal(h.scrolls.length, pausedScrolls);
  assert.equal(h.notice.hidden, false);
  assert.equal(h.notice.textContent, '↓ 続きの会話（1）');
  h.documentEvent('touchend');
  h.timer.tick();
  assert.equal(h.scrolls.length, pausedScrolls);
  assert.equal(h.notice.textContent, '↓ 続きの会話（1）');
  // 最後の会話と操作ボタンが出ても、読んでいる場所を変えない。
  h.timer.drain();
  assert.equal(h.scrolls.length, pausedScrolls);
  assert.equal(h.chat.scrollTop, 0);
  assert.equal(h.notice.hidden, false);
  h.click('continue-conversation');
  assert.equal(h.notice.hidden, true);
  assert.equal(h.evaluate('followChat'), true);
  assert.deepEqual({ ...h.scrolls.at(-1) }, { top: 400, behavior: 'smooth' });
});

test('手動で最下部に戻れば案内を消して自動追従を再開する', () => {
  const h = appHarness();
  playScrollTestConversation(h);
  h.chat.scrollHeight = 900;
  h.chatEvent('pointerdown');
  h.timer.tick();
  h.chat.scrollTop = 400;
  h.chatEvent('scroll');
  assert.equal(h.evaluate('followChat'), false); // まだ押している間
  h.documentEvent('pointerup');
  assert.equal(h.evaluate('followChat'), true);
  assert.equal(h.notice.hidden, true);
  const before = h.scrolls.length;
  h.chat.scrollHeight = 1000;
  h.timer.tick();
  assert.equal(h.scrolls.length, before + 1);
});

test('ホイール操作中も追従しない。最下部以外では操作後も位置を維持する', () => {
  const h = appHarness();
  playScrollTestConversation(h);
  h.chat.scrollHeight = 900;
  h.chatEvent('wheel');
  const before = h.scrolls.length;
  h.timer.tick();
  assert.equal(h.scrolls.length, before);
  h.gestureTimer.drain();
  assert.equal(h.evaluate('followChat'), false);
  h.chat.scrollTop = 400;
  h.chatEvent('scroll');
  assert.equal(h.evaluate('followChat'), true);
  assert.equal(h.notice.hidden, true);
});

test('自動スクロールの途中のscrollイベントでは追従を解除しない', () => {
  const h = appHarness();
  playScrollTestConversation(h);
  h.chat.scrollHeight = 900;
  h.timer.tick();
  h.chat.scrollTop = 100;
  h.chatEvent('scroll');
  assert.equal(h.evaluate('followChat'), true);
  h.timer.tick();
  assert.equal(h.notice.hidden, true);
});

test('N2は場所のプルダウンを表示し、正解後はタツのセリフから順次再生する', () => {
  const h = appHarness();
  h.evaluate("selectProblem('N2')");
  assert.ok(h.app.innerHTML.includes('<select id="answer"'));
  assert.ok(!h.app.innerHTML.includes('type="text"'));
  assert.ok(h.app.innerHTML.includes('場所を選択…'));
  assert.ok(!h.app.innerHTML.includes('type="radio"'));
  assert.equal(h.evaluate("answer('法経済学部北館').status"), 'correct');
  assert.ok(h.app.innerHTML.includes('線が交差するところは、法経済学部北館だね'));
  assert.ok(!h.app.innerHTML.includes('<small>N2</small>'));
  finishScene(h);
  assert.equal(h.evaluate('displayedMessages.length'), 10);
  assert.ok(h.app.innerHTML.includes('<p class="instruction-card-copy"><strong class="instruction-place">法経済学部北館</strong>へ向かおう。'));
  assert.ok(h.app.innerHTML.includes('現地で<strong class="instruction-find">N3</strong>と書かれた問題を見つけたら上部の「次へ」ボタンを押しましょう。'));
  assert.ok(h.app.innerHTML.includes('class="instruction-card" aria-label="目的地に移動しよう"'));
  assert.ok(!h.app.innerHTML.includes('指示：法経済学部北館'));
  assert.ok(h.app.innerHTML.includes('class="travel-guide-photo"'));
  assert.ok(!h.app.innerHTML.includes('milestone'));
});

test('N2・N4.1・N5は指定の15候補を同じ順番で表示し、従来の正解だけを受理する', t => {
  const choices = ['総合研究4号館', '総合研究8号館', '文学部校舎', '法経済学部北館', '時計台', '附属図書館', '総合人間学部棟', '人間・環境学研究科棟', '吉田南3号館', 'お化け屋敷', '近衛館', '占いの館', 'お祭り広場', '吉田南総合図書館', 'ステージ'];
  const h = appHarness();
  t.after(() => h.dispose());
  for (const [id, expected] of [['N2', '法経済学部北館'], ['N4.1', '人間・環境学研究科棟'], ['N5', 'お化け屋敷']]) {
    const problem = scenario.problems.find(p => p.id === id);
    assert.deepEqual(problem.answerChoices, choices);
    h.click('select', id);
    assert.ok(h.app.innerHTML.includes('<select id="answer" name="answer" required>'));
    assert.ok(!h.app.innerHTML.includes('id="answer" name="answer" type="text"'));
    assert.equal((h.app.innerHTML.match(/<option value=/g) ?? []).length, 16);
    for (const choice of choices) assert.equal(engine.checkAnswer(problem, choice), choice === expected);
    assert.equal(engine.submitAnswer(scenario, { ...engine.initialState(scenario), selected: id }, '').status, 'empty');
    assert.equal(h.evaluate(`answer(${JSON.stringify(expected)}).status`), 'correct');
    finishScene(h);
  }
});

test('N2からN3へ進み、末で正解すると12件の会話を順次表示してN4へ進む', () => {
  const h = appHarness();
  h.evaluate("selectProblem('N2')");
  h.evaluate("answer('法経済学部北館')");
  finishScene(h);
  assert.ok(h.app.innerHTML.includes('data-action="travel-next"'));
  h.click('travel-next');
  assert.ok(h.panel.innerHTML.includes('次の問題を見つけたらページをめくろう'));
  h.click('travel-found');
  assert.equal(h.evaluate('state.selected'), 'N3');
  assert.ok(h.composer.innerHTML.includes('漢字で入力…'));
  assert.equal(h.evaluate("answer('末').status"), 'correct');
  assert.equal(h.evaluate('displayedMessages[0].speaker'), 'ミサメ');
  assert.ok(h.app.innerHTML.includes('だから答えは末吉の末！'));
  finishScene(h);
  assert.equal(h.evaluate('displayedMessages.length'), 12);
  assert.ok(h.app.innerHTML.includes('<p class="instruction-card-copy"><strong class="instruction-place">吉田南、総人広場を抜けた先にある掲示板</strong>へ行こう。'));
  assert.ok(h.app.innerHTML.includes('現地で<strong class="instruction-find">末席同好会のチラシ</strong>を見つけたら上部の「次へ」ボタンを押しましょう。'));
  assert.ok(h.app.innerHTML.includes('class="travel-guide-photo"'));
  assert.ok(h.app.innerHTML.includes('data-action="travel-next"'));
  h.click('travel-next');
  assert.ok(h.panel.innerHTML.includes('次の問題を見つけたらページをめくろう'));
  h.click('travel-found');
  assert.equal(h.evaluate('state.selected'), 'N4');
});

test('N4の正解でN4.1に切り替え、建物名の正解後に会話を始める', () => {
  const h = appHarness();
  h.evaluate("selectProblem('N4')");
  const before = h.app.innerHTML;
  h.chat.scrollTop = 100;
  assert.equal(h.evaluate("answer('89↙').problemId"), 'N4');
  assert.equal(h.evaluate('state.selected'), 'N4.1');
  assert.equal(h.app.innerHTML, before);
  assert.equal(h.chat.scrollTop, 100);
  assert.equal(h.timer.pending.size, 0);
  assert.ok(h.composer.innerHTML.includes('「89」はどこを意味する？'));
  assert.ok(h.composer.innerHTML.includes('建物名を選んでください。'));
  h.evaluate("answer('人間・環境学研究科棟')");
  assert.equal(h.evaluate('state.selected'), 'N4.1');
  assert.equal(h.evaluate('isPlaying'), true);
  assert.ok(!h.navigation.innerHTML.includes('data-id="N4.2"'));
  assert.ok(h.app.innerHTML.includes('正解は89の↙'));
  const restored = appHarness(h.snapshot());
  assert.equal(restored.evaluate('state.selected'), 'N4.1');
  assert.equal(restored.evaluate('state.solved.includes("N4.1")'), true);
  assert.equal(restored.evaluate('displayedMessages.length'), 8);
  finishScene(h);
  assert.equal(h.evaluate('displayedMessages.length'), 8);
  assert.ok(h.app.innerHTML.includes('<p class="instruction-card-copy"><strong class="instruction-place">人間・環境学研究科棟、南西の角</strong>へ向かおう。'));
  assert.ok(h.app.innerHTML.includes('現地で<strong class="instruction-find">N5</strong>と書かれた問題を見つけたら上部の「次へ」ボタンを押しましょう。'));
});

test('N4からN4.1へは資料のDOMを保持し、問題文と回答欄だけ切り替える', () => {
  const h = appHarness();
  h.click('select', 'N4');
  h.click('puzzle-page', '1');
  const originalApp = h.app.innerHTML;
  const messages = h.evaluate('state.messages');
  const copy = { innerHTML: '' };
  const response = { innerHTML: '' };
  const heading = { textContent: 'N4' };
  const preview = { label: '', setAttribute(name, value) { if (name === 'aria-label') this.label = value; } };
  const feedback = { textContent: '' };
  const card = {
    attributes: {}, dataset: { answerLayout: 'compact' },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelector(selector) { return ({ '.puzzle-card-copy': copy, '.puzzle-card-response': response, '.puzzle-preview': preview })[selector] ?? null; },
  };
  h.composer.querySelector = selector => ({ '.start-puzzle-card': card, '.answer-composer-heading h2': heading, '.feedback': feedback })[selector] ?? null;
  Object.defineProperty(h.composer, 'innerHTML', { set() { assert.fail('資料を含む回答エリア全体は作り直さない'); } });
  for (const [answer, nextId, question] of [['89↙', 'N4.1', '「89」はどこを意味する？']]) {
    assert.equal(h.evaluate(`answer('${answer}').status`), 'correct');
    assert.equal(heading.textContent, nextId);
    assert.equal(card.attributes['data-problem-id'], nextId);
    assert.ok(copy.innerHTML.includes(question));
    assert.ok(!copy.innerHTML.includes('puzzle-visual'));
    assert.ok(!copy.innerHTML.includes('id="answer-form"'));
    assert.ok(response.innerHTML.includes('id="answer-form"'));
    assert.ok(response.innerHTML.includes('aria-label="答えを送信"'));
    assert.equal(card.attributes['data-has-destination'], 'false');
    assert.equal(preview.label, `${nextId}の図を拡大表示`);
    assert.equal(h.evaluate('puzzleImageIndex'), 1);
    assert.equal(h.evaluate('state.messages'), messages);
    assert.equal(h.evaluate('isPlaying'), false);
    assert.equal(h.timer.pending.size, 0);
    assert.equal(h.app.innerHTML, originalApp);
  }
});

test('N4は3つの空欄と18択のウィンドウで入力し、3文字を選ぶと送信できる', async () => {
  const h = appHarness();
  h.click('select', 'N4');
  assert.equal((h.app.innerHTML.match(/data-action="symbol-slot"/g) ?? []).length, 3);
  assert.equal(h.symbolSubmit.disabled, true);
  assert.ok(!h.app.innerHTML.includes('type="text"'));
  h.click('symbol-slot', '0');
  assert.equal(h.panel.classList.contains('symbol-choice-dialog'), true);
  assert.equal((h.panel.innerHTML.match(/data-action="choose-symbol"/g) ?? []).length, 18);
  for (const value of [...'0123456789', '←', '→', '↑', '↓', '↖', '↗', '↙', '↘']) assert.ok(h.panel.innerHTML.includes(`data-id="${value}"`));
  h.click('choose-symbol', '8');
  assert.equal(h.evaluate('activeSymbolSlot'), 1);
  assert.equal(h.symbolSubmit.disabled, true);
  assert.equal(h.symbolSlots[0].textContent, '8');
  h.click('choose-symbol', '9');
  assert.equal(h.evaluate('activeSymbolSlot'), 2);
  h.click('choose-symbol', '↙');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.panel.open, false);
  assert.equal(h.answerField.value, '89↙');
  assert.equal(h.symbolSubmit.disabled, false);
  assert.equal(h.symbolSlots[2].textContent, '↙');
  assert.equal(h.evaluate('answer(document.querySelector("#answer").value).status'), 'correct');
  assert.equal(h.evaluate('state.selected'), 'N4.1');
});

test('N4の空欄は重複選択・選び直しができ、開き直したり資料を切り替えても保持する', async () => {
  const h = appHarness();
  h.click('select', 'N4');
  h.click('symbol-slot', '0');
  h.click('choose-symbol', '8');
  h.click('close');
  await Promise.resolve();
  await Promise.resolve();
  h.evaluate("enterPlay({ code: '000000', state, view: capturePlayView() })");
  assert.equal(h.evaluate('selectedSymbols.join("")'), '8');
  h.click('puzzle-page', '2');
  assert.equal(h.evaluate('selectedSymbols.join("")'), '8');
  h.click('symbol-slot', '1');
  h.click('choose-symbol', '8');
  h.click('choose-symbol', '←');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.answerField.value, '88←');
  h.click('symbol-slot', '1');
  h.click('choose-symbol', '9');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.answerField.value, '89←');
  assert.equal(h.evaluate('puzzleImageIndex'), 2);
  h.click('symbol-slot', '2');
  h.click('choose-symbol', '↙');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.answerField.value, '89↙');
  assert.equal(h.evaluate('selectedSymbols.length'), 3);
});

test('N4の配信画像は提供原本と一致する', () => {
  for (const [asset, source] of [['n4-original.jpg', 'Slide8.jpg'], ['n4-poster-original.jpg', 'Slide7.jpg'], ['n4-map.jpg', 'Slide10.jpg']]) {
    assert.ok(readFileSync(new URL(`../dist/assets/${asset}`, import.meta.url)).equals(readFileSync(new URL(`../../Kyusai_materials/${source}`, import.meta.url))), `${asset} が ${source} と一致する`);
  }
});

test('N4・N5・N6の図は原本を埋め込み、空欄と配色を保持する', () => {
  for (const [asset, source] of [['n4-poster.svg', 'Slide7.jpg'], ['n4-diagram.svg', 'Slide8.jpg'], ['n5-diagram.svg', 'Slide12.jpg'], ['n6-diagram.svg', 'Slide62.jpg']]) {
    const svg = readFileSync(new URL(`../dist/assets/${asset}`, import.meta.url), 'utf8');
    const embedded = svg.match(/href="data:image\/jpeg;base64,([^"]+)"/);
    assert.ok(embedded, `${asset}に原本を埋め込む`);
    assert.ok(Buffer.from(embedded[1], 'base64').equals(readFileSync(new URL(`../../Kyusai_materials/${source}`, import.meta.url))));
    assert.ok(!svg.includes('<text'), `${asset}の空欄に文字を追加しない`);
  }
});

test('N4の資料はSlide7・Slide8・Slide10の順で、番号切り替えと拡大でも入力を保つ', () => {
  const h = appHarness();
  h.click('select', 'N4');
  const p = scenario.problems.find(p => p.id === 'N4');
  assert.deepEqual(p.images.map(image => image.src), ['../assets/n4-poster.svg', '../assets/n4-diagram.svg', '../assets/n4-map.jpg']);
  assert.equal(h.evaluate('puzzleImageIndex'), 0);
  assert.ok(h.app.innerHTML.includes('src="../assets/n4-poster.svg"'));
  assert.equal((h.app.innerHTML.match(/data-action="puzzle-page"/g) ?? []).length, 3);
  h.answerField.value = '8';
  const before = h.app.innerHTML;
  h.click('puzzle-page', '1');
  assert.equal(h.evaluate('puzzleImageIndex'), 1);
  assert.ok(h.visual.innerHTML.includes('src="../assets/n4-diagram.svg"'));
  assert.equal(h.app.innerHTML, before);
  assert.equal(h.answerField.value, '8');
  h.click('puzzle-image');
  assert.equal(h.panel.classList.contains('image-gallery'), true);
  assert.ok(h.panel.innerHTML.includes('src="../assets/n4-diagram.svg"'));
  assert.equal((h.panel.innerHTML.match(/data-action="puzzle-page"/g) ?? []).length, 3);
  let prevented = 0;
  h.documentEvent('keydown', { key: 'ArrowRight', preventDefault() { prevented++; } });
  assert.equal(h.evaluate('puzzleImageIndex'), 2);
  assert.equal(h.fullImage.src, '../assets/n4-map.jpg');
  assert.ok(h.galleryPages.innerHTML.includes('data-index="2" aria-label="資料3を表示" aria-pressed="true"'));
  h.documentEvent('keydown', { key: 'ArrowRight', preventDefault() { prevented++; } });
  assert.equal(h.evaluate('puzzleImageIndex'), 2);
  assert.equal(prevented, 2);
  assert.equal(h.answerField.value, '8');
});

// Image gestures (including gallery swipes) are covered in interaction.test.mjs.

test('N4.1でも選択中の資料を維持し、別の問題を選ぶと資料1に戻る', () => {
  const h = appHarness();
  h.click('select', 'N4');
  h.click('puzzle-page', '1');
  h.evaluate("answer('89↙')");
  assert.equal(h.evaluate('state.selected'), 'N4.1');
  assert.equal(h.evaluate('puzzleImageIndex'), 1);
  assert.ok(h.composer.innerHTML.includes('src="../assets/n4-diagram.svg"'));
  assert.equal(h.timer.pending.size, 0);
  h.click('select', 'N3');
  assert.equal(h.evaluate('puzzleImageIndex'), 0);
  assert.ok(!h.app.innerHTML.includes('data-action="puzzle-page"'));
});

test('解答済みのN4を再回答しても資料を保ち、N4.1を続けて再回答できる', () => {
  const h = appHarness();
  h.click('select', 'N4');
  h.evaluate("answer('89↙')");
  h.evaluate("answer('人間・環境学研究科棟')");
  finishScene(h);
  h.click('select', 'N4');
  h.click('puzzle-page', '2');
  assert.equal(h.evaluate("answer('89↙').status"), 'correct');
  assert.equal(h.evaluate('repeatAnswer'), true);
  assert.equal(h.evaluate('puzzleImageIndex'), 2);
  assert.equal(h.evaluate("answer('人間・環境学研究科棟').status"), 'correct');
  assert.equal(h.evaluate('isPlaying'), true);
  finishScene(h);
  assert.equal(h.evaluate('state.solved.filter(id => id.startsWith("N4")).length'), 2);
});

test('N4.1からN5へ進み、お化け屋敷で正解すると会話とページをめくる指示を表示する', () => {
  const h = appHarness();
  h.evaluate("selectProblem('N4.1')");
  h.evaluate("answer('人間・環境学研究科棟')");
  finishScene(h);
  h.click('open-composer');
  assert.equal(h.evaluate('state.selected'), 'N5');
  assert.ok(h.composer.innerHTML.includes('<select id="answer"'));
  assert.equal(h.evaluate("answer('お化け屋敷').status"), 'correct');
  assert.ok(h.app.innerHTML.includes('そういえば、この問題文、ついに『最期の場所』になりましたね。'));
  finishScene(h);
  assert.equal(h.evaluate('displayedMessages.length'), 8);
  assert.ok(h.evaluate('historyScreenMarkup()').includes('（……そういえば、この子、さっきお腹鳴らしてたな…）'));
  assert.ok(h.app.innerHTML.includes('以上で、構内での周遊、滞在が必須な部分は終了となります。'));
  assert.ok(h.app.innerHTML.includes('<p class="page-turn-text">案内を確認したら、冊子のページをめくろう。指示があれば上部の「次へ」ボタンを押してください。</p>'));
  assert.match(h.app.innerHTML, /data-action="open-composer"[^>]*>.*?<span>次へ<\/span>/);
  h.click('open-composer');
  assert.equal(h.evaluate('state.selected'), 'N5.5');
});

test('N5.5は会話終了後も留まり、次へを押した場合だけ終了画面に進む', () => {
  const h = appHarness();
  h.click('select', 'N5.5');
  h.evaluate("answer(['謎解き', '家族'])");
  assert.equal(h.evaluate('yoiEndView'), false);
  h.evaluate("answer(['謎解き', '1人'])");
  assert.equal(h.evaluate('yoiEndView'), false);
  assert.ok(!h.app.innerHTML.includes('id="yoi-completion-title"'));
  h.click('yoi-next');
  assert.equal(h.evaluate('yoiEndView'), false);
  assert.ok(!h.app.innerHTML.includes('data-action="yoi-next"'));
  h.click('select', 'N1');
  finishScene(h);
  assert.equal(h.evaluate('yoiEndView'), false);
  h.click('select', 'N5.5');
  h.evaluate("answer(['謎解き', '1人'])");
  finishScene(h);
  assert.equal(h.evaluate('yoiEndView'), false);
  assert.equal(h.panel.open, true);
  assert.ok(h.panel.innerHTML.includes('data-action="yoi-next">宵の最後まで読んだら次へ</button>'));
  assert.ok(h.evaluate('historyScreenMarkup()').includes('ミサメが危ない！！！！！！！'));
  h.click('yoi-next');
  assert.equal(h.evaluate('yoiEndView'), true);
  h.click('start');
  assert.equal(h.evaluate('yoiEndView'), false);
});

test('N5.5の旧記録を読み返すとトークと履歴に改訂後の本文が表示される', t => {
  const saved = engine.submitAnswer(scenario, { ...engine.initialState(scenario), selected: 'N5.5' }, ['謎解き', '1人']).state;
  for (const m of saved.messages) {
    m.text = m.text.replace('子供から貰った', '子供からもらった')
      .replace('1本の線でつながり、恐ろしい仮説', '一本の線でつながり、1つの恐ろしい仮説');
  }
  const h = appHarness(JSON.stringify(saved));
  t.after(() => h.dispose());
  h.click('toggle-menu');
  h.click('history');
  for (const [oldText, newText] of [['子供からもらった', '子供から貰った'], ['一本の線でつながり、1つの恐ろしい仮説', '1本の線でつながり、恐ろしい仮説']]) {
    const line = h.evaluate(`novelBubbleContent(state.messages.find(m => m.text.includes(${JSON.stringify(oldText)})))`);
    assert.ok(line.includes(newText));
    assert.ok(h.workspace.innerHTML.includes(newText));
    assert.ok(!h.workspace.innerHTML.includes(oldText));
  }
});

test('N5からN5.5のテキストと2選択欄へ進み、完答でSTOPポップアップから宵終了画面へ進む', async () => {
  const h = appHarness();
  h.evaluate("selectProblem('N5')");
  h.evaluate("answer('お化け屋敷')");
  finishScene(h);
  h.click('open-composer');
  assert.equal(h.evaluate('state.selected'), 'N5.5');
  assert.ok(h.navigation.innerHTML.includes('N5.5'));
  assert.ok(!h.navigation.innerHTML.includes('data-id="N6"'));
  assert.ok(h.composer.innerHTML.includes('空欄①と空欄②に当てはまる語句は？'));
  assert.ok(h.composer.innerHTML.includes('行方不明者は、2人とも【①】をしていた。'));
  assert.ok(h.composer.innerHTML.includes('彼らはNFに【②】で来ていた。'));
  assert.ok(h.composer.innerHTML.includes('スタンプラリー、会社員、学生、女性、男性、京大ツアー、家族、演奏、謎解き、1人、責任者、初参加、カップル'));
  assert.ok(!h.composer.innerHTML.includes('n6-diagram.svg'));
  assert.equal((h.composer.innerHTML.match(/<select /g) ?? []).length, 2);
  assert.ok(h.composer.innerHTML.includes('data-fields-layout="row"'));
  assert.ok(h.composer.innerHTML.includes('class="send-button" aria-label="答えを送信"'));
  assert.ok(!h.composer.innerHTML.includes('<span>送信</span>'));
  const before = h.evaluate('JSON.stringify(state)');
  assert.equal(h.evaluate("answer(['謎解き', '家族']).status"), 'incorrect');
  assert.equal(h.evaluate('JSON.stringify(state)'), before);
  assert.equal(h.evaluate('displayedMessages.every(m => m.problemId === "N5")'), true);
  assert.equal(h.evaluate("answer(['謎解き', '1人']).status"), 'correct');
  finishScene(h);
  assert.equal(h.evaluate('displayedMessages.length'), 8);
  assert.equal(h.evaluate('displayedMessages.every(m => m.problemId === "N5.5")'), true);
  assert.ok(h.evaluate('historyScreenMarkup()').includes('ミサメが危ない！！！！！！！'));
  assert.ok(!h.app.innerHTML.includes('class="page-turn-text"'));
  assert.ok(h.app.innerHTML.includes('ミサメが危ない！！！！！！！'));
  assert.ok(h.panel.innerHTML.includes('>冊子の次のページをめくろう</p>'));
  assert.equal(h.evaluate('yoiEndView'), false);
  assert.equal(h.panel.open, true);
  assert.ok(h.panel.innerHTML.includes('data-action="yoi-next">宵の最後まで読んだら次へ</button>'));
  assert.ok(!h.app.innerHTML.includes('id="yoi-completion-title"'));
  const waiting = appHarness(h.snapshot());
  assert.equal(waiting.evaluate('yoiEndView'), false);
  assert.equal(waiting.panel.open, true);
  assert.equal(waiting.panel.dataset.kind, 'yoi-page-turn');
  await h.evaluate('closePanel()');
  assert.equal(h.panel.open, false);
  h.click('yoi-page-turn');
  assert.equal(h.panel.open, true);
  h.click('yoi-next');
  assert.equal(h.evaluate('yoiEndView'), true);
  assert.ok(h.app.innerHTML.includes('id="yoi-completion-title"'));
  assert.ok(h.navigation.innerHTML.includes('宵 終幕'));
  assert.ok(!h.navigation.innerHTML.includes('宵 終了'));
  assert.ok(!h.app.innerHTML.includes('class="answer-fab"'));
  assert.equal(h.composer.hidden, true);
  assert.ok(h.app.innerHTML.includes('data-action="play-mei"><span>11月の救祭 冥 をプレイする</span></button>'));
  assert.ok(h.app.innerHTML.includes('data-action="tour-thanks"><span>周遊版をご購入の方はこちら</span></button>'));
  assert.ok(h.app.innerHTML.includes('遊んでいただきありがとうございました。'));
  assert.ok(h.app.innerHTML.includes('冊子後半、「11月の救祭 冥」は会場でもご自宅でもお好きな場所、<br>お好きな時間にプレイすることが可能です。'));
  assert.ok(!h.app.innerHTML.includes('class="yoi-completion-note"'));
  assert.ok(!h.app.innerHTML.includes('周遊版をご購入の方はここで終了'));
  h.click('tour-thanks');
  assert.equal(h.panel.open, true);
  assert.equal(h.panel.dataset.kind, 'tour-thanks');
  assert.ok(h.panel.innerHTML.includes('周遊版をプレイしてくださり、ありがとうございました。'));
  assert.ok(h.panel.innerHTML.includes('book-mei.webp'));
  assert.ok(h.panel.innerHTML.includes('付属図書館前で販売中'));
  assert.ok(h.panel.innerHTML.includes('アンケートはこちら'));
  await h.evaluate('closePanel()');
  assert.equal(h.panel.open, false);
  const saved = JSON.parse(h.snapshot());
  h.click('play-mei');
  assert.ok(h.app.innerHTML.includes('data-action="continue-at-venue"><span>会場でプレイする</span></button>'));
  assert.ok(h.app.innerHTML.includes('data-action="continue-online"><span>オンラインでプレイする</span></button>'));
  assert.ok(!h.app.innerHTML.includes('data-action="play-mei"'));
  assert.ok(h.app.innerHTML.includes('data-action="tour-thanks"'));
  h.click('continue-at-venue');
  assert.equal(h.evaluate('yoiEndView'), false);
  assert.equal(h.evaluate('state.selected'), 'Q1');
  assert.equal(h.composer.hidden, true);
  assert.ok(h.app.innerHTML.includes('id="venue-guide-heading"'));
  assert.ok(h.app.innerHTML.indexOf('id="venue-guide-heading"') < h.app.innerHTML.indexOf('id="deduction-guide-heading"'));
  assert.equal(h.evaluate('displayedMessages.length'), 0);
  assert.ok(!h.app.innerHTML.includes('ミサメが危ない！！！！！！！'));
  h.click('open-composer');
  assert.equal(h.composer.hidden, false);
  assert.ok(h.app.innerHTML.includes('<h2>Q1</h2>'));
  assert.equal(h.evaluate('displayedMessages.length'), 0);
  h.click('select', 'Q1');
  assert.equal(h.evaluate('displayedMessages.length'), 0);
  assert.ok(!h.app.innerHTML.includes('ミサメが危ない！！！！！！！'));
  assert.deepEqual(JSON.parse(h.snapshot()).solved, saved.solved);
  assert.deepEqual(JSON.parse(h.snapshot()).messages, saved.messages);
  assert.equal(h.evaluate("answer(['1']).status"), 'incorrect');
  assert.equal(h.evaluate('state.solved.includes("Q1")'), false);
  h.click('yoi-end');
  assert.equal(h.evaluate('yoiEndView'), true);
  h.click('confirm-reset');
  assert.equal(h.evaluate('yoiEndView'), false);
  assert.equal(h.evaluate('startView'), true);
  assert.equal(JSON.parse(h.snapshot()).solved.length, 0);
});

test('宵から会場で解く場合は解答済みでもQ1を再表示し、正解してからQ1.1へ進む', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.click('select', 'N5.5');
  h.evaluate("answer(['謎解き', '1人'])");
  finishScene(h);
  h.click('yoi-next');
  h.click('continue-at-venue');
  h.click('travel-next');
  assert.equal(h.composer.hidden, true);
  assert.equal(h.panel.open, true);
  assert.ok(h.panel.innerHTML.includes('冊子で問題<strong class="page-turn-target">Q1</strong>を見つけましたか？'));
  assert.ok(h.panel.innerHTML.includes('data-action="travel-found">問題を確認した</button>'));
  h.click('travel-found');
  h.evaluate("answer(['5'])");
  const saved = JSON.parse(h.snapshot());
  h.click('yoi-end');
  h.click('continue-at-venue');
  assert.equal(h.evaluate('state.selected'), 'Q1');
  assert.equal(h.evaluate('repeatAnswer'), true);
  assert.equal(h.composer.hidden, true);
  h.click('travel-next');
  h.click('travel-found');
  assert.equal(h.composer.hidden, false);
  assert.ok(h.composer.innerHTML.includes('<h2>Q1</h2>'));
  assert.ok(!h.app.innerHTML.includes('<h2>Q1.1</h2>'));
  assert.deepEqual(JSON.parse(h.snapshot()).solved, saved.solved);
  assert.deepEqual(JSON.parse(h.snapshot()).messages, saved.messages);
  h.click('select', 'Q1');
  assert.equal(h.evaluate('state.selected'), 'Q1');
  assert.equal(h.evaluate("answer(['4']).status"), 'incorrect');
  assert.equal(h.evaluate('state.selected'), 'Q1');
  assert.equal(h.evaluate("answer(['5']).status"), 'correct');
  assert.equal(h.evaluate('state.selected'), 'Q1.1');
});

test('Q1正解後はQ1.1の問題パネルにフォーカスし、人物の選択欄を自動で開かない', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.click('select', 'Q1');
  const fieldFocusCount = h.answerField.focusCount;
  const composerFocusCount = h.composer.focusCount;
  h.evaluate("answer(['5'])");
  assert.equal(h.evaluate('state.selected'), 'Q1.1');
  assert.equal(h.composer.hidden, false);
  assert.ok(h.composer.innerHTML.includes('人物を選択…'));
  assert.equal(h.answerField.focusCount, fieldFocusCount);
  assert.equal(h.composer.focusCount, composerFocusCount + 1);
  assert.equal(h.panel.open, false);
});

test('Q1正解後は文字を出さず短い間とフェードで小問を表示し、動作中の重複送信を防ぐ', async t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.click('select', 'Q1');
  const motions = [];
  h.composer.animate = (frames, options) => {
    let finish;
    const motion = { frames, options, finished: new Promise(resolve => { finish = resolve; }), finish() { finish(); }, cancel() { this.cancelled = true; finish(); } };
    motions.push(motion);
    return motion;
  };
  h.composer.insertAdjacentHTML = () => assert.fail('正解通知の要素を挿入しない');
  assert.equal(h.evaluate("answer(['5']).status"), 'correct');
  assert.equal(h.evaluate('state.selected'), 'Q1.1');
  assert.equal(h.composer.hidden, false);
  assert.equal(h.panel.open, false);
  assert.ok(!h.composer.innerHTML.includes('正解'));
  assert.equal(h.composer.inert, true);
  const reveal = motions.find(motion => motion.options.duration === 600);
  assert.ok(reveal);
  assert.equal(reveal.frames[1].opacity, 0);
  assert.equal(reveal.frames[1].offset, .4);
  assert.equal(reveal.frames.at(-1).opacity, 1);
  assert.equal(h.evaluate("answer('マヤ').status"), 'busy');
  assert.equal(h.evaluate('state.solved.includes("Q1.1")'), false);
  reveal.finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.composer.inert, false);
  assert.equal(h.evaluate('questionAdvanceAnimation'), null);
  assert.equal(h.evaluate("answer('マヤ').status"), 'correct');
});

test('動きを減らす設定では小問切り替えの待ち時間を省き、Q1.1の選択肢を閉じて表示する', t => {
  const h = appHarness(null, true);
  t.after(() => h.dispose());
  h.click('select', 'Q1');
  h.composer.animate = () => assert.fail('動きを減らす設定ではアニメーションしない');
  h.evaluate("answer(['5'])");
  assert.equal(h.evaluate('state.selected'), 'Q1.1');
  assert.equal(h.composer.hidden, false);
  assert.equal(h.panel.open, false);
});

test('Q1は番号の接頭辞がない時刻6候補のプルダウンで、正解の値と小問への進行を維持する', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.click('select', 'Q1');
  assert.ok(h.app.innerHTML.includes('<select id="answer" name="answer" required>'));
  assert.ok(h.app.innerHTML.includes('時刻を選択…'));
  assert.ok(!h.app.innerHTML.includes('type="radio"'));
  const q1 = scenario.problems.find(p => p.id === 'Q1');
  for (const option of q1.options) {
    assert.ok(h.app.innerHTML.includes(`<option value="${option.id}">${option.label}</option>`));
    assert.equal(engine.checkAnswer(q1, [option.id]), option.id === '5');
  }
  assert.equal(h.evaluate("answer(['5']).status"), 'correct');
  assert.equal(h.evaluate('state.selected'), 'Q1.1');
  assert.ok(h.composer.innerHTML.includes('人物を選択…'));
});

test('N5の周遊終了案内は指定の一文だけ赤字にし、保存済みの古い案内にも反映する', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  const notice = scenario.problems.find(p => p.id === 'N5').dialogue.find(line => line.warningText);
  const expected = '<strong class="message-warning">実際にお化け屋敷に向かう必要はありません。</strong>';
  const current = h.evaluate(`messageMarkup(${JSON.stringify({ ...notice, kind: 'dialogue', problemId: 'N5' })})`);
  assert.ok(current.includes('class="instruction-card instruction-card-notice" aria-label="ご案内"'));
  assert.ok(current.includes(expected));
  assert.equal((current.match(/class="message-warning"/g) ?? []).length, 1);
  assert.ok(current.includes('終了となります。' + expected + 'これ以降は、'));
  const legacy = { ...notice, kind: 'dialogue', problemId: 'N5', warningText: undefined, text: notice.text.replace(notice.warningText, '') };
  assert.equal(h.evaluate(`messageMarkup(${JSON.stringify(legacy)})`), current);
});

test('オンラインを選ぶと推理パートの説明から始まり、STOPで確認してQ1を開く', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  assert.ok(!h.app.innerHTML.includes('chapter-mei'));
  h.click('select', 'N5.5');
  h.evaluate("answer(['謎解き', '1人'])");
  finishScene(h);
  assert.equal(h.evaluate('yoiEndView'), false);
  h.click('yoi-next');
  assert.equal(h.evaluate('yoiEndView'), true);
  assert.ok(!h.app.innerHTML.includes('chapter-mei'));
  h.click('continue-online');
  assert.ok(h.app.innerHTML.includes('class="workspace chapter-mei"'));
  assert.equal(h.evaluate('displayedMessages.length'), 0);
  assert.equal(h.composer.hidden, true);
  assert.ok(!h.app.innerHTML.includes('id="venue-guide-heading"'));
  h.click('travel-next');
  assert.equal(h.composer.hidden, true);
  assert.equal(h.panel.open, true);
  assert.ok(h.panel.innerHTML.includes('冊子で問題<strong class="page-turn-target">Q1</strong>を見つけましたか？'));
  assert.ok(h.panel.innerHTML.includes('data-action="travel-found">問題を確認した</button>'));
  h.click('travel-found');
  assert.equal(h.composer.hidden, false);
  assert.ok(h.composer.innerHTML.includes('<h2>Q1</h2>'));
  assert.ok(h.app.innerHTML.includes('<h1 id="deduction-guide-heading">推理パートの進め方</h1>'));
  h.evaluate("answer(['5'])");
  assert.equal(h.evaluate('state.selected'), 'Q1.1');
  assert.equal(h.evaluate('displayedMessages.length'), 0);
  h.click('select', 'Q1.1');
  assert.equal(h.evaluate('displayedMessages.length'), 0);
  h.click('select', 'Q8');
  assert.ok(h.app.innerHTML.includes('class="workspace chapter-mei"'));
  assert.ok(!h.app.innerHTML.includes('id="deduction-guide-heading"'));
  h.click('yoi-end');
  assert.ok(!h.app.innerHTML.includes('chapter-mei'));
});

test('Q1の17:20～17:40で推理パートの案内とスクロール位置を保ってQ1.1へ切り替える', () => {
  const h = appHarness();
  h.click('select', 'Q1');
  assert.ok(h.app.innerHTML.includes('現時点では、犯行時刻はいつ頃だと考えられるだろうか？'));
  assert.equal((h.app.innerHTML.match(/<option value="[1-6]">/g) ?? []).length, 6);
  const before = h.evaluate('JSON.stringify(state.messages)');
  const conversation = h.evaluate('JSON.stringify(displayedMessages)');
  const markup = h.app.innerHTML;
  h.chat.scrollTop = 123;
  assert.equal(h.evaluate("answer(['4']).status"), 'incorrect');
  assert.equal(h.evaluate('state.selected'), 'Q1');
  assert.equal(h.composer.hidden, false);
  assert.equal(h.evaluate("answer(['5']).status"), 'correct');
  assert.equal(h.evaluate('state.selected'), 'Q1.1');
  assert.equal(h.evaluate('isPlaying'), false);
  assert.equal(h.timer.pending.size, 0);
  assert.equal(h.composer.hidden, false);
  assert.ok(h.composer.innerHTML.includes('<h2>Q1.1</h2>'));
  assert.ok(h.composer.innerHTML.includes('その時間、犯行が可能だった人物は誰か？'));
  assert.ok(h.composer.innerHTML.includes('人物を選択…'));
  assert.equal(h.evaluate('displayedMessages.length'), 0);
  assert.equal(h.evaluate('JSON.stringify(state.messages)'), before);
  assert.equal(h.evaluate('JSON.stringify(displayedMessages)'), conversation);
  assert.equal(h.app.innerHTML, markup);
  assert.equal(h.chat.scrollTop, 123);
  assert.equal(h.evaluate("answer('マナ').status"), 'incorrect');
  assert.equal(h.evaluate('state.solved.includes("Q1.1")'), false);
  assert.equal(h.evaluate("answer('マヤ').status"), 'correct');
  finishScene(h);
  assert.equal(h.evaluate('state.solved.includes("Q1.1")'), true);
  assert.ok(!h.app.innerHTML.includes('id="deduction-guide-heading"'));
  assert.equal(h.evaluate('displayedMessages.length'), 5);
  h.click('select', 'Q1');
  h.evaluate("answer(['5'])");
  assert.equal(h.evaluate('state.selected'), 'Q1.1');
  assert.equal(h.composer.hidden, false);
  h.click('select', 'Q1.1');
  assert.equal(h.evaluate('displayedMessages.length'), 0);
});

test('Q1.1の人物プルダウンは指定順の4候補で、マヤのみ正解となる', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.click('select', 'Q1.1');
  const problem = scenario.problems.find(p => p.id === 'Q1.1');
  assert.deepEqual(problem.answerChoices, ['マヤ', 'ハナ', 'サダヲ', 'アツヤ']);
  assert.ok(h.app.innerHTML.includes('<select id="answer" name="answer" required>'));
  assert.ok(h.app.innerHTML.includes('人物を選択…'));
  for (const person of problem.answerChoices) assert.equal(engine.checkAnswer(problem, person), person === 'マヤ');
});

test('Q1.1の会話終了後にQ2へ進み、ある・布・ドライアイスで小問を切り替えて真相を表示する', async () => {
  const h = appHarness();
  h.click('select', 'Q1.1');
  h.evaluate("answer('マヤ')");
  assert.equal(h.evaluate('isPlaying'), true);
  assert.equal(h.composer.hidden, true);
  assert.ok(!h.app.innerHTML.includes('class="answer-fab"'));
  finishScene(h);
  assert.equal(h.evaluate('displayedMessages.length'), 5);
  assert.ok(h.evaluate('historyScreenMarkup()').includes('17:30～17:40の間と考えられる'));
  assert.ok(h.evaluate('historyScreenMarkup()').includes('出口の方から入ったりもしてないわよ！'));
  assert.ok(h.evaluate('historyScreenMarkup()').includes('（確かに…。時間的には可能でも物理的にはマヤには不可能だ。'));
  assert.ok(!h.app.innerHTML.includes('class="page-turn-text"'));
  // 会話の終わりは暗転した場面の中央に案内だけを出し、ポップアップはタップで開く。
  assert.equal(h.panel.open, false);
  assert.ok(h.app.innerHTML.includes('class="page-turn-scene" data-action="travel-next"'));
  assert.ok(h.app.innerHTML.includes('scene-dim'));
  assert.ok(h.app.innerHTML.includes('class="page-turn-scene-text">冊子の次のページをめくろう<span class="page-turn-scene-cue"'));
  h.click('travel-next');
  assert.equal(h.panel.open, true);
  assert.ok(h.panel.innerHTML.includes('>冊子で問題<strong class="page-turn-target">Q2</strong>を見つけましたか？</p>'));
  assert.ok(h.app.innerHTML.includes('<span>次へ</span>'));
  assert.equal(h.panel.dataset.kind, 'travel-next');
  assert.ok(h.panel.innerHTML.includes('data-action="travel-found">問題を確認した</button>'));
  assert.equal(h.evaluate('state.selected'), 'Q1.1');
  assert.equal(h.composer.hidden, true);
  h.click('travel-found');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.evaluate('state.selected'), 'Q2');
  assert.equal(h.composer.hidden, false);
  assert.equal(h.evaluate('displayedMessages.length'), 5);
  assert.ok(h.composer.innerHTML.includes('犯行時刻を偽装する方法はあるだろうか？'));
  assert.equal((h.composer.innerHTML.match(/type="radio"/g) ?? []).length, 2);
  const before = h.evaluate('JSON.stringify(state.messages)');
  const markup = h.app.innerHTML;
  h.chat.scrollTop = 91;
  assert.equal(h.evaluate("answer(['2']).status"), 'incorrect');
  assert.equal(h.evaluate('state.selected'), 'Q2');
  h.evaluate("answer(['1'])");
  assert.equal(h.evaluate('state.selected'), 'Q2.1');
  assert.ok(h.composer.innerHTML.includes('鏡に【①】がかかっていた'));
  assert.ok(h.composer.innerHTML.includes('漢字一文字で入力…'));
  assert.equal(h.timer.pending.size, 0);
  assert.equal(h.evaluate("answer('霧').status"), 'incorrect');
  h.evaluate("answer('布')");
  assert.equal(h.evaluate('state.selected'), 'Q2.2');
  assert.ok(h.composer.innerHTML.includes('濡らしたもう片側に【①】を引っ付けて'));
  assert.ok(h.composer.innerHTML.includes('時間経過で布がハンマーの方向に引きずられ落ちるようにした。'));
  assert.equal(h.evaluate('JSON.stringify(state.messages)'), before);
  assert.equal(h.app.innerHTML, markup);
  assert.equal(h.chat.scrollTop, 91);
  assert.equal(h.evaluate('displayedMessages.length'), 5);
  assert.equal(h.composer.hidden, false);
  assert.equal(h.evaluate("answer('氷').status"), 'incorrect');
  assert.equal(h.evaluate("answer('ドライアイス').status"), 'correct');
  assert.equal(h.composer.hidden, true);
  finishScene(h);
  assert.equal(h.evaluate('displayedMessages.length'), 2);
  assert.ok(h.evaluate('historyScreenMarkup()').includes('「ドライアイスが昇華することで、時間差で布が落ちる……。それによって鏡に光が反射するようになり、ミサメさんの姿が現れたってことですか……！」'));
  assert.ok(h.evaluate('historyScreenMarkup()').includes('「そうだ！　犯人はなんて巧妙なトリックを仕掛けたんだ……！」'));
  assert.ok(!h.app.innerHTML.includes('class="page-turn-text"'));
  assert.equal(h.panel.open, false);
  h.click('travel-next');
  assert.equal(h.panel.open, true);
  assert.ok(h.panel.innerHTML.includes('>冊子で問題<strong class="page-turn-target">Q3</strong>を見つけましたか？</p>'));
  h.click('select', 'Q2.1');
  assert.equal(h.evaluate('displayedMessages.every(m => m.problemId === "Q1.1")'), true);
});

test('既存のQ2.2解答済み記録でも会話の後にページ送り指示を表示する', t => {
  const solved = engine.submitAnswer(scenario, { ...engine.initialState(scenario), selected: 'Q2.2' }, 'ドライアイス').state;
  const h = appHarness(JSON.stringify(solved));
  t.after(() => h.dispose());
  h.evaluate("selectProblem('Q2.2')");
  assert.ok(h.evaluate('historyScreenMarkup()').includes('「ドライアイスが昇華することで、時間差で布が落ちる……。それによって鏡に光が反射するようになり、ミサメさんの姿が現れたってことですか……！」'));
  assert.ok(!h.app.innerHTML.includes('class="page-turn-text"'));
  assert.equal(h.panel.open, false);
  assert.ok(h.app.innerHTML.includes('class="page-turn-scene" data-action="travel-next"'));
  assert.equal(h.evaluate('isPlaying'), false);
  h.click('travel-next');
  assert.equal(h.panel.open, true);
  assert.ok(h.panel.innerHTML.includes('>冊子で問題<strong class="page-turn-target">Q3</strong>を見つけましたか？</p>'));
});

test('Q2.2から3つの問いの一覧へ進み、自由に開いて同じ位置へ戻れる', async () => {
  const h = appHarness();
  h.click('select', 'Q2.2');
  h.evaluate("answer('ドライアイス')");
  finishScene(h);
  assert.equal(h.panel.open, false);
  h.click('travel-next');
  assert.equal(h.panel.open, true);
  h.click('travel-found');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.evaluate('investigationView'), true);
  assert.equal((h.app.innerHTML.match(/class="investigation-question"/g) ?? []).length, 3);
  assert.ok(h.app.innerHTML.includes('<h1>残された違和感</h1>'));
  assert.ok(h.app.innerHTML.includes('--answered-angle: 0deg'));
  assert.equal((h.app.innerHTML.match(/class="conclusion-seal"/g) ?? []).length, 3);
  for (const p of scenario.problems.filter(p => p.conclusion)) assert.ok(!h.app.innerHTML.includes(p.conclusion));
  assert.ok(!h.app.innerHTML.includes('0 / 3 解答済み'));
  assert.equal((h.app.innerHTML.match(/class="investigation-stamp">未回答</g) ?? []).length, 3);
  assert.ok(!h.app.innerHTML.includes('考える'));
  assert.ok(h.app.innerHTML.includes('犯人はどうやってミサメを吊るした？'));
  assert.ok(h.app.innerHTML.includes('大きな謎が残る部屋はあるか'));
  assert.ok(h.app.innerHTML.includes('上の付箋をタップして'));
  assert.ok(h.app.innerHTML.includes('幽煙の間の北壁に貼られていた紙は今どこに？'));
  assert.ok(h.app.innerHTML.includes('data-action="investigation-next" disabled'));
  assert.equal(h.evaluate("answer(['1']).status"), 'unavailable');
  h.chat.scrollTop = 217;
  h.click('investigation-open', 'Q3.2');
  assert.equal(h.evaluate('state.selected'), 'Q3.2');
  assert.equal(h.evaluate('displayedMessages.length'), 0);
  h.click('investigation-back');
  assert.equal(h.chat.scrollTop, 217);
  h.click('investigation-open', 'Q3');
  assert.ok(h.app.innerHTML.includes('answer-options-two-columns'));
  assert.ok(h.app.innerHTML.includes('--answer-option-columns: 2'));
  for (const [id, text] of [['2', '梁には単純なロープの痕跡しかなかった。'], ['3', '梁までの高さは4mもある。']]) {
    assert.equal(h.evaluate(`answer(['${id}']).status`), 'incorrect');
    assert.equal(h.evaluate('isPlaying'), false);
    assert.ok(!h.app.innerHTML.includes('data-action="novel-next"'));
    assert.ok(h.app.innerHTML.includes('<span>次へ</span>'));
    assert.ok(h.app.innerHTML.includes(text));
    assert.equal(h.evaluate('state.solved.includes("Q3")'), false);
    h.click('open-composer');
    assert.equal(h.evaluate('state.selected'), 'Q3');
    assert.equal(h.composer.hidden, false);
  }
  h.evaluate("answer(['1'])");
  const prompt = '犯人が足場として利用したと考えられる物を答えよ。（漢字2文字）';
  assert.ok(h.app.innerHTML.includes('足場か……。犯人が足場に使えそうなものなんて、何かあったっけ？'));
  assert.equal(h.evaluate('state.selected'), 'Q3.scaffold');
  assert.equal(h.composer.hidden, false);
  assert.ok(h.composer.innerHTML.includes(prompt));
  assert.equal(h.evaluate("answer('梯子').status"), 'incorrect');
  h.click('investigation-back');
  assert.ok(h.app.innerHTML.includes('続きの謎あり'));
  assert.ok(!h.app.innerHTML.includes(scenario.problems.find(p => p.id === 'Q3').conclusion));
  h.click('investigation-open', 'Q3');
  assert.equal(h.evaluate('state.selected'), 'Q3.scaffold');
  h.evaluate("enterPlay({ code: '000000', state, view: capturePlayView() })");
  assert.equal(h.composer.hidden, false);
  assert.equal(h.evaluate("answer('脚立').status"), 'correct');
  finishScene(h);
  const [line] = scenario.problems.find(p => p.id === 'Q3.scaffold').dialogue;
  assert.equal(line.speaker, 'タツ');
  assert.ok(h.app.innerHTML.includes(line.text));
  assert.ok(!h.app.innerHTML.includes('data-action="novel-next"'));
  assert.equal(h.evaluate('historyScreenMarkup()').split(line.text).length - 1, 1);
  h.click('investigation-back');
  assert.ok(h.app.innerHTML.includes('--answered-angle: 120deg'));
  h.click('investigation-open', 'Q3');
  assert.equal(h.evaluate('state.selected'), 'Q3.scaffold');
  assert.equal(h.composer.hidden, true);
});

test('旧〇の問いで保存した記録は、他の正解を保って残された違和感の一覧へ戻る', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.evaluate(`enterPlay({
    code: '000000',
    state: { ...state, scenarioRevision: 3, selected: 'Q3.1', solved: ['Q3.2', 'Q3.1'] },
    view: { composerExpanded: true, answerDrafts: { 'Q3.1': ['2'], 'Q3.3': ['10'] } }
  })`);
  assert.equal(h.evaluate('state.selected'), 'Q3');
  assert.equal(h.evaluate('investigationView'), true);
  assert.ok(h.app.innerHTML.includes('--answered-angle: 120deg'));
  assert.equal(h.evaluate('JSON.stringify(answerDrafts)'), '{"Q3.3":["10"]}');
});

test('Q3の各問とN6を解き、最後の穴埋めに正解したら冊子の確認を経てQ4へ進む', async () => {
  const h = appHarness();
  h.click('select', 'Q3');
  assert.equal(h.evaluate('investigationView'), true);
  h.click('investigation-next');
  assert.notEqual(h.evaluate('state.selected'), 'Q4');
  h.click('investigation-open', 'Q3.3');
  assert.equal(h.evaluate("answer('ミサメの死体').status"), 'incorrect');
  assert.equal(h.evaluate("answer('１０２').status"), 'correct');
  assert.equal(h.composer.hidden, true);
  const paper = scenario.problems.find(p => p.id === 'Q3.3');
  for (const line of paper.dialogue) {
    assert.ok(h.app.innerHTML.includes(`<span class="novel-line">${line.text}</span>`));
    assert.equal(h.composer.hidden, true);
    h.click('novel-next');
  }
  assert.equal(h.evaluate('state.selected'), 'Q3.3.1');
  assert.equal(h.composer.hidden, false);
  assert.ok(!h.app.innerHTML.includes('追加カード404を取得'));
  assert.equal(h.evaluate('unlockedCards(scenario, state).some(c => c.id === "404")'), true);
  h.click('investigation-back');
  assert.ok(h.app.innerHTML.includes('--answered-angle: 120deg'));
  assert.equal((h.app.innerHTML.match(/class="investigation-stamp">回答済み</g) ?? []).length, 1);
  assert.equal((h.app.innerHTML.match(/class="investigation-stamp">未回答</g) ?? []).length, 2);
  assert.ok(h.app.innerHTML.includes('続きの謎あり'));
  assert.ok(!h.app.innerHTML.includes(paper.conclusion));
  h.click('investigation-open', 'Q3.3');
  assert.equal(h.evaluate('state.selected'), 'Q3.3.1');
  assert.ok(h.composer.innerHTML.includes('通過順に並べよ'));
  assert.ok(h.composer.innerHTML.includes('ヒント：赤、黄、青は今見た色'));
  assert.ok(h.composer.innerHTML.includes('<h2>N6</h2>'));
  assert.ok(h.navigation.innerHTML.includes('問題番号 <strong>N6</strong>'));
  assert.ok(h.composer.innerHTML.includes('../assets/n6-diagram.svg'));
  assert.ok(h.composer.innerHTML.includes('aria-label="N6の図を拡大表示"'));
  h.click('puzzle-image');
  assert.ok(h.panel.innerHTML.includes('N6の問題</h2>'));
  assert.ok(h.panel.innerHTML.includes('../assets/n6-diagram.svg'));
  h.click('close');
  assert.equal(h.evaluate("answer('かべおせ').status"), 'correct');
  finishScene(h);
  h.click('investigation-back');
  assert.ok(h.app.innerHTML.includes('--answered-angle: 120deg'));
  h.click('investigation-open', 'Q3.2');
  for (const value of ["['2']", "['1','2']", "['2','3','4']"]) assert.equal(h.evaluate(`answer(${value}).status`), 'incorrect');
  h.evaluate("answer(['3','2'])");
  assert.ok(!h.app.innerHTML.includes('data-action="novel-next"'));
  assert.ok(h.app.innerHTML.includes('class="novel-bubble" type="button" data-action="investigation-closing"'));
  assert.ok(h.app.innerHTML.includes('幽煙の間にも謎は残っている'));
  h.click('investigation-back');
  assert.ok(h.app.innerHTML.includes('--answered-angle: 240deg'));
  assert.ok(!h.app.innerHTML.includes('scene-dim'));
  h.click('investigation-next');
  assert.notEqual(h.evaluate('state.selected'), 'Q4');
  h.click('investigation-open', 'Q3');
  h.evaluate("answer(['1'])");
  assert.equal(h.evaluate("answer('脚立').status"), 'correct');
  finishScene(h);
  h.click('investigation-back');
  assert.ok(h.app.innerHTML.includes('--answered-angle: 360deg'));
  // 3つの？がめくれたら画面を暗くして「次へ」を目立たせる。
  assert.ok(h.app.innerHTML.includes('scene-dim'));
  assert.ok(h.app.innerHTML.includes('scene-dim-late'));
  assert.ok(!h.app.innerHTML.includes('data-action="investigation-next" disabled'));
  const restored = appHarness(h.snapshot());
  restored.click('select', 'Q3');
  assert.equal((restored.app.innerHTML.match(/class="investigation-stamp">回答済み</g) ?? []).length, 3);
  assert.ok(restored.app.innerHTML.includes('--answered-angle: 360deg'));
  assert.ok(restored.app.innerHTML.includes('scene-dim'));
  restored.click('investigation-next');
  assert.equal(restored.evaluate('state.selected'), 'Q3.1');
  assert.equal(restored.composer.hidden, false);
  assert.equal((restored.app.innerHTML.match(/class="investigation-question" data-solved="true"/g) ?? []).length, 3);
  assert.ok(!restored.app.innerHTML.includes('class="composer-area answer-page'));
  assert.ok(!restored.app.innerHTML.includes('value="隠し部屋"'));
  restored.click('investigation-back');
  assert.equal(restored.evaluate('investigationView'), true);
  restored.click('investigation-next');
  assert.equal((restored.app.innerHTML.match(/data-action="symbol-slot"/g) ?? []).length, 5);
  restored.click('symbol-slot', '4');
  assert.equal((restored.panel.innerHTML.match(/data-action="choose-symbol"/g) ?? []).length, 12);
  assert.ok(restored.panel.innerHTML.includes('1字消す'));
  restored.click('close');
  await new Promise(resolve => setImmediate(resolve));
  restored.evaluate("enterPlay({ code: '000000', state, view: capturePlayView() })");
  assert.equal(restored.evaluate('state.selected'), 'Q3.1');
  assert.equal(restored.evaluate("answer(['幽煙の間', '蝋人形の間', 'かくしべや']).status"), 'incorrect');
  assert.equal(restored.panel.open, false);
  assert.equal(restored.evaluate("answer(['蝋人形の間', '幽煙の間', 'かくしべや']).status"), 'correct');
  finishScene(restored);
  assert.equal(restored.evaluate('state.selected'), 'Q3.1');
  assert.equal(restored.panel.open, false);
  assert.ok(restored.app.innerHTML.includes('class="page-turn-scene" data-action="travel-next"'));
  restored.click('travel-next');
  assert.equal(restored.panel.open, true);
  assert.equal(restored.panel.dataset.kind, 'travel-next');
  assert.match(restored.panel.innerHTML, /STOP<\/span><p[^>]*>冊子で問題<strong[^>]*>Q4<\/strong>を見つけましたか？<\/p>/);
  assert.match(restored.panel.innerHTML, /data-action="travel-found">問題を確認した<\/button>/);
  restored.click('close');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(restored.panel.open, false);
  assert.equal(restored.evaluate('state.selected'), 'Q3.1');
  assert.ok(restored.app.innerHTML.includes('class="page-turn-scene"'));
  restored.click('travel-next');
  assert.equal(restored.panel.open, true);
  restored.evaluate("enterPlay({ code: '000000', state, view: capturePlayView() })");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(restored.panel.open, false);
  restored.click('travel-next');
  assert.equal(restored.panel.open, true);
  restored.click('travel-found');
  assert.equal(restored.evaluate('state.selected'), 'Q4');
  assert.equal(restored.composer.hidden, false);
  assert.ok(restored.app.innerHTML.includes('<h2>Q4</h2>'));
  assert.equal(restored.evaluate('displayedMessages.length'), 0);
  restored.click('select', 'Q4');
  assert.equal(restored.evaluate('displayedMessages.length'), 0);
  restored.evaluate(`enterPlay({ code: '000000', state, view: { ...capturePlayView(), displayedMessages:
    scenario.problems.find(p => p.id === 'Q3.3.1').dialogue.map(line => ({ ...line, kind: 'dialogue', problemId: 'Q3.3.1' })) } })`);
  assert.equal(restored.evaluate('displayedMessages.length'), 0);
  assert.equal(restored.composer.hidden, false);
  assert.ok(restored.app.innerHTML.includes('<h2>Q4</h2>'));
  assert.equal(restored.evaluate("answer(['マヤ', '002']).status"), 'correct');
});

test('Q3の各記号は最後の会話の後に暗転し、最後に解いた記号だけ締めの文を変える', t => {
  const entries = scenario.investigation.entries;
  for (const last of entries) {
    const h = appHarness();
    t.after(() => h.dispose());
    h.click('select', 'Q3');
    for (const id of [...entries.filter(id => id !== last), last]) {
      h.click('investigation-open', id);
      if (id === 'Q3') {
        h.evaluate("answer(['1'])");
        assert.ok(!h.app.innerHTML.includes('data-action="investigation-closing"'));
        h.evaluate("answer('脚立')");
      } else if (id === 'Q3.3') {
        h.evaluate("answer('102')");
        finishScene(h);
        assert.ok(!h.app.innerHTML.includes('data-action="investigation-closing"'));
        assert.equal(h.composer.hidden, false);
        h.evaluate("answer('かべおせ')");
      } else h.evaluate("answer(['2','3'])");
      finishScene(h);
      assert.match(h.app.innerHTML, /<button class="novel-bubble"[^>]*data-action="investigation-closing"[^>]*>[^]*?class="novel-next"><span aria-hidden="true">▷<\/span>/);
      assert.equal((h.app.innerHTML.match(/data-action="investigation-closing"/g) ?? []).length, 1);
      assert.ok(!h.app.innerHTML.includes('class="investigation-return"'));
      assert.ok(!h.app.innerHTML.includes('class="investigation-closing"'));
      h.click('investigation-closing');
      const expected = `${scenario.investigation.closing.byEntry[id]}${scenario.investigation.closing[id === last ? 'last' : 'more']}`;
      assert.ok(h.app.innerHTML.includes(`class="investigation-closing-text">${expected}</span>`));
      h.evaluate("enterPlay({ code: '000000', state, view: capturePlayView() })");
      assert.ok(h.app.innerHTML.includes(`class="investigation-closing-text">${expected}</span>`));
      h.click('investigation-back');
      assert.equal(h.evaluate('investigationView'), true);
      assert.ok(!h.app.innerHTML.includes('class="investigation-closing"'));
      const conclusion = scenario.problems.find(p => p.id === id).conclusion;
      assert.ok(h.app.innerHTML.includes(conclusion));
      assert.equal((h.app.innerHTML.match(/class="conclusion-seal is-peeling"/g) ?? []).length, 1);
      h.evaluate("enterPlay({ code: '000000', state, view: capturePlayView() })");
      h.click('select', 'Q3');
      assert.ok(h.app.innerHTML.includes(conclusion));
      assert.ok(!h.app.innerHTML.includes('is-peeling'));
    }
  }
});

test('〇の旧本文で途中保存した会話は、改訂後の地の文から一度ずつ読み進められる', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.click('select', 'Q3');
  h.click('investigation-open', 'Q3.3');
  h.evaluate("answer('102')");
  h.click('novel-next');
  h.evaluate(`{
    const oldLine = line => line.previousText ? { ...line, text: line.previousText } : line;
    const view = capturePlayView();
    enterPlay({ code: '000000', state: { ...state, messages: [...state.messages.map(oldLine),
      { problemId: 'Q3.3', kind: 'dialogue', speaker: '', text: '追加カード404を取得しN6に回答してください' }] },
      view: { ...view, displayedMessages: displayedMessages.map(oldLine), displayedCount: undefined } });
  }`);
  const paper = scenario.problems.find(p => p.id === 'Q3.3');
  assert.ok(h.app.innerHTML.includes(paper.dialogue[1].text));
  h.click('novel-next');
  assert.ok(h.app.innerHTML.includes(paper.dialogue[2].text));
  h.evaluate("enterPlay({ code: '000000', state, view: capturePlayView() })");
  assert.equal(h.evaluate('isPlaying'), true);
  assert.ok(h.app.innerHTML.includes(paper.dialogue[2].text));
  h.click('novel-next');
  assert.equal(h.evaluate('state.selected'), 'Q3.3.1');
  assert.equal(h.composer.hidden, false);
  assert.equal(h.evaluate('isPlaying'), false);
  const history = h.evaluate('historyScreenMarkup()');
  assert.ok(!history.includes('追加カード404を取得'));
  for (const line of paper.dialogue.slice(1)) {
    assert.ok(history.includes(line.text));
    assert.ok(!history.includes(line.previousText));
  }
});

test('問題の途中で戻ると再生を止め、他の未回答問題の答えを背景に出さない', () => {
  const h = appHarness();
  h.click('select', 'Q3');
  h.click('investigation-open', 'Q3.3');
  h.evaluate("answer('102')");
  assert.equal(h.evaluate('isPlaying'), true);
  h.click('investigation-back');
  assert.equal(h.timer.pending.size, 0);
  h.click('investigation-open', 'Q3.2');
  assert.equal(h.evaluate('displayedMessages.length'), 0);
  assert.ok(!h.app.innerHTML.includes('ピッタリと一枚の「N6」の紙になった。'));
  h.click('investigation-back');
  assert.equal(h.evaluate('investigationView'), true);
});

test('ヘッダー下の問題番号トグルを開閉でき、任意の問題を選んで回答できる', () => {
  const h = appHarness();
  assert.ok(h.app.innerHTML.indexOf('id="problem-navigation"') > h.app.innerHTML.indexOf('<header'));
  assert.ok(h.app.innerHTML.indexOf('id="problem-navigation"') < h.app.innerHTML.indexOf('</header>'));
  assert.ok(h.app.innerHTML.includes('問題番号 <strong>スタート</strong>'));
  h.click('toggle-problems');
  assert.equal(h.evaluate('problemMenuExpanded'), true);
  assert.ok(h.navigation.innerHTML.includes('aria-expanded="true"'));
  assert.equal((h.navigation.innerHTML.match(/data-action="select"/g) ?? []).length, scenario.problems.filter(p => !scenario.investigation.problemIds.includes(p.id) || p.id === 'Q3').length);
  h.click('toggle-problems');
  assert.equal(h.evaluate('problemMenuExpanded'), false);
  h.click('toggle-problems');
  h.click('select', 'N5.5');
  assert.equal(h.evaluate('state.selected'), 'N5.5');
  assert.equal(h.evaluate('problemMenuExpanded'), false);
  assert.equal(h.evaluate('composerExpanded'), true);
  assert.ok(h.app.innerHTML.includes('問題番号 <strong>N5.5</strong>'));
  assert.ok(!h.navigation.innerHTML.includes('data-id="N6"'));
  assert.equal(h.evaluate("answer('1人').status"), 'empty');
});

test('問題メニューはN4.1まで余白なし、N5以降は現在の問題を上端に揃える', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  const menu = h.problemMenu;
  menu.clientHeight = 300;
  menu.scrollTop = 0;
  menu.getBoundingClientRect = () => ({ top: 100 });
  let depth = 0;
  const active = { getBoundingClientRect: () => ({ height: 44,
    top: 100 + menu.clientHeight - 44 - depth * 44 - menu.scrollTop,
  }) };
  menu.querySelector = selector => selector === '[aria-current="step"]' ? active : null;
  for (const [id, position] of [['start', 0], ['N1', 1], ['N4.1', 5], ['N5', 6], ['N1', 1]]) {
    h.click(id === 'start' ? 'start' : 'select', id);
    depth = position;
    menu.scrollTop = -777;
    h.click('toggle-problems');
    if (position < 6) {
      assert.equal(menu.scrollTop, 0);
      assert.equal(active.getBoundingClientRect().top, 100 + 300 - 44 - position * 44);
    } else {
      assert.equal(active.getBoundingClientRect().top, menu.getBoundingClientRect().top);
      assert.equal(menu.scrollTop, menu.clientHeight - (position + 1) * 44);
    }
    assert.equal(h.chat.scrollTop, 0);
    h.click('toggle-problems');
  }
});

test('Q3の小問は問題一覧のQ3を現在位置として示す', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.evaluate("openInvestigationProblem('Q3.3')");
  assert.ok(h.navigation.innerHTML.includes('data-id="Q3"  aria-current="step"'));
  assert.equal((h.navigation.innerHTML.match(/aria-current="step"/g) ?? []).length, 1);
});

test('問題番号メニューは閉じる動きが終わるまで残り、連打しても古い完了処理で閉じない', async () => {
  const h = appHarness();
  const motions = [];
  h.problemMenu.animate = (frames, options) => {
    let finish;
    const finished = new Promise(resolve => { finish = resolve; });
    const motion = { frames, options, finish, finished, cancel() {} };
    motions.push(motion);
    return motion;
  };
  h.click('toggle-problems');
  assert.equal(motions[0].frames[0].transform, 'scale(.92)');
  assert.equal(h.problemMenu.hidden, false);
  h.click('toggle-problems');
  assert.equal(h.problemMenu.inert, true);
  assert.equal(h.problemMenu.hidden, false);
  h.click('toggle-problems');
  motions[0].finish(); motions[1].finish(); motions[2].finish();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.problemMenu.hidden, false);
  assert.equal(h.problemMenu.inert, false);
  assert.equal(h.evaluate('problemMenuExpanded'), true);
  h.click('toggle-problems');
  motions[3].finish();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.problemMenu.hidden, true);
  assert.equal(h.problemMenu.inert, true);
});

test('資料画像は読み込み後に進む方向へ動き、途中の切り替えの古い動きを取り除く', () => {
  const h = appHarness();
  const loads = new Set();
  const motions = [];
  const image = {
    complete: false, naturalWidth: 0, isConnected: true,
    addEventListener(name, listener) { assert.equal(name, 'load'); loads.add(listener); },
    removeEventListener(name, listener) { loads.delete(listener); },
    animate(frames) { motions.push(frames); return { finished: Promise.resolve(), cancel() {} }; },
  };
  h.visual.querySelector = () => image;
  h.click('select', 'N4');
  h.click('puzzle-page', '1');
  assert.equal(motions.length, 0);
  h.click('puzzle-page', '2');
  assert.equal(loads.size, 1);
  image.complete = true; image.naturalWidth = 559;
  for (const listener of loads) listener();
  assert.equal(motions.length, 1);
  assert.equal(motions[0][0].transform, 'translateX(12px)');
  h.click('puzzle-page', '0');
  assert.equal(motions[1][0].transform, 'translateX(-12px)');
  assert.equal(h.evaluate('puzzleImageIndex'), 0);
});

test('動きを減らす設定ではメニューと小問の操作を待たせず、追加の動きも出さない', async () => {
  const h = appHarness(null, true);
  h.problemMenu.animate = h.composer.animate = () => { throw new Error('追加アニメーションを実行しない'); };
  h.click('toggle-problems');
  h.click('toggle-problems');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.problemMenu.hidden, true);
  h.click('select', 'N4');
  h.evaluate("answer('89↙')");
  assert.equal(h.evaluate('state.selected'), 'N4.1');
  assert.equal(h.composer.hidden, false);
});

test('ヒントを左右に読み返しても既読数を保ち、最後のページでだけ解説を開ける', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  const hints = scenario.problems[0].hints;
  const arrow = () => ({ addEventListener(_, click) { this.click = click; }, focus() {} });
  const prev = arrow(), next = arrow();
  const track = { children: hints.map((_, i) => ({ inert: i !== 0 })), style: {} };
  const answer = { hidden: true, open: false };
  const status = {};
  const reader = {
    querySelector(selector) { return ({ '.hint-prev': prev, '.hint-next': next, '.hint-track': track, '.hint-answer': answer, '[role="status"]': status })[selector]; },
    closest() { return null; },
  };
  h.panel.querySelector = selector => selector === '.hint-reader' ? reader : null;
  h.click('hints');
  assert.match(h.panel.innerHTML, /class="answer-reveal hint-answer" hidden/);
  assert.equal(h.evaluate('state.hints.N1'), 1);
  for (let i = 1; i < hints.length; i++) {
    next.click();
    assert.equal(track.style.transform, `translateX(-${i * 100}%)`);
    assert.deepEqual(track.children.map(card => !card.inert), hints.map((_, j) => i === j));
    assert.equal(answer.hidden, i < hints.length - 1);
  }
  assert.equal(next.disabled, true);
  answer.open = true;
  prev.click();
  assert.equal(answer.open, false);
  assert.equal(answer.hidden, true);
  assert.equal(h.evaluate('state.hints.N1'), hints.length);
  h.click('hints');
  assert.ok(h.panel.innerHTML.includes(`translateX(-${(hints.length - 1) * 100}%)`));
  assert.doesNotMatch(h.panel.innerHTML, /hint-answer" hidden/);
});

test('ヒントがない問題は解説を直接開け、解説のない問題にはボタンを出さない', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  const empty = h.evaluate('hintReaderMarkup(scenario.problems.find(p => !p.hints.length && p.explanation))');
  assert.match(empty, /解答を見る/);
  assert.doesNotMatch(empty, /hint-answer" hidden|hint-pager/);
  const noAnswer = h.evaluate('hintReaderMarkup(scenario.problems.find(p => p.hints.length && !p.explanation))');
  assert.doesNotMatch(noAnswer, /解答を見る/);
});

test('手がかりの合成タブで組み合わせ結果だけを表示演出し、スクロール位置と発見記録を維持する', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.click('select', 'Q1');
  h.click('clues');
  h.documentEvent('click', { target: { closest: selector => selector === '[data-action]' ? { dataset: { action: 'clue-tab', tab: 'combine' } } : null } });
  h.panel.scrollTop = 142;
  const motions = [];
  const finding = { animate(frames) { motions.push(frames); return { finished: Promise.resolve(), cancel() {} }; } };
  h.panel.querySelector = selector => selector === '[data-finding-id="months"]' ? finding : null;
  h.evaluate(`globalThis.FormData = class { getAll() { return ['A1', 'B1']; } };`);
  const event = { target: { id: 'combine-form' }, preventDefault() {} };
  h.documentEvent('submit', event);
  assert.equal(h.panel.scrollTop, 142);
  assert.equal(motions.length, 1);
  assert.ok(h.panel.innerHTML.includes('data-finding-id="months"'));
  h.documentEvent('submit', event);
  assert.deepEqual(JSON.parse(h.snapshot()).combinations, ['months']);
});

test('謎一覧に戻る演出は元の閲覧位置を保ち、動きを減らす設定では省略する', t => {
  for (const reduced of [false, true]) {
    const h = appHarness(null, reduced);
    t.after(() => h.dispose());
    const motions = [];
    h.chat.animate = (frames, options) => { motions.push({ frames, options }); return { finished: Promise.resolve(), cancel() {} }; };
    h.evaluate(`{ const originalQuery = document.querySelector;
      document.querySelector = selector => ['.investigation-intro', '.investigation-next'].includes(selector)
        ? originalQuery('.chat-area') : originalQuery(selector);
      const originalQueryAll = document.querySelectorAll;
      document.querySelectorAll = selector => selector === '.investigation-question'
        ? Array(4).fill(originalQuery('.chat-area')) : originalQueryAll(selector);
      investigationScrollTop = 87;
      showInvestigation();
    }`);
    assert.equal(h.chat.scrollTop, 87);
    assert.equal(motions.length, reduced ? 0 : 6);
    if (!reduced) assert.deepEqual(motions.slice(1, 5).map(motion => motion.options.delay), [0, 35, 70, 105]);
    assert.equal(h.evaluate('investigationView'), true);
  }
});

test('再生中の問題選択は古い再生を止め、N1は空の背景で再回答できる', () => {
  const h = appHarness();
  h.evaluate("answer(['10'])");
  h.click('select', 'N5');
  assert.equal(h.timer.pending.size, 0);
  assert.equal(h.evaluate('isPlaying'), false);
  h.evaluate("answer('お化け屋敷')");
  finishScene(h);
  h.click('select', 'N1');
  assert.equal(h.evaluate('displayedMessages.length'), 0);
  assert.equal(h.composer.hidden, false);
  assert.ok(!h.app.innerHTML.includes('そういえば、この問題文、ついに『最期の場所』になりましたね。'));
  assert.equal(h.evaluate("answer(['10']).status"), 'correct');
  finishScene(h);
  assert.equal(h.evaluate('displayedMessages.length'), 11);
  assert.equal(h.evaluate('displayedMessages.every(m => m.problemId === "N1")'), true);
});

test('問題番号メニューのスタートは初期画面に戻り、回答ボタンでN1の回答欄を開く', async () => {
  const h = appHarness();
  h.click('select', 'N5');
  h.click('toggle-problems');
  assert.ok(h.navigation.innerHTML.indexOf('data-action="start"') < h.navigation.innerHTML.indexOf('data-id="N1"'));
  assert.ok(h.navigation.innerHTML.includes('スタート'));
  h.click('start');
  assert.equal(h.evaluate('state.selected'), 'N1');
  assert.equal(h.evaluate('composerExpanded'), false);
  assert.ok(h.app.innerHTML.includes('class="answer-fab"'));
  h.click('open-composer');
  assert.ok(h.panel.innerHTML.includes('「次へ」ボタンについて'));
  h.click('start-answer-confirm');
  await Promise.resolve();
  assert.equal(h.evaluate('composerExpanded'), true);
  assert.equal(h.evaluate('problemMenuExpanded'), false);
  assert.ok(h.app.innerHTML.includes('data-action="answer-choices"'));
  assert.equal(h.evaluate("answer(['10']).status"), 'correct');
  assert.ok(h.app.innerHTML.includes('国旗の色に関する問題ですね。'));
});

test('スタートを開くと解答済みでもチャット欄の会話と次への操作を表示しない', () => {
  const h = appHarness();
  h.evaluate("answer(['10'])");
  finishScene(h);
  h.click('start');
  assert.equal(h.evaluate('displayedMessages.length'), 0);
  assert.ok(!h.app.innerHTML.includes('国旗の色に関する問題ですね。'));
  assert.ok(!h.app.innerHTML.includes('data-action="next"'));
  assert.ok(!h.app.innerHTML.includes('data-action="replay"'));
  assert.ok(h.app.innerHTML.includes('問題番号 <strong>スタート</strong>'));
  assert.ok(h.app.innerHTML.includes('data-action="start" aria-current="step"'));
  assert.ok(!h.app.innerHTML.includes('data-id="N1" aria-current="step"'));
  h.click('select', 'N1');
  assert.equal(h.evaluate('displayedMessages.length'), 0);
  assert.equal(h.composer.hidden, false);
  assert.ok(h.app.innerHTML.includes('問題番号 <strong>N1</strong>'));
});

test('未解答のN2を選ぶとN1正解後の会話を背景に回答欄を開き、進行は追加しない', () => {
  const h = appHarness();
  const before = h.evaluate('JSON.stringify({ solved: state.solved, messages: state.messages })');
  h.click('select', 'N2');
  assert.equal(h.evaluate('state.selected'), 'N2');
  assert.equal(h.evaluate('startView'), false);
  assert.equal(h.composer.hidden, false);
  assert.ok(h.app.innerHTML.includes('場所を選択…'));
  assert.ok(h.app.innerHTML.includes(scenario.problems.find(p => p.id === 'N1').travelGuide.steps[0].directions));
  assert.ok(!h.app.innerHTML.includes('うん、線が交差するところは、法経済学部北館だね'));
  assert.equal(h.evaluate('displayedMessages.length'), 11);
  assert.equal(h.evaluate('displayedMessages.every(m => m.problemId === "N1" && m.kind === "dialogue")'), true);
  assert.equal(h.timer.pending.size, 0);
  assert.equal(h.evaluate('JSON.stringify({ solved: state.solved, messages: state.messages })'), before);
  assert.equal(h.evaluate("answer('法経済学部北館').status"), 'correct');
  finishScene(h);
  assert.equal(h.evaluate('displayedMessages.every(m => m.problemId === "N2")'), true);
});

test('解答済みのN2もN1の会話と回答欄へ戻り、不正解と正解の再回答で記録を保つ', () => {
  const h = appHarness();
  h.evaluate("answer(['10'])");
  finishScene(h);
  h.click('select', 'N2');
  h.evaluate("answer('法経済学部北館')");
  finishScene(h);
  h.click('select', 'N2');
  assert.equal(h.composer.hidden, false);
  assert.equal(h.evaluate('repeatAnswer'), true);
  assert.equal(h.evaluate('displayedMessages.every(m => m.problemId === "N1")'), true);
  assert.equal(h.evaluate("answer('不正解').status"), 'incorrect');
  finishScene(h);
  assert.equal(h.evaluate('state.solved.includes("N2")'), true);
  h.click('select', 'N2');
  assert.ok(!h.app.innerHTML.includes('その答えではないようです'));
  assert.equal(h.evaluate("answer('法経済学部北館').status"), 'correct');
  finishScene(h);
  assert.equal(h.evaluate('displayedMessages.every(m => m.problemId === "N2")'), true);
  assert.equal(h.evaluate('state.solved.filter(id => id === "N2").length'), 1);
});

test('番号選択では会話のない小問も直前の会話を背景に回答欄を開く', () => {
  const h = appHarness();
  for (const [id, previousId] of [['N3', 'N2'], ['N4', 'N3'], ['N4.1', 'N3'], ['N5', 'N4.1'], ['N5.5', 'N5'], ['Q2', 'Q1.1'], ['Q2.1', 'Q1.1'], ['Q2.2', 'Q1.1']]) {
    h.click('select', id);
    assert.equal(h.evaluate('state.selected'), id);
    assert.equal(h.composer.hidden, false);
    assert.ok(h.evaluate('displayedMessages.length') > 0);
    assert.equal(h.evaluate(`displayedMessages.every(m => m.problemId === '${previousId}')`), true);
  }
});

test('ハンバーガーメニューはボタン下の縦リストを開閉する', async () => {
  const h = appHarness();
  const animations = [];
  h.menu.animate = (frames, options) => {
    animations.push({ frames, options });
    return { finished: Promise.resolve(), cancel() {} };
  };
  assert.ok(h.app.innerHTML.includes('<nav id="navigation-menu" class="menu-items"'));
  assert.ok(!h.app.innerHTML.includes('class="side-menu"'));
  h.click('toggle-menu');
  assert.equal(h.evaluate('menuExpanded'), true);
  assert.equal(h.menu.hidden, false);
  assert.equal(h.menu.inert, false);
  assert.equal(animations[0].frames[0].transform, 'scale(.92)');
  await Promise.resolve();
  h.click('toggle-menu');
  assert.equal(h.evaluate('menuExpanded'), false);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.menu.hidden, true);
  assert.equal(h.menu.inert, true);
});

test('メニューはEscと外側クリックで閉じる', async () => {
  const h = appHarness();
  h.click('toggle-menu');
  h.documentEvent('keydown', { key: 'Escape' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.menu.hidden, true);
  h.click('toggle-menu');
  h.click('outside');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.menu.hidden, true);
});

test('解答済みでもスタートには回答ボタンがあり、N1を再回答できる', async () => {
  const h = appHarness();
  h.evaluate("answer(['10'])");
  finishScene(h);
  h.click('start');
  assert.ok(h.app.innerHTML.includes('class="answer-fab"'));
  assert.equal(h.evaluate('displayedMessages.length'), 0);
  h.click('open-composer');
  assert.ok(h.panel.innerHTML.includes('「次へ」ボタンについて'));
  h.click('start-answer-confirm');
  await Promise.resolve();
  assert.equal(h.composer.hidden, false);
  assert.ok(h.app.innerHTML.includes('答えを選択'));
  assert.equal(h.evaluate("answer(['1']).status"), 'incorrect');
  assert.equal(h.evaluate('state.solved.includes("N1")'), true);
  finishScene(h);
  h.click('start');
  assert.equal(h.evaluate("answer(['10']).status"), 'correct');
  finishScene(h);
  assert.equal(h.evaluate('displayedMessages.length'), 11);
  assert.equal(h.evaluate('state.solved.filter(id => id === "N1").length'), 1);
});

test('N1は共通のコンパクト配置で問い・行き先・図・独立した回答欄を表示する', async () => {
  const h = appHarness();
  const chatMarkup = h.app.innerHTML.match(/<section class="chat-area[^"]*"[\s\S]*?<\/section>/)[0];
  assert.ok(!chatMarkup.includes('start-puzzle-card'));
  assert.equal(h.evaluate('composerExpanded'), false);
  h.click('open-composer');
  assert.ok(h.panel.innerHTML.includes('「次へ」ボタンについて'));
  h.click('start-answer-confirm');
  await Promise.resolve();
  assert.equal(h.composer.hidden, false);
  assert.ok(!h.app.innerHTML.includes('タップして拡大'));
  assert.ok(h.app.innerHTML.includes('class="puzzle-card-answer"'));
  assert.ok(h.app.innerHTML.includes('class="start-puzzle-card"'));
  const preview = h.app.innerHTML.indexOf('class="puzzle-preview"');
  const copy = h.app.innerHTML.indexOf('class="puzzle-card-copy"');
  assert.ok(copy < preview);
  const visual = h.app.innerHTML.indexOf('class="puzzle-visual"');
  const visualTitle = h.app.innerHTML.indexOf('はどこにいる？');
  const answer = h.app.innerHTML.indexOf('class="puzzle-card-answer"');
  const response = h.app.innerHTML.indexOf('class="puzzle-card-response"');
  assert.ok(h.app.innerHTML.includes('data-answer-layout="compact"'));
  assert.ok(copy < visualTitle && visualTitle < visual && visual < preview && preview < response && response < answer);
  assert.ok(h.app.innerHTML.includes('はどこにいる？'));
  assert.ok(h.app.innerHTML.includes('総合研究'));
  assert.ok(h.app.innerHTML.includes('A1. 総合研究'));
  assert.equal((h.app.innerHTML.match(/class="puzzle-blank"/g) ?? []).length, 2);
  assert.ok(h.app.innerHTML.includes('../assets/n1-buddha.svg'));
  assert.ok(h.app.innerHTML.includes('../assets/n1-diagram.svg'));
  assert.ok(!h.app.innerHTML.includes('../assets/n1-original.jpg'));
  h.click('puzzle-image');
  assert.equal(h.panel.open, true);
  assert.ok(h.panel.innerHTML.includes('class="puzzle-full-image"'));
  assert.ok(h.panel.innerHTML.includes('../assets/n1-diagram.svg'));
  h.evaluate("selectProblem('N2')");
  assert.ok(h.app.innerHTML.includes('aria-label="N2の問題カード"'));
  assert.ok(h.app.innerHTML.includes('data-answer-layout="compact"'));
  assert.ok(h.app.innerHTML.includes('data-has-destination="false"'));
  assert.ok(!h.app.innerHTML.includes('../assets/n1-original.jpg'));
});

test('N2・N3・N5は共通配置で画像の左に回答欄を置き、その図だけを拡大する', async () => {
  const h = appHarness();
  for (const [id, filename, answer] of [['N2', 'Slide3.jpg', '法経済学部北館'], ['N3', 'Slide5.jpg', '末'], ['N5', 'Slide12.jpg', 'お化け屋敷']]) {
    const p = scenario.problems.find(p => p.id === id);
    const original = `../assets/${id.toLowerCase()}-original.jpg`;
    assert.ok(readFileSync(new URL(`../dist/app/${original}`, import.meta.url)).equals(readFileSync(new URL(`../../Kyusai_materials/${filename}`, import.meta.url))), `${id}の元画像が${filename}と一致する`);
    h.click('select', id);
    assert.equal(h.composer.hidden, false);
    assert.ok(h.app.innerHTML.includes(`aria-label="${id}の問題カード"`));
    assert.ok(h.app.innerHTML.includes(`src="${p.diagram}"`));
    assert.ok(!h.app.innerHTML.includes(`src="${original}"`));
    assert.ok(h.app.innerHTML.includes(`aria-label="${id}の図を拡大表示"`));
    assert.ok(h.app.innerHTML.includes('class="puzzle-text-answer"'));
    assert.equal((h.app.innerHTML.match(/id="answer-form"/g) ?? []).length, 1);
    assert.ok(h.app.innerHTML.includes(id === 'N3' ? 'type="text"' : '<select id="answer"'));
    assert.ok(!h.app.innerHTML.includes('data-action="answer-choices"'));
    assert.ok(!h.app.innerHTML.includes('../assets/n1-original.jpg'));
    const copy = h.app.innerHTML.indexOf('class="puzzle-card-copy"');
    const form = h.app.innerHTML.indexOf('id="answer-form"');
    const visual = h.app.innerHTML.indexOf('class="puzzle-visual"');
    const response = h.app.innerHTML.indexOf('class="puzzle-card-response"');
    assert.ok(copy < visual && visual < response && response < form);
    assert.ok(h.app.innerHTML.includes(`data-has-destination="${id === 'N3'}"`));
    const formMarkup = h.app.innerHTML.slice(form, h.app.innerHTML.indexOf('</form>', form));
    assert.ok(formMarkup.includes('class="answer-control-row"'));
    assert.ok(formMarkup.includes('aria-label="答えを送信"'));
    assert.ok(!formMarkup.includes('<span>送信</span>'));
    assert.ok(!formMarkup.includes('<path d="m6 9 6 6 6-6"'));
    assert.equal((h.app.innerHTML.match(/class="puzzle-blank"/g) ?? []).length, id === 'N3' ? 3 : 0);
    h.click('puzzle-image');
    assert.equal(h.panel.open, true);
    assert.equal(h.panel.classList.contains('image-viewer'), true);
    assert.ok(h.panel.innerHTML.includes(`${id}の問題</h2>`));
    assert.ok(h.panel.innerHTML.includes(`src="${p.diagram}"`));
    assert.ok(h.panel.innerHTML.includes(p.diagramAlt));
    h.click('close');
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(h.panel.open, false);
    assert.equal(h.evaluate(`answer('${answer}').status`), 'correct');
    finishScene(h);
  }
});

test('N1・N2の図は修正版の原稿画像を直接使い、記号の位置や文字の改行を保つ', () => {
  for (const [id, filename] of [['N1', 'Slide1.jpg'], ['N2', 'Slide3.jpg']]) {
    const p = scenario.problems.find(item => item.id === id);
    const svg = readFileSync(new URL(`../dist/app/${p.diagram}`, import.meta.url), 'utf8');
    const embedded = svg.match(/href="data:image\/jpeg;base64,([^"]+)"/);
    assert.ok(embedded, `${id}に原稿画像が埋め込まれている`);
    assert.ok(Buffer.from(embedded[1], 'base64').equals(readFileSync(new URL(`../../Kyusai_materials/${filename}`, import.meta.url))), `${id}の表示画像が${filename}と一致する`);
    assert.ok(svg.includes('width="559" height="793"'));
  }
});

test('問題画像は全画面用ビューアーで開き、閉じた後のヒントは通常のパネルに戻る', async () => {
  const h = appHarness();
  h.click('puzzle-image');
  assert.equal(h.panel.open, true);
  assert.equal(h.panel.classList.contains('image-viewer'), true);
  assert.ok(h.panel.innerHTML.includes('class="image-viewer-stage"'));
  assert.ok(h.panel.innerHTML.includes('aria-label="問題画像を閉じる"'));
  assert.ok(!h.panel.innerHTML.includes('class="panel-header"'));
  h.click('close');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.panel.open, false);
  h.click('hints');
  assert.equal(h.panel.classList.contains('image-viewer'), false);
  assert.ok(h.panel.innerHTML.includes('class="panel-header"'));
});

test('全26問の送信はアイコン1つで、Q2とQ3の選択問題は選択肢の右に配置する', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  for (const problem of scenario.problems) {
    const markup = h.evaluate(`composerContentMarkup(scenario.problems.find(p => p.id === ${JSON.stringify(problem.id)}))`);
    assert.equal((markup.match(/class="answer-entry-label">回答欄<\/div>/g) ?? []).length, 1, problem.id);
    assert.ok(!/<h[1-6][^>]*>A[0-9](?:\.[0-9])?[.：:]?/.test(markup), problem.id);
    assert.ok(!/A[0-9]の/.test(markup), problem.id);
    const form = markup.slice(markup.indexOf('<form'), markup.indexOf('</form>'));
    assert.equal((form.match(/type="submit"/g) ?? []).length, 1, problem.id);
    assert.ok(form.includes('aria-label="答えを送信"'), problem.id);
    assert.ok(!form.includes('<span>送信</span>'), problem.id);
    if (problem.answerSubmitLayout === 'beside-options') {
      assert.ok(['Q2', 'Q3', 'Q3.2'].includes(problem.id), problem.id);
      assert.ok(form.includes('data-submit-layout="beside-options"'), problem.id);
      assert.ok(form.includes(`class="answer-options${problem.optionColumns === 2 ? ' answer-options-two-columns' : ''}"`), problem.id);
      assert.ok(form.indexOf('<button type="submit"') < form.indexOf('</fieldset>'), problem.id);
      assert.ok(!form.includes('answer-control-row'), problem.id);
    }
    assert.ok(!form.includes('<path d="m6 9 6 6 6-6"'), problem.id);
    if (problem.image) {
      assert.ok(markup.includes('data-answer-layout="compact"'), problem.id);
      assert.ok(markup.includes(`data-has-destination="${Boolean(problem.cardDestination)}"`), problem.id);
      if (problem.id === 'N4') {
        assert.ok(form.includes('class="answer-control-row"'));
        assert.ok(!form.includes('answer-control-stack'));
      }
    }
  }
});

test('Q3一覧と問題番号の記号を残し、問題文の記号を外してQ3.2の2つを強調する', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.evaluate('showInvestigation()');
  const listMarkup = h.evaluate('investigationMarkup()');
  assert.equal((listMarkup.match(/class="question-symbol"/g) ?? []).length, 3);
  for (const [id, symbol] of [['Q3', '△'], ['Q3.2', '□'], ['Q3.3', '〇']]) {
    assert.equal(scenario.problems.find(p => p.id === id).listSymbol, symbol);
    assert.ok(h.app.innerHTML.includes(`role="img" aria-label="${symbol}"`));
  }
  h.evaluate("openInvestigationProblem('Q3.2')");
  assert.ok(h.app.innerHTML.includes('以下の選択肢から<strong>2つ</strong>選べ。'));
  assert.ok(h.app.innerHTML.includes('<h2>Q3 □</h2>'));
  assert.ok(h.app.innerHTML.includes('問題番号 <strong>Q3 □</strong>'));
  assert.ok(!h.app.innerHTML.includes('class="question-symbol"'));
  assert.equal(h.evaluate("answer(['2', '3']).status"), 'correct');
});

test('N1の選択メニューは丸なしの1〜10を同じ書体で並べ、選択した番号を反映する', async () => {
  const h = appHarness();
  h.click('open-composer');
  h.click('answer-choices');
  assert.equal(h.panel.classList.contains('answer-choice-dialog'), true);
  assert.equal((h.panel.innerHTML.match(/data-action="choose-answer"/g) ?? []).length, 10);
  assert.equal((h.panel.innerHTML.match(/class="answer-number"/g) ?? []).length, 10);
  for (let value = 1; value <= 10; value++) assert.ok(h.panel.innerHTML.includes(`>${value}</span>`));
  assert.ok(!/[①-⑩]/.test(h.panel.innerHTML));
  h.click('choose-answer', '10');
  assert.equal(h.answerField.value, '10');
  assert.ok(h.choiceLabel.innerHTML.includes('class="answer-number"'));
  assert.ok(h.choiceLabel.innerHTML.includes('>10</span>'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.panel.open, false);
  h.click('answer-choices');
  assert.ok(h.panel.innerHTML.includes('data-id="10" aria-pressed="true"'));
  h.click('close');
  await Promise.resolve();
  await Promise.resolve();
  h.evaluate("answer(['10'])");
  assert.ok(h.app.innerHTML.includes('国旗の色に関する問題ですね。'));
});

test('N1の移動案内で回答を開き履歴を開閉しても、写真とスクロール位置を保ってN2に回答できる', async () => {
  const h = appHarness();
  h.evaluate("answer(['10'])");
  finishScene(h);
  assert.ok(!h.app.innerHTML.includes('次の問題へ'));
  assert.ok(!h.app.innerHTML.includes('もう一度読む'));
  assert.ok(h.app.innerHTML.includes('data-action="travel-next"'));
  assert.ok(h.app.innerHTML.includes('<strong class="instruction-place">総合研究10号館</strong>'));
  assert.ok(h.app.innerHTML.includes('現地で<strong class="instruction-find">N2</strong>と書かれた問題を見つけたら'));
  assert.ok(!h.app.innerHTML.includes('移動案内へ'));
  h.chat.scrollTop = 120;
  const gallery = h.evaluate("document.querySelector('.chat-area .travel-guide-gallery')");
  gallery.scrollLeft = 200;
  const renders = h.renders.length;
  h.click('travel-next');
  assert.equal(h.evaluate('state.selected'), 'N1');
  assert.ok(h.panel.innerHTML.includes('class="page-turn-stop" aria-hidden="true">STOP'));
  assert.ok(h.panel.innerHTML.includes('次の問題を見つけたらページをめくろう'));
  assert.ok(h.panel.innerHTML.includes('>問題を見つけた</button>'));
  h.click('travel-found');
  await Promise.resolve();
  assert.equal(h.evaluate('state.selected'), 'N2');
  assert.equal(h.composer.hidden, false);
  assert.equal(h.chat.scrollTop, 120);
  assert.ok(h.app.innerHTML.includes(scenario.problems.find(p => p.id === 'N1').travelGuide.steps[0].directions));
  assert.ok(h.composer.innerHTML.includes('場所を選択…'));
  assert.equal(h.renders.length, renders);
  assert.equal(gallery.scrollLeft, 200);
  h.chat.scrollTop = 32;
  gallery.scrollLeft = 70;
  h.click('history');
  assert.equal(h.evaluate('historyView'), true);
  h.click('history-back');
  assert.equal(h.evaluate('historyView'), false);
  assert.equal(h.evaluate('state.selected'), 'N2');
  assert.equal(h.composer.hidden, false);
  assert.equal(h.chat.scrollTop, 32);
  assert.equal(gallery.scrollLeft, 70);
  assert.equal(h.renders.length, renders);
  assert.equal(h.evaluate("answer('法経済学部北館').status"), 'correct');
});

test('小問の回答中に戻る操作をすると履歴が開き、閉じても回答画面を維持する', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.click('select', 'N3');
  h.evaluate("answer('末')");
  finishScene(h);
  h.chat.scrollTop = 123;
  h.click('open-composer');
  assert.equal(h.evaluate("answer('89↙').status"), 'correct');
  assert.equal(h.evaluate('state.selected'), 'N4.1');
  h.evaluate("enterPlay({ code: '000000', state, view: capturePlayView() })");
  h.chat.scrollTop = 40;
  h.documentEvent('keydown', { key: 'Escape' });
  assert.equal(h.evaluate('historyView'), true);
  assert.equal(h.evaluate('state.selected'), 'N4.1');
  h.click('history-back');
  assert.equal(h.evaluate('historyView'), false);
  assert.equal(h.composer.hidden, false);
  h.click('open-composer');
  assert.equal(h.evaluate('state.selected'), 'N4.1');
});

test('N2以降のキャラの台詞と地の文は一件ずつタップで進み、履歴には既読分が残る', () => {
  for (const p of scenario.problems.slice(1).filter(p => p.dialogue.some(line => line.speaker))) {
    const h = appHarness();
    h.evaluate(`state.selected = ${JSON.stringify(p.id)}; state.solved.push(state.selected);
      const start = state.messages.length;
      state.messages.push(...current().dialogue.map(line => ({ ...line, kind: 'dialogue', problemId: state.selected })));
      playConversation(start)`);
    for (const line of p.dialogue) {
      if (!h.evaluate('isPlaying')) break;
      assert.equal(h.timer.pending.size, 0);
      assert.ok(h.app.innerHTML.includes(`<span class="novel-line">${line.text}</span>`), p.id);
      assert.equal(h.app.innerHTML.includes('class="novel-stage novel-right"'), line.speaker === 'タツ');
      if (line.speaker) {
        assert.ok(h.app.innerHTML.includes(scenario.portraits[line.speaker]));
        assert.ok(h.app.innerHTML.includes(`<span class="novel-speaker">${line.speaker}</span>`));
      }
      h.click('novel-next');
    }
    assert.equal(h.evaluate('isPlaying'), false);
    assert.equal(h.evaluate('displayedMessages.length'), p.dialogue.length);
    for (const line of p.dialogue.filter(line => line.speaker)) assert.ok(h.evaluate('historyScreenMarkup()').includes(line.text));
    h.dispose();
  }
});

test('未回答でもQ4以降をメニューから自由に開き、回答・再読込しても記録を保つ', () => {
  const ids = ['Q4', 'Q5', 'Q6', 'Q6.1', 'Q6.2', 'Q7', 'Q8', 'Q9'];
  for (const id of ids) {
    const h = appHarness();
    h.click('toggle-problems');
    assert.ok(!h.navigation.innerHTML.includes(`data-id="${id}" disabled`));
    const before = JSON.parse(h.snapshot() ?? JSON.stringify(engine.initialState(scenario)));
    h.click('select', id);
    assert.equal(h.evaluate('state.selected'), id);
    assert.equal(h.evaluate('investigationView'), false);
    assert.equal(h.composer.hidden, false);
    assert.equal(h.problemMenu.hidden, true);
    assert.ok(h.app.innerHTML.includes(`<h2>${id}</h2>`));
    assert.deepEqual(JSON.parse(h.snapshot()).solved, before.solved);
    assert.deepEqual(JSON.parse(h.snapshot()).messages, before.messages);
    const problem = scenario.problems.find(p => p.id === id);
    if (Array.isArray(problem.answerCombos) && problem.answerCombos.length > 1) {
      assert.equal(h.evaluate(`answer(${JSON.stringify(problem.answerCombos[0])}).status`), 'progress');
      assert.equal(h.evaluate(`answer(${JSON.stringify(problem.answerCombos[1])}).status`), 'correct');
    } else {
      const answer = problem.type === 'fields' ? problem.fields.map(f => f.answers[0]) : problem.answers[0];
      assert.equal(h.evaluate(`answer(${JSON.stringify(answer)}).status`), 'correct');
    }
    finishScene(h);
    const restored = appHarness(h.snapshot());
    restored.click('select', id);
    assert.equal(restored.evaluate('state.selected'), id);
    assert.equal(restored.composer.hidden, false);
    assert.deepEqual(JSON.parse(restored.snapshot()).solved, [id]);
  }
});

test('Q6からQ6.2は会話完了を待って進み、犯人とカード番号の両方で最後の推理を表示する', () => {
  const q6 = scenario.problems.find(p => p.id === 'Q6');
  const h = appHarness(JSON.stringify({ ...engine.initialState(scenario), solved: scenario.problems.slice(0, scenario.problems.indexOf(q6)).map(p => p.id) }));
  h.click('select', 'Q6.2');
  assert.equal(h.evaluate('state.selected'), 'Q6.2');
  assert.equal(h.composer.hidden, false);
  h.click('select', 'Q6');
  assert.ok(h.app.innerHTML.includes('凶器は何か？1単語で答えよ'));
  assert.equal(h.evaluate("answer('氷').status"), 'incorrect');
  assert.equal(h.answerForm.classList.contains('is-incorrect'), true);
  assert.equal(h.evaluate("answer('ドライアイス').status"), 'correct');
  h.click('open-composer');
  assert.equal(h.evaluate('state.selected'), 'Q6');
  assert.ok(h.app.innerHTML.includes('自然に昇華するので凶器は現場に残らない'));
  assert.equal(h.evaluate('displayedMessages.length'), 1);
  h.click('novel-next');
  assert.equal(h.panel.open, false);
  assert.equal(h.composer.hidden, false);
  assert.equal(h.evaluate('state.selected'), 'Q6.1');
  assert.ok(h.composer.innerHTML.includes('漢字2文字で答えよ'));
  assert.equal(h.evaluate("answer('軍手').status"), 'correct');
  h.click('open-composer');
  assert.equal(h.evaluate('state.selected'), 'Q6.1');
  assert.ok(h.app.innerHTML.includes('犯人はこの軍手を装着し'));
  assert.equal(h.evaluate('displayedMessages.length'), 1);
  h.click('novel-next');
  assert.equal(h.panel.open, false);
  assert.equal(h.composer.hidden, false);
  assert.equal(h.evaluate('state.selected'), 'Q6.2');
  assert.equal((h.composer.innerHTML.match(/name="answer" type="text"/g) ?? []).length, 1);
  assert.ok(h.composer.innerHTML.includes('<select id="answer" name="answer" required>'));
  assert.deepEqual(scenario.problems.find(p => p.id === 'Q6.2').fields[0].answerChoices, ['マヤ', 'ハナ', 'サダヲ', 'アツヤ']);
  assert.ok(h.composer.innerHTML.includes('inputmode="numeric"'));
  assert.equal(h.evaluate("answer(['ハナ', '002']).status"), 'incorrect');
  assert.equal(h.evaluate("answer(['ハナ', '003']).status"), 'correct');
  assert.ok(!h.app.innerHTML.includes('class="answer-fab"'));
  finishScene(h);
  assert.ok(h.evaluate('historyScreenMarkup()').includes('チューリップの刺繍があった'));
  assert.ok(h.evaluate('historyScreenMarkup()').includes('犯人はハナだ！！！'));
  assert.ok(!h.app.innerHTML.includes('<strong>冊子の次のページをめくろう</strong>'));
  assert.equal(h.panel.open, false);
  h.click('travel-next');
  assert.equal(h.panel.open, true);
  assert.ok(h.panel.innerHTML.includes('冊子で問題<strong class="page-turn-target">Q7</strong>を見つけましたか？'));
  assert.ok(h.app.innerHTML.includes('class="answer-fab"'));
  const restored = appHarness(h.snapshot());
  restored.click('history');
  assert.ok(restored.workspace.innerHTML.includes('犯人はハナだ！！！'));
  assert.ok(restored.workspace.innerHTML.includes('冊子の次のページをめくろう'));
});

test('Q6.2回答済みでもQ6.1の最後の台詞からQ6.2の回答欄を開く', t => {
  const h = appHarness(JSON.stringify({ ...engine.initialState(scenario), solved: ['Q6.1', 'Q6.2'] }));
  t.after(() => h.dispose());
  h.click('select', 'Q6.1');
  assert.equal(h.evaluate("answer('軍手').status"), 'correct');
  assert.equal(h.evaluate('state.selected'), 'Q6.1');
  assert.ok(h.app.innerHTML.includes('犯人はこの軍手を装着し'));
  h.click('novel-next');
  assert.equal(h.panel.open, false);
  assert.equal(h.evaluate('state.selected'), 'Q6.2');
  assert.equal(h.composer.hidden, false);
  assert.ok(h.composer.innerHTML.includes('手がかり番号'));
  assert.equal(h.evaluate("answer(['ハナ', '003']).status"), 'correct');
});

test('Q4は人物4候補のプルダウンと手がかり番号の入力欄を表示する', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.click('select', 'Q4');
  assert.equal(h.composer.hidden, false);
  const people = ['マヤ', 'ハナ', 'サダヲ', 'アツヤ'];
  const problem = scenario.problems.find(p => p.id === 'Q4');
  assert.deepEqual(problem.fields[0].answerChoices, people);
  for (const person of people) {
    assert.ok(h.app.innerHTML.includes(`<option value="${person}">${person}</option>`));
    assert.equal(engine.checkAnswer(problem, [person, '002']), person === 'マヤ');
  }
  assert.ok(h.app.innerHTML.includes('data-fields-layout="row"'));
  assert.ok(h.app.innerHTML.includes('id="answer-1" name="answer" type="text" inputmode="numeric"'));
});

test('Q4の会話後にQ5の時間4択とカード番号欄へ進み、アサヒの会話と最後の指示を表示する', async () => {
  const q4 = scenario.problems.find(p => p.id === 'Q4');
  const saved = { ...engine.initialState(scenario), solved: scenario.problems.slice(0, scenario.problems.indexOf(q4)).map(p => p.id) };
  const h = appHarness(JSON.stringify(saved));
  h.click('select', 'Q5');
  assert.equal(h.evaluate('state.selected'), 'Q5');
  assert.equal(h.composer.hidden, false);
  h.click('select', 'Q4');
  h.evaluate("answer(['マヤ', '002'])");
  h.click('open-composer');
  assert.equal(h.evaluate('state.selected'), 'Q4');
  finishScene(h);
  assert.equal(h.panel.open, false);
  h.click('travel-next');
  assert.equal(h.panel.open, true);
  h.click('travel-found');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.evaluate('state.selected'), 'Q5');
  assert.ok(h.composer.innerHTML.includes('data-fields-layout="row"'));
  assert.ok(h.composer.innerHTML.includes('<select id="answer" name="answer" required>'));
  assert.ok(h.composer.innerHTML.includes('時刻を選択…'));
  assert.equal((h.composer.innerHTML.match(/type="radio"/g) ?? []).length, 0);
  assert.ok(h.composer.innerHTML.includes('手がかり番号'));
  assert.ok(h.composer.innerHTML.includes('3桁の手がかり番号を入力…'));
  assert.ok(h.composer.innerHTML.includes('id="answer-1" name="answer" type="text" inputmode="numeric"'));
  assert.ok(!h.app.innerHTML.includes('幽煙の間：スタッフの証言'));
  assert.equal(h.evaluate("answer(['16:00', '203']).status"), 'incorrect');
  assert.equal(h.answerForm.classList.contains('is-incorrect'), true);
  assert.equal(h.evaluate("answer(['16:30', '203']).status"), 'correct');
  assert.equal(h.composer.hidden, true);
  assert.ok(!h.app.innerHTML.includes('class="answer-fab"'));
  finishScene(h);
  assert.ok(h.evaluate('historyScreenMarkup()').includes(scenario.portraits['アサヒ']));
  assert.ok(h.evaluate('historyScreenMarkup()').includes(scenario.portraits['タツ']));
  assert.ok(h.evaluate('historyScreenMarkup()').includes('鈴の音と一致します'));
  assert.ok(h.evaluate('historyScreenMarkup()').includes('元の順路へ戻ってしまうはずですから'));
  assert.ok(h.evaluate('historyScreenMarkup()').includes('さすがです、先輩'));
  assert.ok(!h.app.innerHTML.includes('class="page-turn-text"'));
  // 会話の終わりは暗転した場面の中央に案内だけを出し、ポップアップはタップで開く。
  assert.equal(h.panel.open, false);
  assert.ok(h.app.innerHTML.includes('class="page-turn-scene" data-action="travel-next"'));
  assert.ok(h.app.innerHTML.includes('scene-dim'));
  h.click('travel-next');
  assert.equal(h.panel.open, true);
  assert.ok(h.panel.innerHTML.includes('>冊子で問題<strong class="page-turn-target">Q6</strong>を見つけましたか？</p>'));
  assert.ok(h.app.innerHTML.includes('class="answer-fab"'));
  h.click('travel-found');
  assert.equal(h.evaluate('state.selected'), 'Q6');
  const restored = appHarness(h.snapshot());
  restored.click('history');
  assert.ok(restored.workspace.innerHTML.includes('ミサメは16時30分頃に入場し'));
});

test('Q6.2とQ7の会話完了時のSTOPからQ7・Q8の回答パネルへ進む', async () => {
  const q62 = scenario.problems.find(p => p.id === 'Q6.2');
  const q7 = scenario.problems.find(p => p.id === 'Q7');
  const h = appHarness(JSON.stringify({ ...engine.initialState(scenario), solved: scenario.problems.slice(0, scenario.problems.indexOf(q62)).map(p => p.id) }));
  h.click('select', 'Q7');
  assert.equal(h.evaluate('state.selected'), 'Q7');
  assert.equal(h.composer.hidden, false);
  h.click('select', 'Q6.2');
  h.evaluate("answer(['ハナ', '003'])");
  h.click('open-composer');
  assert.equal(h.evaluate('state.selected'), 'Q6.2');
  finishScene(h);
  assert.equal(h.panel.open, false);
  h.click('travel-next');
  assert.equal(h.panel.open, true);
  h.click('travel-found');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.evaluate('state.selected'), 'Q7');
  assert.ok(h.composer.innerHTML.includes(q7.prompt));
  for (const block of ['A', 'B', 'C', 'D']) assert.ok(h.composer.innerHTML.includes(`<span class="answer-field-symbol-mark" aria-hidden="true">${block}</span>`));
  assert.equal((h.composer.innerHTML.match(/name="answer" type="text"/g) ?? []).length, 4);
  assert.equal((h.composer.innerHTML.match(/inputmode="numeric"/g) ?? []).length, 4);
  assert.equal((h.composer.innerHTML.match(/name="answer" type="text"[^>]*required/g) ?? []).length, 2);
  assert.equal(h.evaluate("answer(['203', '', '', '003']).status"), 'incorrect');
  assert.equal(h.answerForm.classList.contains('is-incorrect'), true);
  assert.equal(h.evaluate("answer(['203', '001', '', '302']).status"), 'incorrect');
  assert.equal(h.evaluate("answer(['２０３', '', '', '３０２']).status"), 'correct');
  assert.ok(!h.app.innerHTML.includes('class="answer-fab"'));
  finishScene(h);
  assert.ok(h.evaluate('historyScreenMarkup()').includes(scenario.portraits['タツ']));
  assert.ok(h.evaluate('historyScreenMarkup()').includes(scenario.portraits['アサヒ']));
  assert.ok(h.evaluate('historyScreenMarkup()').includes('ずっと違和感があったんだ。'));
  assert.ok(h.evaluate('historyScreenMarkup()').includes('言われてみれば確かに'));
  assert.ok(h.evaluate('historyScreenMarkup()').includes('お前しかいない！！'));
  assert.ok(!h.app.innerHTML.includes('<strong>冊子の次のページをめくろう</strong>'));
  assert.equal(h.panel.open, false);
  h.click('travel-next');
  assert.equal(h.panel.open, true);
  assert.ok(h.panel.innerHTML.includes('冊子で問題<strong class="page-turn-target">Q8</strong>を見つけましたか？'));
  assert.ok(h.panel.innerHTML.includes('この先は会場を離れても進められます'));
  assert.ok(h.app.innerHTML.includes('class="answer-fab"'));
  assert.equal(h.composer.hidden, true);
  const conversation = h.evaluate('JSON.stringify(displayedMessages)');
  h.click('travel-found');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.evaluate('state.selected'), 'Q8');
  assert.equal(h.evaluate('JSON.stringify(displayedMessages)'), conversation);
  assert.ok(!h.app.innerHTML.includes('class="composer-area answer-page"'));
  assert.ok(!h.composer.innerHTML.includes('data-action="close-composer"'));
  assert.ok(h.composer.innerHTML.includes('class="composer-hint" data-action="hints"'));
  assert.equal((h.composer.innerHTML.match(/name="answer" type="text"/g) ?? []).length, 3);
  h.documentEvent('keydown', { key: 'Escape' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.evaluate('historyView'), true);
  assert.equal(h.composer.hidden, false);
  assert.equal(h.evaluate('state.selected'), 'Q8');
  h.documentEvent('keydown', { key: 'Escape' });
  assert.equal(h.evaluate('historyView'), false);
  assert.equal(h.evaluate('JSON.stringify(displayedMessages)'), conversation);
  const restored = appHarness(h.snapshot());
  restored.click('history');
  assert.ok(restored.workspace.innerHTML.includes('お好きな場所で続きをお楽しみください。(ただし、はさみとテープが必要になるのでご注意ください)'));
  restored.click('select', 'Q7');
  assert.equal(restored.evaluate("state.solved.includes('Q7')"), true);
});

test('Q7の保存済みの会場案内にもはさみとテープの注意書きを表示する', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  const notice = scenario.problems.find(p => p.id === 'Q7').dialogue.find(line => line.text.startsWith('※会場でプレイされている方へ'));
  const legacy = { ...notice, kind: 'dialogue', problemId: 'Q7', text: notice.text.replace('(ただし、はさみとテープが必要になるのでご注意ください)', '') };
  assert.ok(h.evaluate(`messageMarkup(${JSON.stringify(legacy)})`).includes('お楽しみください。(ただし、はさみとテープが必要になるのでご注意ください)'));
});

test('手がかり番号を答える全4問の入力案内を統一し、番号の文字入力を維持する', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  for (const id of ['Q3.3', 'Q4', 'Q6.2', 'Q7']) {
    h.click('select', id);
    assert.ok(h.app.innerHTML.includes('placeholder="3桁の手がかり番号を入力…"'));
    assert.ok(h.app.innerHTML.includes('inputmode="numeric"'));
  }
});

test('Q8はQ7の会話を背景に通常パネルで穴埋め文の下に4つの回答欄を表示する', () => {
  const q8 = scenario.problems.find(p => p.id === 'Q8');
  const h = appHarness();
  h.click('select', 'Q8');
  assert.equal(h.evaluate('state.selected'), 'Q8');
  assert.equal(h.evaluate('displayedMessages.length'), scenario.problems.find(p => p.id === 'Q7').dialogue.length);
  assert.equal(h.evaluate('displayedMessages.every(m => m.problemId === "Q7")'), true);
  assert.ok(h.app.innerHTML.includes('この先は会場を離れても進められます'));
  assert.ok(h.app.innerHTML.includes('全ての謎を解明せよ'));
  assert.equal(h.composer.hidden, false);
  assert.ok(!h.app.innerHTML.includes('class="composer-area answer-page"'));
  assert.ok(!h.app.innerHTML.includes('aria-label="謎解き会話" tabindex="0" hidden'));
  assert.ok(!h.app.innerHTML.includes('トークに戻る'));
  assert.ok(h.app.innerHTML.includes('class="composer-hint" data-action="hints"'));
  assert.ok(!h.app.innerHTML.includes('data-action="close-composer"'));
  assert.ok(!h.app.innerHTML.includes('answer-fields-inline'));
  assert.ok(h.app.innerHTML.includes(`<p class="answer-template">${q8.answerTemplate}</p>`));
  assert.equal((q8.answerTemplate.match(/【[①②③④]】/g) ?? []).length, 4);
  assert.ok(h.app.innerHTML.includes('data-fields-layout="pairs"'));
  assert.equal((h.app.innerHTML.match(/class="answer-field-pair"/g) ?? []).length, 2);
  assert.ok(h.app.innerHTML.indexOf('class="answer-template"') < h.app.innerHTML.indexOf('class="answer-entry-label"'));
  assert.equal((h.app.innerHTML.match(/name="answer" type="text"/g) ?? []).length, 3);
  assert.ok(h.app.innerHTML.includes('<select id="answer" name="answer" required>'));
  assert.deepEqual(q8.fields[0].answerChoices, ['マヤ', 'ハナ', 'サダヲ', 'アツヤ']);
  assert.ok(h.app.innerHTML.includes('深き者」が必要だった'));
  assert.ok(h.app.innerHTML.includes('を集める」という段階'));
  assert.ok(!h.app.innerHTML.includes('知恵深き者'));
  assert.ok(!h.app.innerHTML.includes('畏怖を集める'));
  assert.equal(h.evaluate("answer(['ハナ', '知恵', '恐怖', '大地震']).status"), 'incorrect');
  assert.equal(h.answerForm.classList.contains('is-incorrect'), true);
  assert.equal(h.evaluate("answer(['ハナ', '知恵', '畏怖', '大地震']).status"), 'correct');
  assert.ok(!h.app.innerHTML.includes('class="composer-area answer-page"'));
  assert.ok(!h.app.innerHTML.includes('class="novel-bubble"'));
  assert.ok(!h.app.innerHTML.includes('次のページへ進もう'));
  assert.equal(h.panel.open, false);
  assert.ok(h.app.innerHTML.includes('class="page-turn-scene" data-action="travel-next"'));
  assert.ok(h.app.innerHTML.includes('class="page-turn-scene-text">冊子の次のページをめくろう'));
  h.click('travel-next');
  assert.equal(h.panel.open, true);
  assert.ok(h.panel.innerHTML.includes('冊子で問題<strong class="page-turn-target">Q9</strong>を見つけましたか？'));
  assert.ok(h.panel.innerHTML.includes('data-action="travel-found">問題を確認した</button>'));
  assert.ok(!h.app.innerHTML.includes('class="page-turn-scene"'));
  assert.ok(!h.app.innerHTML.includes('class="novel-bubble"'));
  assert.ok(!h.app.innerHTML.includes('class="instruction-card instruction-card-page-turn"'));
  h.click('close');
  h.click('travel-next');
  assert.equal(h.panel.open, true);
  const restored = appHarness(h.snapshot());
  assert.equal(restored.panel.open, false);
  assert.ok(restored.app.innerHTML.includes('class="page-turn-scene"'));
  restored.click('travel-next');
  assert.equal(restored.panel.open, true);
  restored.click('close');
  restored.evaluate("selectProblem('Q8')");
  assert.ok(restored.app.innerHTML.includes('class="page-turn-scene"'));
  restored.click('history');
  assert.ok(!restored.workspace.innerHTML.includes('次のページへ進もう'));
  restored.click('select', 'Q8');
  assert.equal(restored.composer.hidden, false);
  assert.equal((restored.app.innerHTML.match(/name="answer" type="text"/g) ?? []).length, 3);
  assert.equal(restored.evaluate("state.solved.includes('Q8')"), true);
});

test('Q8の回答パネルは閉じられず、Escで履歴を開いたり他の問題へ切り替えたりできる', async () => {
  const h = appHarness();
  h.click('select', 'Q8');
  assert.equal(h.composer.hidden, false);
  assert.ok(h.app.innerHTML.includes('class="hint-button header-actions" data-action="history"'));
  h.documentEvent('keydown', { key: 'Escape' });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.evaluate('historyView'), true);
  assert.equal(h.composer.hidden, false);
  assert.ok(!h.app.innerHTML.includes('class="composer-area answer-page"'));
  h.click('history-back');
  assert.equal(h.evaluate('historyView'), false);
  assert.equal(h.composer.hidden, false);
  assert.equal(h.evaluate('state.selected'), 'Q8');
  h.click('select', 'Q2');
  assert.equal(h.composer.hidden, false);
  assert.ok(!h.app.innerHTML.includes('class="composer-area answer-page"'));
  assert.ok(!h.app.innerHTML.includes('aria-label="謎解き会話" tabindex="0" hidden'));
  assert.deepEqual(JSON.parse(h.snapshot()).solved, []);
});

function storedPlay(state, view = restorePlayView(scenario, state, null), changes = {}) {
  return JSON.stringify({ format: 1, scenarioId: scenario.id, code: '001234', revision: 1,
    updatedAt: '2026-10-29T00:00:00Z', state, view, pending: false, generation: 0, ...changes });
}

test('続きからは表紙を変えずに6個の数字ボックスのボトムシートを開閉する', async t => {
  const h = appHarness(null, false, { entryOnly: true });
  t.after(() => h.dispose());
  assert.equal(h.evaluate('gateVisible'), true);
  assert.ok(h.app.innerHTML.includes('assets/title-patchwork-v3.webp'));
  assert.ok(h.app.innerHTML.includes('>はじめから</button>'));
  assert.ok(h.app.innerHTML.includes('>続きから</button>'));
  assert.ok(!h.app.innerHTML.includes('id="resume-form"'));
  assert.ok(!h.app.innerHTML.includes('別の番号で再開'));
  const cover = h.app.innerHTML;
  h.click('save-continue');
  assert.equal(h.app.innerHTML, cover);
  assert.equal(h.panel.open, true);
  assert.ok(h.panel.classList.contains('resume-sheet'));
  assert.ok(h.panel.innerHTML.includes('id="resume-form"'));
  assert.equal((h.panel.innerHTML.match(/data-resume-digit=/g) ?? []).length, 6);
  assert.equal((h.panel.innerHTML.match(/maxlength="1"/g) ?? []).length, 6);
  assert.ok(h.resumeDigits[0].focused);
  h.click('close');
  await Promise.resolve();
  assert.equal(h.panel.open, false);
  assert.equal(h.evaluate('gateInput'), false);
  assert.equal(h.app.innerHTML, cover);
  assert.ok(h.app.innerHTML.includes('data-action="save-continue"'));
  assert.ok(!h.app.innerHTML.includes('id="resume-form"'));
  assert.equal(h.networkCalls.length, 0);
  assert.equal(h.storageCalls.filter(([action]) => action !== 'get').length, 0);
});

test('再開番号は全角を正規化して次のボックスへ進み、空欄の削除と矢印で戻れる', t => {
  const h = appHarness(null, false, { entryOnly: true });
  t.after(() => h.dispose());
  h.click('save-continue');
  const [first, second] = h.resumeDigits;
  first.value = '０';
  h.documentEvent('input', { target: first });
  assert.equal(first.value, '0');
  assert.ok(second.focused);
  second.value = '１';
  h.documentEvent('input', { target: second });
  assert.ok(h.resumeDigits[2].focused);
  let prevented = false;
  h.documentEvent('keydown', { target: h.resumeDigits[2], key: 'Backspace', preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.equal(second.value, '');
  assert.ok(second.focused);
  h.documentEvent('keydown', { target: second, key: 'ArrowLeft', preventDefault() {} });
  assert.ok(first.focused);
  first.value = 'あ';
  h.documentEvent('input', { target: first });
  assert.equal(first.value, '');
  assert.equal(h.networkCalls.length, 0);
});

test('6桁の貼り付けで先頭ゼロを保って自動再開し、追加送信では二重読込しない', async t => {
  const saved = { ...engine.initialState(scenario), selected: 'N2' };
  const h = appHarness(null, false, { entryOnly: true, fetchImpl: async () => ({
    ok: true, status: 200, json: async () => JSON.parse(storedPlay(saved)),
  }) });
  t.after(() => h.dispose());
  h.click('save-continue');
  let prevented = false;
  h.documentEvent('paste', { target: h.resumeDigits[0], clipboardData: { getData: () => '００１２３４' }, preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.equal(h.resumeDigits.map(input => input.value).join(''), '001234');
  assert.ok(h.resumeDigits[5].focused);
  assert.equal(h.networkCalls.length, 1);
  h.documentEvent('submit', { target: { id: 'resume-form' }, preventDefault() {} });
  assert.equal(h.networkCalls.length, 1);
  assert.equal(h.networkCalls[0].action, 'load');
  assert.equal(h.networkCalls[0].code, '001234');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.evaluate('gateVisible'), false);
  assert.equal(h.panel.open, false);
});

test('手入力は5桁までは読み込まず6桁目で自動再開する', async t => {
  const saved = engine.initialState(scenario);
  const h = appHarness(null, false, { entryOnly: true, fetchImpl: async () => ({
    ok: true, status: 200, json: async () => JSON.parse(storedPlay(saved)),
  }) });
  t.after(() => h.dispose());
  h.click('save-continue');
  for (let index = 0; index < 6; index++) {
    h.resumeDigits[index].value = '001234'[index];
    h.documentEvent('input', { target: h.resumeDigits[index] });
    assert.equal(h.networkCalls.length, index === 5 ? 1 : 0);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.evaluate('gateVisible'), false);
  assert.equal(h.networkCalls[0].code, '001234');
});

test('自動再開で番号が見つからない場合はシートに入力を残し、修正で再試行する', async t => {
  const h = appHarness(null, false, { entryOnly: true, fetchImpl: async () => ({
    ok: false, status: 404, json: async () => ({ error: 'not_found', message: 'この番号の記録が見つかりません。' }),
  }) });
  t.after(() => h.dispose());
  h.click('save-continue');
  h.documentEvent('paste', { target: h.resumeDigits[0], clipboardData: { getData: () => '001234' }, preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.evaluate('gateVisible'), true);
  assert.equal(h.evaluate('gateBusy'), false);
  assert.equal(h.panel.open, true);
  assert.ok(h.panel.innerHTML.includes('この番号の記録が見つかりません。'));
  assert.equal(h.evaluate("gateDigits.join('')"), '001234');
  h.resumeDigits[5].value = '5';
  h.documentEvent('input', { target: h.resumeDigits[5] });
  assert.equal(h.networkCalls.length, 2);
  assert.equal(h.networkCalls[1].code, '001235');
  await new Promise(resolve => setImmediate(resolve));
});

test('再開は表紙の退場を待ってチャットを描画し、表示アニメーションを付ける', async t => {
  const saved = engine.initialState(scenario);
  const key = `play-save:${scenario.id}`;
  const h = appHarness(null, false, { entryOnly: true, entryAnimations: true,
    records: { [key]: storedPlay(saved) }, fetchImpl: async () => ({
      ok: true, status: 200, json: async () => JSON.parse(storedPlay(saved)),
    }),
  });
  t.after(() => h.dispose());
  await h.evaluate('startup');
  h.click('save-title');
  h.click('save-continue');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.entryTransitions.length, 1);
  assert.equal(h.evaluate('gateVisible'), true);
  assert.ok(h.entryTransitions[0].markup.includes('title-patchwork-v3.webp'));
  assert.equal(h.entryTransitions[0].frames[1].opacity, 0);
  h.entryTransitions[0].finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.evaluate('gateVisible'), false);
  assert.equal(h.entryTransitions.length, 2);
  assert.equal(h.entryTransitions[1].frames[0].opacity, 0);
  assert.equal(h.entryTransitions[1].frames[1].opacity, 1);
  assert.ok(h.entryTransitions[1].markup.includes('class="workspace'));
  h.entryTransitions[1].finish();
  await new Promise(resolve => setImmediate(resolve));
});

test('動きを減らす設定では遷移アニメーションを省略して再開する', async t => {
  const h = appHarness(null, true, { entryOnly: true, entryAnimations: true });
  t.after(() => h.dispose());
  await h.evaluate("beginPlay('code', '000000')");
  assert.equal(h.entryTransitions.length, 0);
  assert.equal(h.evaluate('gateVisible'), false);
});

test('番号入力をキャンセルすると記録を変えずに表紙へ戻る', async t => {
  const h = appHarness(null, false, { entryOnly: true });
  t.after(() => h.dispose());
  h.click('save-continue');
  let prevented = false;
  h.panelEvent('cancel', { preventDefault() { prevented = true; } });
  await Promise.resolve();
  assert.ok(prevented);
  assert.equal(h.panel.open, false);
  assert.equal(h.evaluate('gateInput'), false);
  assert.equal(h.networkCalls.length, 0);
  assert.equal(h.storageCalls.filter(([action]) => action !== 'get').length, 0);
});

test('000000で開始すると保存せず、再読み込みではタイトル画面へ戻る', async t => {
  const h = appHarness(null, false, { entryOnly: true });
  t.after(() => h.dispose());
  await h.evaluate("beginPlay('code', '000000')");
  assert.equal(h.evaluate('gateVisible'), false);
  assert.equal(h.evaluate('playSaves.getStatus().mode'), 'debug');
  assert.ok(!h.app.innerHTML.includes('class="save-status-strip'));
  h.click('save-info');
  assert.ok(h.panel.innerHTML.includes('進行は保存されません。'));
  h.panel.close();
  h.evaluate("answer(['10'])");
  h.windowEvent('pagehide');
  h.documentEvent('visibilitychange');
  assert.equal(h.storageCalls.filter(([action]) => action !== 'get').length, 0);
  assert.equal(h.networkCalls.length, 0);
  const restored = appHarness(null, false, { entryOnly: true, records: Object.fromEntries(h.storageItems) });
  t.after(() => restored.dispose());
  assert.equal(restored.evaluate('gateVisible'), true);
  assert.ok(!restored.app.innerHTML.includes('id="resume-form"'));
  assert.ok(restored.app.innerHTML.includes('data-action="save-continue"'));
  assert.deepEqual(JSON.parse(restored.snapshot()).solved, []);
});

test('保存済みなら最初からタイトルを描画せず、自動でその進行へ再開する', async t => {
  const solved = engine.submitAnswer(scenario, engine.initialState(scenario), ['10']).state;
  solved.selected = 'N2';
  const key = `play-save:${scenario.id}`;
  const h = appHarness(null, false, { entryOnly: true, entryAnimations: true, records: { [key]: storedPlay(solved) },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => JSON.parse(storedPlay(solved)) }) });
  t.after(() => h.dispose());
  assert.ok(h.renders[0].includes('続きを開いています'));
  assert.equal(h.networkCalls.length, 1);
  assert.equal(h.panel.open, false);
  await h.evaluate('startup');
  assert.equal(h.evaluate('gateVisible'), false);
  assert.equal(h.evaluate('state.selected'), 'N2');
  assert.equal(h.composer.hidden, false);
  assert.equal(h.evaluate('state.solved.includes("N1")'), true);
  assert.equal(h.entryTransitions.length, 0, 'タイトルの退場演出を挟まない');
  assert.ok(h.renders.every(markup => !markup.includes('title-patchwork-v3.webp')));
  assert.equal(h.panel.open, false, '番号案内も挟まず回答画面を開く');
  assert.equal(h.networkCalls.length, 1);
  assert.equal(h.networkCalls[0].action, 'load');
  assert.equal(h.networkCalls[0].code, '001234');
});

test('保存済みの会話途中から未表示の次のセリフを再生し、表示済み件数を保存する', async t => {
  const initial = engine.initialState(scenario);
  const solved = engine.submitAnswer(scenario, initial, ['10']).state;
  const scene = solved.messages.slice(initial.messages.length).filter(m => m.kind === 'dialogue');
  const savedView = { ...restorePlayView(scenario, solved, null), startView: false, composerExpanded: false,
    sceneStart: initial.messages.length, displayedMessages: scene.slice(0, 2), isPlaying: true, chatScrollTop: 43 };
  const key = `play-save:${scenario.id}`;
  const h = appHarness(null, false, { entryOnly: true, records: { [key]: storedPlay(solved, savedView) } });
  t.after(() => h.dispose());
  await h.evaluate('startup');
  assert.equal(h.evaluate('isPlaying'), true);
  assert.equal(h.evaluate('displayedMessages.length'), 2);
  assert.equal(h.chat.scrollTop, 43);
  assert.equal(JSON.parse(h.storageItems.get(key)).view.chatScrollTop, 43);
  assert.ok(h.app.innerHTML.includes(scene[1].text.replaceAll('&', '&amp;').replaceAll('"', '&quot;')));
  h.click('novel-next');
  assert.equal(h.evaluate('displayedMessages.length'), 3);
  assert.equal(h.evaluate('displayedMessages[2].text'), scene[2].text);
  const persisted = JSON.parse(h.storageItems.get(key));
  assert.equal(persisted.view.displayedCount, 3);
  assert.equal(persisted.view.displayedMessages, undefined);
  assert.equal(persisted.view.chatScrollTop, 43);
  assert.equal(persisted.pending, true);
  finishScene(h);
  assert.equal(h.evaluate('isPlaying'), false);
  assert.equal(h.evaluate('displayedMessages.length'), scene.length);
});

test('デバッグで回答・リセットしても既存の本番記録と旧保存データを書き換えない', async t => {
  const initial = engine.initialState(scenario);
  const solved = engine.submitAnswer(scenario, initial, ['10']).state;
  const key = `play-save:${scenario.id}`;
  const legacyKey = `webbot:${scenario.id}`;
  const normal = storedPlay(solved);
  const legacy = JSON.stringify(solved);
  const h = appHarness(null, false, { entryOnly: true, records: { [key]: normal, [legacyKey]: legacy } });
  t.after(() => h.dispose());
  await h.evaluate('startup');
  const resumedNormal = h.storageItems.get(key);
  h.storageCalls.length = 0; h.networkCalls.length = 0;
  await h.evaluate("beginPlay('code', '000000')");
  h.evaluate("answer(['10'])");
  h.click('confirm-reset');
  h.evaluate("answer(['10'])"); finishScene(h);
  h.windowEvent('pagehide');
  assert.equal(h.storageItems.get(key), resumedNormal);
  assert.equal(h.storageItems.get(legacyKey), legacy);
  assert.equal(h.storageCalls.filter(([action]) => action !== 'get').length, 0);
  assert.equal(h.networkCalls.length, 0);
});

test('旧保存データは番号が未発行でもその問題から再開し、通信失敗でも残る', async t => {
  const solved = { ...engine.submitAnswer(scenario, engine.initialState(scenario), ['10']).state, selected: 'N2' };
  const legacy = JSON.stringify(solved);
  const h = appHarness(legacy, false, { entryOnly: true });
  t.after(() => h.dispose());
  await h.evaluate('startup');
  await h.evaluate('playSaves.flush()');
  assert.equal(h.evaluate('state.selected'), 'N2');
  assert.equal(h.evaluate('playSaves.getRecord().code'), null);
  assert.equal(h.storageItems.get(`webbot:${scenario.id}`), legacy);
  assert.deepEqual(JSON.parse(h.storageItems.get(`play-save:${scenario.id}`)).state.solved, ['N1']);
  assert.equal(h.evaluate('playSaves.getStatus().phase'), 'local-only');
});

test('再開番号画面でプレイデータを削除したらタイトルに戻る', async t => {
  const saved = engine.initialState(scenario);
  const key = `play-save:${scenario.id}`;
  const record = storedPlay(saved);
  const parsed = JSON.parse(record);
  const h = appHarness(null, false, {
    entryOnly: true,
    records: { [key]: record },
    fetchImpl: async (_, init) => {
      const body = JSON.parse(init.body);
      if (body.action === 'delete') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ deleted: true, code: parsed.code, revision: body.revision ?? parsed.revision }),
        };
      }
      if (body.action === 'load') {
        return { ok: true, status: 200, json: async () => parsed };
      }
      throw new Error(`Unexpected save API action: ${body.action}`);
    },
  });
  t.after(() => h.dispose());
  await h.evaluate('startup');
  assert.equal(h.evaluate('gateVisible'), false);
  h.click('save-info');
  assert.equal(h.panel.open, true);
  h.click('save-delete-confirm');
  assert.ok(h.panel.innerHTML.includes('data-action="save-delete"'));
  h.click('save-delete');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.evaluate('gateVisible'), true);
  assert.equal(h.evaluate('gateInput'), false);
  assert.equal(h.evaluate('gateBusy'), false);
  assert.equal(h.panel.open, false);
  assert.ok(h.app.innerHTML.includes('title-patchwork-v3.webp'));
  assert.equal(h.evaluate('playSaves.getRecord()'), null);
});

test('クラウドに記録がなくても削除できタイトルに戻る', async t => {
  const saved = engine.initialState(scenario);
  const key = `play-save:${scenario.id}`;
  const record = storedPlay(saved);
  const h = appHarness(null, false, {
    entryOnly: true,
    records: { [key]: record },
    fetchImpl: async (_, init) => {
      const body = JSON.parse(init.body);
      if (body.action === 'delete') {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: 'not_found', message: 'この番号の進行記録が見つかりません。番号を確認してください。' }),
        };
      }
      if (body.action === 'load') {
        return { ok: true, status: 200, json: async () => JSON.parse(record) };
      }
      throw new Error(`Unexpected save API action: ${body.action}`);
    },
  });
  t.after(() => h.dispose());
  await h.evaluate('startup');
  h.click('save-info');
  h.click('save-delete-confirm');
  h.click('save-delete');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.evaluate('gateVisible'), true);
  assert.equal(h.evaluate('gateInput'), false);
  assert.equal(h.panel.open, false);
  assert.equal(h.evaluate('playSaves.getRecord()'), null);
  assert.equal(h.evaluate('gateError'), '');
});

test('番号入力画面ではWebMCPから回答しても進行を変更しない', t => {
  const h = appHarness(null, false, { entryOnly: true, webMCP: true });
  t.after(() => h.dispose());
  assert.equal(h.registeredTools.length, 1);
  const before = h.snapshot();
  const result = h.registeredTools[0].execute({ answer: ['10'] });
  assert.equal(result.status, 'unavailable');
  assert.equal(h.snapshot(), before);
  assert.equal(h.timer.pending.size, 0);
  assert.equal(h.storageCalls.filter(([action]) => action !== 'get').length, 0);
  assert.equal(h.networkCalls.length, 0);
});

test('つづきからでは別端末で進んだCloudflareの最新記録を読み込む', async t => {
  const old = { ...engine.submitAnswer(scenario, engine.initialState(scenario), ['10']).state, selected: 'N2' };
  const newer = { ...engine.submitAnswer(scenario, old, '法経済学部北館').state, selected: 'N3' };
  const key = `play-save:${scenario.id}`;
  const h = appHarness(null, false, { entryOnly: true, records: { [key]: storedPlay(old) },
    fetchImpl: async (_, init) => {
      assert.equal(JSON.parse(init.body).action, 'load');
      return { ok: true, status: 200, json: async () => JSON.parse(storedPlay(newer, restorePlayView(scenario, newer, null), { revision: 5 })) };
    } });
  t.after(() => h.dispose());
  await h.evaluate('startup');
  assert.equal(h.evaluate('gateVisible'), false);
  assert.equal(h.evaluate('state.selected'), 'N3');
  assert.equal(h.evaluate('state.solved.includes("N2")'), true);
  assert.equal(h.evaluate('playSaves.getRecord().revision'), 5);
  assert.equal(JSON.parse(h.storageItems.get(key)).state.selected, 'N3');
  assert.equal(h.networkCalls.length, 1);
});

test('通信断や一時的なサーバー障害なら端末の記録で再開できる', async t => {
  for (const kind of ['offline', '503', '429']) {
    const saved = { ...engine.submitAnswer(scenario, engine.initialState(scenario), ['10']).state, selected: 'N2' };
    const key = `play-save:${scenario.id}`;
    const raw = storedPlay(saved);
    const h = appHarness(null, false, { entryOnly: true, records: { [key]: raw }, fetchImpl: async () => {
      if (kind === 'offline') throw new Error('offline');
      return { ok: false, status: Number(kind), json: async () => ({ error: 'temporarily_unavailable', message: '通信を確認してください。' }) };
    } });
    t.after(() => h.dispose());
    await h.evaluate('startup');
    assert.equal(h.evaluate('gateVisible'), false);
    assert.equal(h.evaluate('state.selected'), 'N2');
    assert.equal(h.evaluate('state.solved.includes("N1")'), true);
    assert.equal(h.storageItems.get(key), raw);
    assert.equal(h.networkCalls.length, 1);
  }
});

test('削除済みなどで番号が見つからない場合は古い端末記録で開始せず案内を表示する', async t => {
  const saved = { ...engine.submitAnswer(scenario, engine.initialState(scenario), ['10']).state, selected: 'N2' };
  const key = `play-save:${scenario.id}`;
  const raw = storedPlay(saved);
  const h = appHarness(null, false, { entryOnly: true, records: { [key]: raw }, fetchImpl: async () => ({
    ok: false, status: 404, json: async () => ({ error: 'not_found', message: 'この番号の記録が見つかりません。' }),
  }) });
  t.after(() => h.dispose());
  await h.evaluate('startup');
  assert.equal(h.evaluate('gateVisible'), true);
  assert.equal(h.evaluate('gateBusy'), false);
  assert.ok(h.app.innerHTML.includes('この番号の記録が見つかりません。'));
  assert.equal(h.storageItems.get(key), raw);
  assert.deepEqual(JSON.parse(h.snapshot()).solved, []);
});

test('デバッグから番号入力へ戻っても通常記録を残し、その記録から再開できる', async t => {
  const saved = { ...engine.submitAnswer(scenario, engine.initialState(scenario), ['10']).state, selected: 'N2' };
  const key = `play-save:${scenario.id}`;
  const raw = storedPlay(saved);
  const h = appHarness(null, false, { entryOnly: true, records: { [key]: raw }, fetchImpl: async () => ({
    ok: true, status: 200, json: async () => JSON.parse(raw),
  }) });
  t.after(() => h.dispose());
  await h.evaluate('startup');
  h.storageCalls.length = 0; h.networkCalls.length = 0;
  await h.evaluate("beginPlay('code', '000000')");
  h.evaluate("answer(['10'])");
  h.click('save-entry');
  assert.equal(h.evaluate('gateVisible'), true);
  assert.equal(h.timer.pending.size, 0);
  assert.ok(h.panel.innerHTML.includes('id="resume-form"'));
  assert.equal(h.panel.open, true);
  assert.equal(h.storageItems.get(key), raw);
  assert.equal(h.storageCalls.filter(([action]) => action !== 'get').length, 0);
  assert.equal(h.networkCalls.length, 0);
  h.click('save-entry-back');
  await h.evaluate("beginPlay('continue')");
  assert.equal(h.evaluate('state.selected'), 'N2');
  assert.equal(h.evaluate('playSaves.getStatus().mode'), 'normal');
  assert.equal(h.networkCalls.length, 1);
});

test('新規開始時だけ「ゲームを開始」を表示し、プレイ中はメニューから再開番号を確認できる', async t => {
  const h = appHarness(null, false, { entryOnly: true, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => JSON.parse(storedPlay(body.state, body.view, { creationId: body.creationId })) };
  } });
  t.after(() => h.dispose());
  const ids = harness => [...harness.navigation.innerHTML.matchAll(/data-action="select" data-id="([^"]+)"/g)].map(m => m[1]);
  await h.evaluate("beginPlay('new')");
  assert.deepEqual(ids(h), ['N1']);
  assert.match(h.panel.innerHTML, /data-action="save-start"[^>]*>ゲームを開始<\/button>/);
  assert.ok(h.app.innerHTML.includes('「再開番号」を選ぶと番号を確認できます'));
  assert.ok(h.app.innerHTML.includes('menu-guide-annotated.webp'));
  h.click('save-start');
  await Promise.resolve();
  assert.equal(h.evaluate('composerExpanded'), false);
  assert.equal(h.composer.hidden, true);
  assert.ok(h.app.innerHTML.includes('WeBotの使い方'));
  h.click('toggle-menu');
  const nav = h.app.innerHTML.match(/<nav id="navigation-menu"[^>]*>([\s\S]*?)<\/nav>/)[1];
  assert.ok(nav.includes('>再開番号</span>'));
  assert.ok(nav.includes('>タイトルに戻る</span>'));
  assert.doesNotMatch(nav, /使い方|進行を保存/);
  h.documentEvent('click', { target: menuButton(h, 'save-info') });
  assert.ok(h.panel.innerHTML.includes('>再開番号</h2>'));
  assert.ok(h.panel.innerHTML.includes('>このプレイデータを削除する</button>'));
  assert.doesNotMatch(h.panel.innerHTML, /タイトルに戻る/);
  assert.ok(!h.panel.innerHTML.includes('data-action="save-start"'));
  h.click('close');
  await Promise.resolve();
  h.click('open-composer');
  h.click('start-answer-confirm');
  await Promise.resolve();
  assert.equal(h.evaluate('composerExpanded'), true);
  assert.equal(h.evaluate("answer(['10']).status"), 'correct');
  finishScene(h);
  assert.deepEqual(ids(h), ['N1', 'N2']);
  const resumed = appHarness(null, false, { entryOnly: true, records: Object.fromEntries(h.storageItems) });
  t.after(() => resumed.dispose());
  await resumed.evaluate('startup');
  assert.deepEqual(ids(resumed), ['N1', 'N2']);
  resumed.click('save-info');
  assert.ok(!resumed.panel.innerHTML.includes('data-action="save-start"'));
});

test('入力欄のEnterは次の欄へ移り、最終欄だけ送信する。日本語変換中は送信しない', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  const calls = [];
  const form = { querySelectorAll: () => fields, requestSubmit: () => calls.push('submit') };
  const fields = [0, 1].map(index => ({ matches: () => true, closest: () => form, focus: () => calls.push(`focus-${index}`) }));
  const event = index => ({ key: 'Enter', target: fields[index], preventDefault() { calls.push('prevent'); } });
  h.documentEvent('keydown', event(0));
  h.documentEvent('keydown', event(1));
  assert.deepEqual(calls, ['prevent', 'focus-1', 'prevent', 'submit']);
  calls.length = 0;
  h.documentEvent('compositionstart', { target: fields[0] });
  h.documentEvent('keydown', event(1));
  assert.deepEqual(calls, []);
  h.documentEvent('compositionend', { target: { ...fields[0], dataset: {} } });
  h.documentEvent('keydown', event(1));
  assert.deepEqual(calls, []);
});

test('連続送信で会話のない次の小問まで進めず、短い待機後に再送信できる', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.click('select', 'Q2');
  h.evaluate(`Date.now = () => 1000; globalThis.FormData = class { get() { return state.selected === 'Q2' ? '1' : '布'; } getAll() { return [this.get()]; } };`);
  const event = { target: { id: 'answer-form', querySelector: () => null }, preventDefault() {} };
  h.documentEvent('submit', event);
  assert.equal(h.evaluate('state.selected'), 'Q2.1');
  h.documentEvent('submit', event);
  assert.equal(h.evaluate('state.selected'), 'Q2.1');
  h.evaluate('Date.now = () => 1400');
  h.documentEvent('submit', event);
  assert.equal(h.evaluate('state.selected'), 'Q2.2');
});

test('正解した下書きを消し、旧選択値から再開時に復活させない', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.evaluate("answerDrafts.N1 = ['10']; selectedPuzzleAnswer = '10'; answer(['10'])");
  assert.equal(h.evaluate("'N1' in answerDrafts"), false);
  finishScene(h);
  h.evaluate("enterPlay({ code: '000000', state, view: capturePlayView() })");
  assert.equal(h.evaluate("'N1' in answerDrafts"), false);
  h.click('select', 'N1');
  assert.equal(h.evaluate('selectedPuzzleAnswer'), '');
});

test('履歴は閉じる演出が終わってから取り除き、入力とトークの位置を保持する', async t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.click('select', 'Q7');
  h.answerField.value = '入力途中';
  h.chat.scrollTop = 74;
  h.click('history');
  let finish;
  const animations = [];
  h.historyScreen.animate = (frames, options) => {
    const animation = { finished: new Promise(resolve => { finish = resolve; }), cancel() {} };
    animations.push({ frames, options });
    return animation;
  };
  h.click('history-back');
  assert.equal(h.evaluate('historyView'), false);
  assert.equal(animations[0].options.duration, MOTION.exit);
  assert.ok(h.workspace.innerHTML.includes('class="history-screen"'));
  assert.equal(h.answerField.value, '入力途中');
  assert.equal(h.chat.scrollTop, 74);
  finish();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(h.workspace.innerHTML.includes('class="history-screen"'), false);
});

test('未同期の下書きがある起動では端末の進行を優先し、古いクラウド記録を読み込まない', async t => {
  const saved = { ...engine.initialState(scenario), selected: 'Q7' };
  const savedView = { ...restorePlayView(scenario, saved, null), answerDrafts: { Q7: ['２０３', '', '', '３０２'] } };
  const key = `play-save:${scenario.id}`;
  const h = appHarness(null, false, { entryOnly: true,
    records: { [key]: storedPlay(saved, savedView, { pending: true, generation: 2 }) },
    fetchImpl: async (_, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.action, 'save');
      assert.deepEqual(body.view.answerDrafts, savedView.answerDrafts);
      return { ok: true, status: 200, json: async () => JSON.parse(storedPlay(body.state, body.view, { revision: 2 })) };
    },
  });
  t.after(() => h.dispose());
  await h.evaluate('startup'); await h.evaluate('playSaves.flush()');
  assert.equal(h.evaluate('gateVisible'), false);
  assert.equal(h.evaluate('state.selected'), 'Q7');
  assert.deepEqual(JSON.parse(h.evaluate('JSON.stringify(answerDrafts)')), savedView.answerDrafts);
  assert.ok(h.networkCalls.every(call => call.action === 'save'));
  assert.ok(h.renders.every(markup => !markup.includes('title-patchwork-v3.webp')));
});

test('保存がない・壊れている・デバッグ番号しかない場合は自動再開しない', t => {
  const key = `play-save:${scenario.id}`;
  for (const raw of [null, '{broken', JSON.stringify({ format: 1 }), storedPlay(engine.initialState(scenario), {}, { code: '000000' })]) {
    const h = appHarness(null, false, { entryOnly: true, records: raw === null ? {} : { [key]: raw } });
    t.after(() => h.dispose());
    assert.equal(h.evaluate('gateVisible'), true);
    assert.equal(h.evaluate('gateBusy'), false);
    assert.ok(h.app.innerHTML.includes('title-patchwork-v3.webp'));
    assert.equal(h.networkCalls.length, 0);
    if (raw !== null) assert.equal(h.storageItems.get(key), raw, '不正な記録を勝手に削除しない');
  }
});

test('明示したタイトル画面に留まり、URLを開き直したときだけ再び自動再開する', async t => {
  const saved = { ...engine.submitAnswer(scenario, engine.initialState(scenario), ['10']).state, selected: 'N2' };
  const key = `play-save:${scenario.id}`;
  const h = appHarness(null, false, { entryOnly: true, records: { [key]: storedPlay(saved) } });
  t.after(() => h.dispose());
  await h.evaluate('startup');
  h.click('toggle-menu');
  h.documentEvent('click', { target: menuButton(h, 'save-title') });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.evaluate('gateVisible'), true);
  assert.equal(h.evaluate('gateBusy'), false);
  assert.ok(h.app.innerHTML.includes('title-patchwork-v3.webp'));
  assert.equal(h.networkCalls.length, 1);
  const reopened = appHarness(null, false, { entryOnly: true, records: Object.fromEntries(h.storageItems) });
  t.after(() => reopened.dispose());
  await reopened.evaluate('startup');
  assert.equal(reopened.evaluate('gateVisible'), false);
  assert.equal(reopened.evaluate('state.selected'), 'N2');
  assert.ok(reopened.renders.every(markup => !markup.includes('title-patchwork-v3.webp')));
});

test('手がかりボタンはカード一覧を開き、選んだカードを拡大できる', async t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.click('select', 'Q1');
  assert.ok(h.app.innerHTML.includes('class="clue-button" data-action="clues"'));
  h.click('clues');
  assert.equal(h.panel.open, true);
  assert.equal(h.panel.classList.contains('clue-gallery'), true);
  assert.ok(h.panel.innerHTML.includes('class="clue-card-grid"'));
  assert.equal((h.panel.innerHTML.match(/class="clue-card-tile"/g) ?? []).length, scenario.clueGallery.length);
  assert.ok(!h.panel.innerHTML.includes('data-minigame-entry'));
  assert.ok(!h.panel.innerHTML.includes('装置を操作する'));
  h.click('clue-card-open', 'clue-1');
  assert.equal(h.evaluate('expandedClueId'), 'clue-1');
  assert.ok(h.panel.innerHTML.includes('class="clue-card-expanded"'));
  assert.ok(h.panel.innerHTML.includes('アサヒの調査結果'));
  h.click('clue-card-close');
  assert.equal(h.evaluate('expandedClueId'), null);
  assert.ok(h.panel.innerHTML.includes('class="clue-card-grid"'));
  h.click('close');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.panel.open, false);
});

test('カード長押しで合成選択になり2枚で合成できる', async t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.click('select', 'Q1');
  h.click('clues');
  assert.equal(h.evaluate('combineSelecting'), false);
  h.evaluate('beginCombineSelecting("clue-1")');
  h.evaluate('openPanel("clues", { keepFocus: true })');
  assert.equal(h.evaluate('combineSelecting'), true);
  assert.deepEqual(JSON.parse(h.evaluate('JSON.stringify(combineSelection)')), ['clue-1']);
  assert.ok(h.panel.innerHTML.includes('合成 1/2'));
  assert.ok(h.panel.innerHTML.includes('class="combine-order" aria-hidden="true">①'));
  assert.ok(h.panel.innerHTML.includes('data-action="combine-select-run"'));
  assert.match(h.panel.innerHTML, /data-action="combine-select-run"[^>]*\sdisabled/);
  h.evaluate('switchClueTab("characters")');
  assert.ok(h.panel.innerHTML.includes('class="clue-card-grid character-grid"'));
  assert.equal((h.panel.innerHTML.match(/class="clue-card-tile"/g) ?? []).length, scenario.characterCards.length);
  h.evaluate('toggleCombineCard("clue-29")');
  h.evaluate('openPanel("clues", { keepFocus: true })');
  assert.ok(h.panel.innerHTML.includes('class="combine-order" aria-hidden="true">②'));
  h.evaluate('toggleCombineCard("clue-29")');
  h.evaluate('switchClueTab("cards")');
  h.evaluate('toggleCombineCard("clue-2")');
  h.evaluate('openPanel("clues", { keepFocus: true })');
  assert.deepEqual(JSON.parse(h.evaluate('JSON.stringify(combineSelection)')), ['clue-1', 'clue-2']);
  assert.ok(h.panel.innerHTML.includes('合成 2/2'));
  assert.ok(h.panel.innerHTML.includes('class="combine-order" aria-hidden="true">②'));
  assert.doesNotMatch(h.panel.innerHTML, /data-action="combine-select-run"[^>]*\sdisabled/);
  h.click('combine-select-run');
  assert.equal(h.evaluate('clueTab'), 'combine');
  assert.equal(h.evaluate('combineSelecting'), false);
  assert.deepEqual(JSON.parse(h.evaluate('JSON.stringify(combineSelection)')), ['clue-1', 'clue-2']);
  assert.ok(h.panel.innerHTML.includes('class="combine-open"'));
  assert.ok(!h.panel.innerHTML.includes('class="primary-button full combine-open"'));
  assert.ok(!h.panel.innerHTML.includes('class="combine-stage"'));
  assert.ok(h.panel.innerHTML.includes('id="combine-feedback"'));
});

test('手がかり画面のカード・キャラ情報・合成タブを切り替えられる', async t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.click('select', 'Q1');
  h.click('clues');
  assert.ok(h.panel.innerHTML.includes('role="tablist"'));
  assert.ok(h.panel.innerHTML.includes('class="topbar clue-screen-header"'));
  assert.ok(h.panel.innerHTML.includes('class="menu-button clue-back"'));
  assert.ok(h.panel.innerHTML.includes(`class="brand-title">${scenario.title} 冥</span>`));
  assert.ok(!h.panel.innerHTML.includes('>手がかり</h2>'));
  assert.ok(h.panel.innerHTML.includes('id="clue-tab-cards"'));
  h.evaluate('switchClueTab("characters")');
  assert.equal((h.panel.innerHTML.match(/clue-gallery-card/g) ?? []).length, scenario.characterCards.length);
  assert.ok(h.panel.innerHTML.includes('aria-labelledby="clue-tab-characters"'));
  assert.ok(h.panel.innerHTML.includes('マヤ'));
  h.evaluate('switchClueTab("combine")');
  assert.ok(h.panel.innerHTML.includes('class="combine-open"'));
  assert.ok(!h.panel.innerHTML.includes('class="primary-button full combine-open"'));
  assert.ok(!h.panel.innerHTML.includes('class="combine-stage"'));
  assert.ok(h.panel.innerHTML.includes('合成とは2枚の手がかりカードから新しいカードを手に入れることのできるシステムです。関連のありそうな2枚のカードを選択してください。'));
  assert.ok(h.panel.innerHTML.includes('手がかり番号は、カード下部の数字となります。'));
  assert.ok(h.panel.innerHTML.includes('手がかり番号はカードだけではなく公開情報にも書かれてあります。見落とさないようご注意ください。'));
  assert.ok(h.panel.innerHTML.includes('class="start-guide-menu"'));
  assert.ok(h.panel.innerHTML.includes('</div>\n    <p>手がかり番号はカードだけではなく公開情報にも書かれてあります'));
  assert.ok(h.panel.innerHTML.includes('combine-number-callout.webp'));
  assert.ok(h.panel.innerHTML.includes('aria-labelledby="clue-tab-combine"'));
  h.evaluate('switchClueTab("cards")');
  assert.equal((h.panel.innerHTML.match(/class="clue-card-tile"/g) ?? []).length, scenario.clueGallery.length);
  assert.ok(!h.panel.innerHTML.includes('class="clue-card-meta"'));
  assert.equal((h.panel.innerHTML.match(/data-minigame-entry/g) ?? []).length, 0);
  h.click('close');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.panel.open, false);
  assert.equal(h.evaluate('state.selected'), 'Q1');
});

test('手がかりカードは進行に応じて開示される', async t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.evaluate("playSaves.getStatus = () => ({ mode: 'normal' })");
  h.click('select', 'Q1');
  h.click('clues');
  const tileIds = () => [...h.panel.innerHTML.matchAll(/data-action="clue-card-open" data-id="([^"]+)"/g)].map(match => match[1]);
  const rerender = () => h.evaluate("openPanel('clues', { keepFocus: true })");
  assert.deepEqual(tileIds(), scenario.clueGallery.filter(card => !card.requires).map(card => card.id));
  h.evaluate("state.solved.push('Q1', 'Q1.1')"); rerender();
  assert.ok(tileIds().includes('clue-18'));
  assert.ok(!tileIds().includes('clue-19'));
  h.evaluate("state.solved.push('Q2', 'Q2.1', 'Q2.2')"); rerender();
  assert.ok(tileIds().includes('clue-22'));
  assert.ok(!tileIds().includes('clue-23'));
  h.evaluate("state.minigames.push('hex-cube')"); rerender();
  assert.ok(tileIds().includes('clue-23'));
  h.evaluate("state.combinations.push('combine-401', 'combine-402', 'combine-403')"); rerender();
  for (const id of ['clue-24', 'clue-25', 'clue-26']) assert.ok(tileIds().includes(id));
  assert.ok(!tileIds().includes('clue-27'));
  h.evaluate("state.solved.push('Q3.3')"); rerender();
  assert.ok(tileIds().includes('clue-27'));
  assert.ok(!tileIds().includes('clue-28'));
  h.evaluate("state.solved.push(...scenario.investigation.problemIds)"); rerender();
  assert.ok(tileIds().includes('clue-28'));
});

test('デバッグモードでは手がかりカードを無条件で全件表示する', async t => {
  const h = appHarness(null, false, { entryOnly: true });
  t.after(() => h.dispose());
  await h.evaluate("beginPlay('code', '000000')");
  assert.equal(h.evaluate('playSaves.getStatus().mode'), 'debug');
  h.click('select', 'Q1');
  h.click('clues');
  assert.equal((h.panel.innerHTML.match(/class="clue-card-tile"/g) ?? []).length, scenario.clueGallery.length);
});

test('カードの合成で番号付きの手がかりカードを入手できる', async t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.evaluate("playSaves.getStatus = () => ({ mode: 'normal' })");
  h.click('select', 'Q1');
  h.click('clues');
  h.evaluate("state.solved.push('Q1', 'Q1.1'); state.combinations.push('combine-401'); openPanel('clues', { keepFocus: true })");
  assert.ok(h.panel.innerHTML.includes('data-action="clue-card-open" data-id="clue-24"'));
  h.evaluate('switchClueTab("combine")');
  assert.ok(h.panel.innerHTML.includes('DISCOVERY · 104 + 204'));
  assert.ok(h.panel.innerHTML.includes('手がかりカード401'));
});

test('キャラ情報は横スクロールで切り替えられる', async t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.click('select', 'Q1');
  h.click('clues');
  h.evaluate('switchClueTab("characters")');
  assert.equal((h.panel.innerHTML.match(/clue-gallery-card/g) ?? []).length, scenario.characterCards.length);
  assert.ok(h.panel.innerHTML.includes('class="clue-carousel"'));
  const listeners = {};
  const cards = scenario.characterCards.map((_, index) => ({
    offsetLeft: 100 + index * 108, offsetWidth: 100, scale: 0, active: false,
    style: { setProperty(name, value) { cards[index].scale = value; } },
    setAttribute() { this.active = true; }, removeAttribute() { this.active = false; },
  }));
  const track = {
    scrollLeft: 0, clientWidth: 300, style: {},
    classList: { add() {}, remove() {} },
    setPointerCapture() {},
    querySelectorAll() { return cards; },
    addEventListener(name, callback) { listeners[name] = callback; },
    scrollTo(options) { this.scrollLeft = options.left; },
  };
  const originalQuery = h.panel.querySelector;
  h.panel.querySelector = selector => selector === '.clue-carousel' ? track : originalQuery.call(h.panel, selector);
  h.evaluate('bindClueCarousel(0)');
  assert.equal(cards[0].scale, 1);
  track.scrollLeft = 108;
  listeners.scroll();
  assert.equal(cards[1].scale, 1);
  assert.equal(h.evaluate('expandedCharacter'), 1);
  h.click('close');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.panel.open, false);
});

test('控室カードのカプセルから六角形を開き、デバッグでは解答後も押せる', t => {
  const h = appHarness();
  t.after(() => h.dispose());
  h.click('clues');
  assert.ok(!h.panel.innerHTML.includes('data-minigame-entry'));
  assert.ok(!h.panel.innerHTML.includes('装置を操作する'));
  h.click('clue-card-open', 'clue-9');
  assert.match(h.panel.innerHTML, /class="clue-hex-entry"[^>]*data-action="hex-open"/);
  assert.doesNotMatch(h.panel.innerHTML, /class="clue-hex-entry"[^>]*\sdisabled/);
  h.evaluate('state=completeMinigame(scenario,state,"hex-cube",[[4],[3,4]]).state');
  h.click('clues');
  assert.equal((h.panel.innerHTML.match(/data-minigame-reward/g) ?? []).length, 1);
  assert.ok(h.panel.innerHTML.includes('装置から出てきたメモ（仮）'));
  h.click('clue-card-open', 'clue-9');
  assert.doesNotMatch(h.panel.innerHTML, /class="clue-hex-entry"[^>]*\sdisabled/);
});
test('装置クリア後は物語の会話ではなくシステムメッセージで仮カードを取得する',async t=>{
  const h=appHarness();t.after(()=>h.dispose());const before=JSON.parse(h.snapshot());
  await h.evaluate('finishHexCube([[4],[3,4]])');assert.ok(h.panel.innerHTML.includes('新しい手がかり'));assert.ok(h.panel.innerHTML.includes('手がかりを見る'));
  const after=JSON.parse(h.snapshot());assert.equal(after.messages.length,before.messages.length+1);assert.equal(after.messages.at(-1).speaker,'システム');assert.deepEqual(after.solved,before.solved);
  await h.evaluate('finishHexCube([[4],[3,4]])');assert.equal(JSON.parse(h.snapshot()).messages.length,after.messages.length);
});
test('000000ではクリア画面と手がかりから六角形を何度でも解ける', async t => {
  let onComplete;
  let mounts = 0;
  const h = appHarness(null, false, {
    entryOnly: true,
    entryUrl: 'https://example.test/11月の救祭/app/?minigame=hex-cube',
    minigameMount(_host, options) {
      mounts++;
      onComplete = options.onComplete;
      return { destroy() {}, refresh() {} };
    },
  });
  t.after(() => h.dispose());
  await h.evaluate('startup');
  await h.evaluate('beginPlay("code", "000000")');
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(mounts, attempt);
    assert.equal(h.panel.classList.contains('hex-cube-panel'), true);
    await assert.rejects(onComplete([[0]]), /クリアを確認できません/);
    await onComplete([[4], [3, 4]]);
    assert.ok(h.panel.innerHTML.includes('もう一度解く'));
    if (attempt === 2) {
      h.click('hex-card');
      h.click('clue-card-open', 'clue-9');
      assert.match(h.panel.innerHTML, /class="clue-hex-entry"/);
      assert.doesNotMatch(h.panel.innerHTML, /class="clue-hex-entry"[^>]*\sdisabled/);
    }
    if (attempt < 3) await h.evaluate('openHexCube()');
  }
  const state = JSON.parse(h.snapshot());
  assert.deepEqual(state.minigames, ['hex-cube']);
  assert.equal(state.messages.filter(message => message.minigameId === 'hex-cube').length, 1);
  assert.equal(h.networkCalls.length, 0);
  assert.equal(h.storageCalls.filter(([action]) => action !== 'get').length, 0);
});
test('QR入口で記録がなければ6桁入力を表示し復元後に同じ装置を開く',async t=>{
  let mounts=0;const seed=engine.initialState(scenario),view=restorePlayView(scenario,seed,null);
  const h=appHarness(null,false,{entryOnly:true,entryUrl:'https://example.test/11月の救祭/app/?minigame=hex-cube',minigameMount:()=>{mounts++;return{destroy(){},refresh(){}};},fetchImpl:async()=>new Response(JSON.stringify({code:'001234',revision:1,state:seed,view}),{status:200})});t.after(()=>h.dispose());
  await h.evaluate('startup');assert.equal(h.panel.classList.contains('resume-sheet'),true);assert.equal(h.evaluate('gateVisible'),true);
  await h.evaluate('beginPlay("code","001234")');assert.equal(h.evaluate('gateVisible'),false);assert.equal(h.panel.classList.contains('hex-cube-panel'),true);assert.equal(mounts,1);
});
test('装置の保存待ち中に別画面へ移動したらシステム通知で開き直さない',async t=>{
  const h=appHarness();t.after(()=>h.dispose());await h.evaluate('openHexCube()');
  const pending=h.evaluate('finishHexCube([[4],[3,4]])');h.click('clues');await pending;
  assert.equal(h.panel.classList.contains('clue-gallery'),true);
  assert.ok(h.panel.innerHTML.includes('装置から出てきたメモ（仮）'));
});
test('QR入口で端末に記録があれば入力を要求せず装置を開く',async t=>{
  let mounts=0;const seed=engine.initialState(scenario),view=restorePlayView(scenario,seed,null);
  const h=appHarness(null,false,{entryOnly:true,records:{[`play-save:${scenario.id}`]:storedPlay(seed,view)},entryUrl:'https://example.test/11月の救祭/app/?minigame=hex-cube',minigameMount:()=>{mounts++;return{destroy(){},refresh(){}};},fetchImpl:async()=>new Response(JSON.stringify({code:'001234',revision:1,state:seed,view}),{status:200})});t.after(()=>h.dispose());
  await h.evaluate('startup');assert.equal(h.evaluate('gateVisible'),false);assert.equal(h.panel.classList.contains('hex-cube-panel'),true);assert.equal(mounts,1);
});

test('QR入口の保存番号が失効していても別の6桁番号を入力して装置を開ける',async t=>{
  const seed=engine.initialState(scenario),view=restorePlayView(scenario,seed,null);
  const h=appHarness(null,false,{entryOnly:true,records:{[`play-save:${scenario.id}`]:storedPlay(seed,view)},entryUrl:'https://example.test/11月の救祭/app/?minigame=hex-cube',fetchImpl:async(_url,init)=>{
    const body=JSON.parse(init.body);
    return body.code==='001234'
      ? new Response(JSON.stringify({error:'not_found',message:'この番号の記録が見つかりません。'}),{status:404})
      : new Response(JSON.stringify({code:body.code,revision:1,state:seed,view}),{status:200});
  }});t.after(()=>h.dispose());
  await h.evaluate('startup');
  assert.equal(h.panel.classList.contains('resume-sheet'),true);
  assert.ok(h.panel.innerHTML.includes('この番号の記録が見つかりません。'));
  await h.evaluate('beginPlay("code","005678")');
  assert.equal(h.evaluate('gateVisible'),false);assert.equal(h.panel.classList.contains('hex-cube-panel'),true);
});

test('旧保存から番号を発行する途中で装置をクリアしても取得通知を表示する',async t=>{
  let online=false;
  const seed=engine.initialState(scenario);
  const h=appHarness(JSON.stringify(seed),false,{entryOnly:true,entryUrl:'https://example.test/11月の救祭/app/?minigame=hex-cube',fetchImpl:async(_url,init)=>{
    if(!online)throw new Error('offline');
    const body=JSON.parse(init.body);
    return new Response(JSON.stringify({code:'005678',revision:1,state:body.state,view:body.view}),{status:200});
  }});t.after(()=>h.dispose());
  await h.evaluate('startup');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.evaluate('playSaves.getRecord().code'),null);online=true;
  await h.evaluate('finishHexCube([[4],[3,4]])');
  assert.equal(h.evaluate('playSaves.getRecord().code'),'005678');assert.equal(h.evaluate('playSaves.getRecord().pending'),false);
  assert.ok(h.panel.innerHTML.includes('新しい手がかり「装置から出てきたメモ（仮）」'));
});

test('通信失敗後に装置を開き直しても保存済みとして扱わず、再送で一度だけ取得する',async t=>{
  let online=false;
  const seed=engine.initialState(scenario),view=restorePlayView(scenario,seed,null);
  const h=appHarness(null,false,{entryOnly:true,records:{[`play-save:${scenario.id}`]:storedPlay(seed,view)},entryUrl:'https://example.test/11月の救祭/app/?minigame=hex-cube',fetchImpl:async(_url,init)=>{
    const body=JSON.parse(init.body);
    if(body.action==='load')return new Response(JSON.stringify({code:body.code,revision:1,state:seed,view}),{status:200});
    if(!online)throw new Error('offline');
    return new Response(JSON.stringify({code:body.code,revision:2,state:body.state,view:body.view}),{status:200});
  }});t.after(()=>h.dispose());
  await h.evaluate('startup');await h.evaluate('finishHexCube([[4],[3,4]])');
  assert.equal(h.evaluate('playSaves.getRecord().pending'),true);assert.ok(h.panel.innerHTML.includes('保存を確認する'));
  h.click('close');await Promise.resolve();await Promise.resolve();h.click('hex-open');
  assert.ok(h.panel.innerHTML.includes('保存を確認する'));
  online=true;h.click('hex-save-retry');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.evaluate('playSaves.getRecord().pending'),false);assert.ok(h.panel.innerHTML.includes('手がかりを見る'));
  assert.equal(JSON.parse(h.snapshot()).messages.filter(m=>m.minigameId==='hex-cube').length,1);
});

test('QRで未送信のクリア記録を再開し、通信復帰後に重複せず保存する',async t=>{
  let online=false;
  const seed=engine.completeMinigame(scenario,engine.initialState(scenario),'hex-cube',[[4],[3,4]]).state;
  const view=restorePlayView(scenario,seed,null);
  const h=appHarness(null,false,{entryOnly:true,records:{[`play-save:${scenario.id}`]:storedPlay(seed,view,{pending:true})},entryUrl:'https://example.test/11月の救祭/app/?minigame=hex-cube',fetchImpl:async(_url,init)=>{
    if(!online)throw new Error('offline');
    const body=JSON.parse(init.body);
    return new Response(JSON.stringify({code:body.code,revision:2,state:body.state,view:body.view}),{status:200});
  }});t.after(()=>h.dispose());
  await h.evaluate('startup');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(h.networkCalls.some(call=>call.action==='load'),false,'未送信のクリアを古いサーバー記録で置き換えない');
  assert.ok(h.panel.innerHTML.includes('保存を確認する'));
  online=true;h.click('hex-save-retry');await new Promise(resolve=>setImmediate(resolve));
  assert.ok(h.panel.innerHTML.includes('手がかりを見る'));
  assert.equal(h.evaluate('unlockedCards(scenario,state).filter(card=>card.id==="hex-cube-note").length'),1);
  h.click('hex-card');
  h.click('clue-card-open', 'clue-9');
  assert.match(h.panel.innerHTML, /class="clue-hex-entry"[^>]*\sdisabled/);
  h.click('hex-open');
  assert.equal(h.panel.classList.contains('clue-gallery'), true);
  assert.ok(!h.panel.innerHTML.includes('もう一度解く'));
});

test('装置の保存が競合した場合は報酬通知を出さず、選択画面を出さずクラウド記録の取得状態へ戻す',async t=>{
  const seed=engine.initialState(scenario),view=restorePlayView(scenario,seed,null);
  const h=appHarness(null,false,{entryOnly:true,records:{[`play-save:${scenario.id}`]:storedPlay(seed,view)},entryUrl:'https://example.test/11月の救祭/app/?minigame=hex-cube',fetchImpl:async(_url,init)=>{
    const body=JSON.parse(init.body),remote={code:'001234',revision:2,state:seed,view};
    return body.action==='save'
      ? new Response(JSON.stringify({error:'conflict',remote}),{status:409})
      : new Response(JSON.stringify(remote),{status:200});
  }});t.after(()=>h.dispose());
  await h.evaluate('startup');await h.evaluate('finishHexCube([[4],[3,4]])');
  assert.equal(h.evaluate('playSaves.getStatus().phase'),'saved');
  assert.ok(!h.panel.innerHTML.includes('data-action="save-use-remote"'));
  assert.ok(!h.panel.innerHTML.includes('data-action="save-use-local"'));
  assert.ok(!h.panel.innerHTML.includes('data-action="hex-card"'));
  assert.equal(h.evaluate('state.minigames.length'),0);assert.equal(h.evaluate('unlockedCards(scenario,state).filter(card=>card.id==="hex-cube-note").length'),0);
});

test('旧保存の番号発行リクエスト中にクリアした更新も発行後に続けて保存する',async t=>{
  let respond;
  const h=appHarness(JSON.stringify(engine.initialState(scenario)),false,{entryOnly:true,entryUrl:'https://example.test/11月の救祭/app/?minigame=hex-cube',fetchImpl:async(_url,init)=>{
    const body=JSON.parse(init.body);
    if(body.action==='create')return new Promise(resolve=>{respond=()=>resolve(new Response(JSON.stringify({code:'005678',revision:1,state:body.state,view:body.view}),{status:200}));});
    return new Response(JSON.stringify({code:body.code,revision:2,state:body.state,view:body.view}),{status:200});
  }});t.after(()=>h.dispose());
  await h.evaluate('startup');assert.equal(typeof respond,'function');
  const pending=h.evaluate('finishHexCube([[4],[3,4]])');respond();await pending;
  assert.deepEqual(h.networkCalls.map(call=>call.action),['create','save']);
  assert.ok(h.networkCalls[1].state.minigames.includes('hex-cube'));assert.equal(h.evaluate('playSaves.getRecord().pending'),false);
  assert.ok(h.panel.innerHTML.includes('新しい手がかり'));
});


