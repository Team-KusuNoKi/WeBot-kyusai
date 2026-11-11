import test from 'node:test';
import assert from 'node:assert/strict';
import { bindVisualViewport } from '../dist/viewport.js';

function eventTarget() {
  const handlers = new Map();
  return {
    addEventListener(name, handler) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(handler); },
    removeEventListener(name, handler) { handlers.get(name)?.delete(handler); },
    emit(name) { for (const handler of handlers.get(name) ?? []) handler(); },
    listenerCount() { return [...handlers.values()].reduce((count, set) => count + set.size, 0); },
  };
}

function harness({ withViewport = true, top = 0, gap = 0 } = {}) {
  const values = new Map();
  const frameValues = new Map();
  const frames = [];
  const viewport = Object.assign(eventTarget(), { height: 844, offsetTop: 0, scale: 1 });
  const attributes = new Set();
  const workspace = {
    style: { setProperty: (name, value) => frameValues.set(name, value) },
    toggleAttribute(name, enabled) { if (enabled) attributes.add(name); else attributes.delete(name); },
    hasAttribute: name => attributes.has(name),
    getBoundingClientRect: () => ({ top }),
  };
  const doc = Object.assign(eventTarget(), {
    documentElement: { style: { setProperty: (name, value) => values.set(name, value) } },
    activeElement: null,
    querySelector: selector => selector === '.workspace' ? workspace : null,
  });
  const win = Object.assign(eventTarget(), {
    innerHeight: 844,
    ...(withViewport ? { visualViewport: viewport } : {}),
    requestAnimationFrame: callback => frames.push(callback),
    getComputedStyle: () => ({ getPropertyValue: () => String(gap) }),
  });
  const controller = bindVisualViewport(win, doc);
  return { viewport, workspace, win, doc, values, frameValues, controller,
    flush() { while (frames.length) frames.shift()(); },
    height() { return Number.parseFloat(frameValues.get('--workspace-height')); },
  };
}

test('文字入力せずキーボードが開いたresize時点で回答画面の下端を追従し、収納時は復元する', () => {
  const h = harness();
  assert.equal(h.height(), 844);
  h.viewport.height = 460;
  h.viewport.emit('resize');
  h.flush();
  assert.equal(h.height(), 460);
  assert.equal(h.values.get('--visual-height'), '460px');
  assert.equal(h.values.get('--visual-bottom-inset'), '384px');
  h.viewport.height = 844;
  h.viewport.emit('resize');
  h.flush();
  assert.equal(h.height(), 844);
  assert.equal(h.values.get('--visual-bottom-inset'), '0px');
});

test('ブラウザのパンとページスクロールを含めても下端を可視領域へ揃える', () => {
  const h = harness({ top: -80 });
  h.viewport.height = 400;
  h.viewport.offsetTop = 120;
  h.viewport.emit('scroll');
  h.flush();
  assert.equal(h.height(), 600);
  assert.equal(-80 + h.height(), 520);
  assert.equal(h.values.get('--visual-offset-top'), '120px');
});

test('回答中のキーボードは両方のresize方式で判定し、大きな段差だけを補間する', () => {
  for (const resizeLayout of [true, false]) for (const reduce of [true, false]) {
    const h = harness();
    const motions = [];
    const surface = { getBoundingClientRect: () => ({ top: 100, bottom: 460 }), animate: frames => motions.push(frames) };
    h.win.matchMedia = () => ({ matches: reduce });
    h.doc.activeElement = { matches: () => true, closest: () => surface, getBoundingClientRect: () => ({ top: 300, bottom: 340 }) };
    h.viewport.height = 460;
    if (resizeLayout) h.win.innerHeight = 460;
    h.viewport.emit('resize'); h.flush();
    assert.equal(h.workspace.hasAttribute('data-answer-keyboard'), true);
    assert.equal(motions.length, reduce ? 0 : 1);
    h.viewport.height -= 8;
    h.viewport.emit('resize'); h.flush();
    assert.equal(motions.length, reduce ? 0 : 1);
    h.win.innerHeight = h.viewport.height = 844;
    h.viewport.emit('resize'); h.flush();
    assert.equal(h.workspace.hasAttribute('data-answer-keyboard'), false);
  }
});

test('デスクトップの上下余白を二重に引かず、画面回転後にも追従する', () => {
  const h = harness({ top: 16, gap: 18 });
  assert.equal(h.height(), 810);
  h.viewport.height = 420;
  h.win.emit('orientationchange');
  h.flush();
  assert.equal(h.height(), 386);
});

test('VisualViewport非対応環境ではwindowのresizeで追従する', () => {
  const h = harness({ withViewport: false });
  h.win.innerHeight = 480;
  h.win.emit('resize');
  h.flush();
  assert.equal(h.height(), 480);
  assert.equal(h.values.get('--visual-bottom-inset'), '0px');
});

test('回答欄を開いてパネルにフォーカスしても図をスクロールしない', () => {
  const h = harness();
  const panel = { scrollTop: 0, closest: () => panel, getBoundingClientRect: () => ({ top: 200, bottom: 820 }) };
  h.doc.activeElement = panel;
  h.doc.emit('focusin');
  h.flush();
  assert.equal(panel.scrollTop, 0);
});

test('フォーカス時にも測定し、複数欄やQ8の入力を回答エリア内だけでスクロールする', () => {
  const h = harness();
  const surface = { scrollTop: 0, getBoundingClientRect: () => ({ top: 180, bottom: 448 }) };
  h.doc.activeElement = {
    closest: () => surface,
    getBoundingClientRect: () => ({ top: 560 - surface.scrollTop, bottom: 610 - surface.scrollTop }),
  };
  h.viewport.height = 460;
  h.doc.emit('focusin');
  h.flush();
  assert.equal(surface.scrollTop, 174);
  assert.equal(h.height(), 460);
  h.viewport.emit('resize');
  h.flush();
  assert.equal(surface.scrollTop, 174);
});

test('表示中にDOMが差し替わった問題も共通updateで同じ高さを使う', () => {
  const h = harness();
  h.viewport.height = 460;
  h.viewport.emit('resize');
  h.flush();
  h.frameValues.clear();
  h.controller.update();
  assert.equal(h.height(), 460);
});

test('ピンチ拡大ではレイアウトを縮めず、等倍に戻ったら測り直す', () => {
  const h = harness();
  h.viewport.scale = 2;
  h.viewport.height = 422;
  h.viewport.emit('resize');
  h.flush();
  assert.equal(h.height(), 844);
  h.viewport.scale = 1;
  h.viewport.height = 460;
  h.viewport.emit('resize');
  h.flush();
  assert.equal(h.height(), 460);
});

test('破棄時には登録したviewport・window・focusイベントを解除する', () => {
  const h = harness();
  h.controller.dispose();
  assert.equal(h.viewport.listenerCount() + h.win.listenerCount() + h.doc.listenerCount(), 0);
});

test('入力欄と送信ボタンが一緒に収まる場合は両方を可視領域に入れる', () => {
  const h = harness();
  const surface = { scrollTop: 0, getBoundingClientRect: () => ({ top: 120, bottom: 448 }) };
  const submit = { getBoundingClientRect: () => ({ top: 450 - surface.scrollTop, bottom: 494 - surface.scrollTop }) };
  const form = { querySelector: () => submit };
  h.doc.activeElement = {
    closest: selector => selector === '#answer-form' ? form : surface,
    getBoundingClientRect: () => ({ top: 300 - surface.scrollTop, bottom: 344 - surface.scrollTop }),
  };
  h.viewport.height = 460;
  h.doc.emit('focusin'); h.flush();
  assert.equal(surface.scrollTop, 58);
});
