import test from 'node:test';
import assert from 'node:assert/strict';
import { createHaptics, answerReadiness, isComposingSubmit, constrainImageTransform, bindImageViewer, bindSheetDismiss } from '../dist/interaction.js';

function hapticDevice() {
  const calls = [];
  const preferences = new Map();
  let time = 1000;
  let reduced = false;
  const nav = { userActivation: { isActive: true }, vibrate(pattern) { assert.equal(this, nav); calls.push(pattern); return true; } };
  const doc = { visibilityState: 'visible' };
  const win = { navigator: nav, matchMedia: () => ({ matches: reduced }), localStorage: { getItem: key => preferences.get(key), setItem: (key, value) => preferences.set(key, value) } };
  return { calls, nav, doc, win, create: () => createHaptics({ win, doc, now: () => time }), advance(ms) { time += ms; }, reduce(value) { reduced = value; } };
}

test('振動は選択より判定を優先し、連打で判定のパターンを途切れさせない', () => {
  const d = hapticDevice();
  const h = d.create();
  assert.equal(h.trigger(), true);
  assert.equal(h.trigger(), false);
  assert.equal(h.trigger('success'), true);
  assert.equal(h.trigger(), false);
  assert.equal(h.trigger('error'), false);
  d.advance(200);
  assert.equal(h.trigger('error'), true);
  assert.deepEqual(d.calls, [[8], [16, 35, 22], [24, 40, 24]]);
});

test('入力完了の振動は正解の振動と区別し、直後の正解を妨げない', () => {
  const d = hapticDevice();
  const h = d.create();
  h.trigger();
  assert.equal(h.trigger('ready'), true);
  assert.equal(h.trigger('success'), true);
  assert.equal(h.trigger('ready'), false);
  d.advance(200);
  assert.equal(h.trigger('complete'), true);
  assert.deepEqual(d.calls, [[8], [6, 25, 6], [16, 35, 22], [18, 35, 18, 35, 30]]);
});

test('会話の連打をまとめ、ページ送りや章の完了は弱い振動で中断しない', () => {
  const d = hapticDevice();
  const h = d.create();
  assert.equal(h.trigger('dialogue'), true);
  assert.equal(h.trigger('dialogue'), false);
  assert.equal(h.trigger('pageTurn'), true);
  assert.equal(h.trigger('paper'), false);
  assert.equal(h.trigger('complete'), true);
  assert.equal(h.trigger('success'), false);
  d.advance(220);
  assert.equal(h.trigger('paper'), true);
  assert.deepEqual(d.calls, [[6], [12, 32, 8], [18, 35, 18, 35, 30], [10, 18, 5]]);
});

test('非対応・API拒否・例外でも振動は操作を中断せず、再試行を予約しない', () => {
  assert.equal(createHaptics({ win: {}, doc: {} }).trigger(), false);
  const d = hapticDevice();
  d.nav.vibrate = () => false;
  const h = d.create();
  assert.equal(h.trigger(), false);
  d.nav.vibrate = () => { throw new Error('Blocked'); };
  assert.equal(h.trigger(), false);
  assert.doesNotThrow(() => h.cancel());
});

test('動きを減らす設定・非表示・ユーザー操作外では振動しない', () => {
  const d = hapticDevice();
  const h = d.create();
  d.reduce(true);
  assert.equal(h.trigger(), false);
  d.reduce(false);
  d.doc.visibilityState = 'hidden';
  assert.equal(h.trigger(), false);
  d.doc.visibilityState = 'visible';
  d.nav.userActivation.isActive = false;
  assert.equal(h.trigger(), false);
  assert.deepEqual(d.calls, []);
});

test('振動をオフにすると停止し、端末設定を次の起動にも引き継ぐ', () => {
  const d = hapticDevice();
  const h = d.create();
  h.trigger();
  h.setEnabled(false);
  assert.equal(h.trigger('success'), false);
  assert.equal(d.create().enabled, false);
  assert.deepEqual(d.calls, [[8], 0]);
  h.setEnabled(true);
  assert.equal(h.trigger(), true);
  h.cancel();
  assert.deepEqual(d.calls, [[8], 0, [8], 0]);
  assert.equal(d.create().enabled, true);
});

test('保存領域が制限されても振動のオン・オフはそのセッションで使える', () => {
  const d = hapticDevice();
  Object.defineProperty(d.win, 'localStorage', { get() { throw new Error('Storage blocked'); } });
  const h = d.create();
  h.setEnabled(false);
  assert.equal(h.trigger(), false);
  h.setEnabled(true);
  assert.equal(h.trigger(), true);
});

function target(extra = {}) {
  const handlers = new Map();
  return Object.assign({
    addEventListener(name, fn) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(fn); },
    removeEventListener(name, fn) { handlers.get(name)?.delete(fn); },
    emit(type, data = {}) { for (const fn of handlers.get(type) ?? []) fn({ type, pointerId: 1, pointerType: 'touch', clientX: 200, clientY: 200, preventDefault() {}, stopPropagation() {}, ...data }); },
    count() { return [...handlers.values()].reduce((n, values) => n + values.size, 0); },
  }, extra);
}
function viewer(reduced = false) {
  const stage = target({ classList: { toggle() {} }, getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 400 }) });
  const animations = [];
  const image = target({ style: {}, naturalWidth: 400, naturalHeight: 400, getBoundingClientRect: stage.getBoundingClientRect,
    animate(frames, options) { animations.push({ frames, options }); return { finished: Promise.resolve(), cancel() {} }; },
  });
  const win = target();
  const pages = [];
  const label = {};
  const panel = { querySelector: selector => ({ '.image-viewer-stage': stage, '.puzzle-full-image': image, '[data-zoom-label]': label })[selector] ?? null };
  const controller = bindImageViewer(panel, { win, motion: () => reduced, onPage: delta => pages.push(delta) });
  return { stage, image, win, pages, controller, animations, label };
}

test('未入力・入力途中・複数選択の過不足を、正解データを使わず案内する', () => {
  assert.equal(answerReadiness({ type: 'text' }, '   ').ready, false);
  assert.equal(answerReadiness({ type: 'fields', fields: [{}, {}] }, ['ハナ', '']).message, 'あと1つの空欄を入力・選択してください。');
  assert.equal(answerReadiness({ answerSlots: 3 }, ['8', '', '↙']).ready, false);
  const multiple = { type: 'multiple', selectionCount: 2 };
  assert.equal(answerReadiness(multiple, ['a']).message, 'あと1つ選んでください。');
  assert.equal(answerReadiness(multiple, ['a', 'b']).ready, true);
  assert.equal(answerReadiness(multiple, ['a', 'b', 'c']).ready, false);
  assert.equal(answerReadiness({ type: 'fields', fields: [{}, {}] }, ['００３', 'ハナ']).ready, true);
});
test('日本語変換中・変換確定直後のEnterを送信として扱わない', () => {
  assert.equal(isComposingSubmit({}, true, null), true);
  assert.equal(isComposingSubmit({ isComposing: true }, false, null), true);
  assert.equal(isComposingSubmit({ keyCode: 229 }, false, null), true);
  assert.equal(isComposingSubmit({}, false, 1000, 1050), true);
  assert.equal(isComposingSubmit({}, false, 1000, 1300), false);
  assert.equal(isComposingSubmit({}, false, null, 0), false);
});
test('画像の倍率と移動量を図の縦横比に合わせて制限する', () => {
  const view = { width: 400, height: 600 };
  assert.deepEqual(constrainImageTransform(view, { width: 800, height: 400 }, { scale: 2, x: 999, y: 999 }), { scale: 2, x: 200, y: 0 });
  assert.deepEqual(constrainImageTransform(view, { width: 800, height: 400 }, { scale: .5, x: -999, y: 999 }), { scale: 1, x: 0, y: 0 });
  assert.equal(constrainImageTransform(view, { width: 800, height: 400 }, { scale: 10, x: 0, y: 0 }).scale, 4);
});
test('等倍の横スワイプだけ資料を切り替え、短い移動・縦移動・キャンセルを無視する', () => {
  const h = viewer();
  for (const [type, x, y] of [['pointerup', 100, 200], ['pointerup', 190, 200], ['pointerup', 140, 390], ['pointercancel', 100, 200]]) {
    h.stage.emit('pointerdown', { clientX: 300, clientY: 200 });
    // Second gesture is deliberately shorter than the 44px threshold.
    if (x === 190) { h.stage.emit('pointercancel'); h.stage.emit('pointerdown', { clientX: 200, clientY: 200 }); }
    h.stage.emit(type, { clientX: x, clientY: y });
  }
  assert.deepEqual(h.pages, [1]);
  h.controller.dispose();
});
test('拡大中はドラッグで移動でき、資料を切り替えない', () => {
  const h = viewer();
  h.controller.zoom(1);
  assert.equal(h.label.textContent, '200%');
  h.stage.emit('pointerdown');
  h.stage.emit('pointermove', { clientX: 320 });
  h.stage.emit('pointerup', { clientX: 320 });
  assert.match(h.image.style.transform, /translate\(120px, 0px\) scale\(2\)/);
  assert.deepEqual(h.pages, []);
  h.controller.zoom(0);
  assert.equal(h.controller.scale, 1);
  assert.match(h.image.style.transform, /translate\(0px, 0px\)/);
  h.controller.dispose();
});
test('2本指でピンチでき、片指を離してもスワイプと誤判定しない', () => {
  const h = viewer();
  h.stage.emit('pointerdown', { clientX: 100 });
  h.stage.emit('pointerdown', { pointerId: 2, clientX: 300, isPrimary: false });
  h.stage.emit('pointermove', { pointerId: 2, clientX: 400 });
  assert.equal(h.controller.scale, 1.5);
  h.stage.emit('pointerup', { pointerId: 2, clientX: 400 });
  h.stage.emit('pointermove', { clientX: 0 });
  h.stage.emit('pointerup', { clientX: 0 });
  assert.deepEqual(h.pages, []);
  h.controller.dispose();
});
test('資料の読み込みで倍率をリセットし、閉じるとイベントをすべて解除する', () => {
  const h = viewer();
  h.controller.zoom(2);
  h.image.emit('load');
  assert.equal(h.controller.scale, 1);
  assert.ok(h.stage.count() > 0);
  h.controller.dispose();
  assert.equal(h.stage.count() + h.image.count() + h.win.count(), 0);
});
test('動きを減らす設定でもズーム操作は使え、アニメーションだけ省略する', () => {
  const h = viewer(true);
  h.controller.zoom(1);
  h.controller.revealFrom({ left: 20, top: 20, width: 40, height: 40 });
  assert.equal(h.controller.scale, 2);
  assert.equal(h.animations.length, 0);
  h.controller.dispose();
});

test('ダブルタップで2倍と等倍を切り替え、ホイールでも倍率を変えられる', () => {
  const h = viewer();
  for (let n = 0; n < 2; n++) { h.stage.emit('pointerdown'); h.stage.emit('pointerup'); }
  assert.equal(h.controller.scale, 2);
  for (let n = 0; n < 2; n++) { h.stage.emit('pointerdown'); h.stage.emit('pointerup'); }
  assert.equal(h.controller.scale, 1);
  h.stage.emit('wheel', { deltaY: -100 });
  assert.equal(h.controller.scale, 1.2);
  h.controller.dispose();
});

function sheet(onThreshold = () => {}) {
  let closes = 0;
  let busy = false;
  const animations = [];
  const style = { removeProperty(key) { delete this[key]; } };
  const classes = new Set();
  const panel = target({ open: true, inert: false, scrollTop: 0, style, getBoundingClientRect: () => ({ height: 400 }),
    classList: { toggle(name, value) { if (value) classes.add(name); else classes.delete(name); } },
    animate(frames) { animations.push(frames); return { finished: Promise.resolve(), cancel() {} }; },
  });
  const header = { closest: selector => selector === '.panel-header' ? header : null };
  const body = { closest: () => null };
  const controller = bindSheetDismiss(panel, { onDismiss: () => { closes++; }, canDismiss: () => !busy, motion: () => true, onThreshold });
  return { panel, header, body, style, controller, animations, get ready() { return classes.has('dismiss-ready'); }, get closes() { return closes; }, busy(value) { busy = value; },
    event(type, data = {}) { panel.emit(type, { target: header, timeStamp: 0, ...data }); },
  };
}

test('閉じられる位置を一度だけ通知し、引き戻しやキャンセルで取っ手を元に戻す', () => {
  let ticks = 0;
  const h = sheet(() => { ticks++; });
  h.event('pointerdown');
  h.event('pointermove', { clientY: 300 });
  assert.equal(h.ready, true);
  h.event('pointermove', { clientY: 240 });
  assert.equal(h.ready, false);
  h.event('pointermove', { clientY: 320 });
  assert.equal(ticks, 1);
  h.event('pointercancel', { clientY: 320 });
  assert.equal(h.ready, false);
  assert.equal(h.closes, 0);
  h.controller.dispose();
});

test('拡大・移動した画像も元の図へ縮小し、動きを減らす設定では省略する', async () => {
  const h = viewer();
  h.controller.zoom(1);
  assert.equal(await h.controller.dismissTo({ left: 20, top: 30, width: 40, height: 60 }), true);
  const exit = h.animations.at(-1);
  assert.match(exit.frames[0].transform, /scale\(2\)/);
  assert.match(exit.frames[1].transform, /translate\(-160px, -140px\) scale\(0.1\)/);
  h.controller.dispose();
  const reduced = viewer(true);
  assert.equal(reduced.controller.dismissTo({ left: 20, top: 30, width: 40, height: 60 }), null);
  assert.equal(reduced.animations.length, 0);
  reduced.controller.dispose();
});

test('パネル上端を十分引き下げると閉じ、処理中は閉じない', () => {
  const h = sheet();
  h.event('pointerdown'); h.event('pointermove', { clientY: 300 }); h.event('pointerup', { clientY: 300, timeStamp: 500 });
  assert.equal(h.closes, 1);
  h.busy(true);
  h.event('pointerdown'); h.event('pointermove', { clientY: 400 }); h.event('pointerup', { clientY: 400, timeStamp: 100 });
  assert.equal(h.closes, 1);
  h.controller.dispose();
  assert.equal(h.panel.count(), 0);
});
test('引き下げが短い場合・キャンセル時は戻り、本文のスクロールは妨げない', () => {
  const h = sheet();
  h.event('pointerdown'); h.event('pointermove', { clientY: 220 }); h.event('pointerup', { clientY: 220, timeStamp: 500 });
  assert.equal(h.closes, 0);
  assert.equal(h.style.transform, undefined);
  let stopped = 0;
  h.event('click', { preventDefault() { stopped++; }, stopPropagation() { stopped++; } });
  assert.equal(stopped, 2, 'ドラッグ後のclickで誤って閉じない');
  h.event('pointerdown', { target: h.body }); h.event('pointermove', { clientY: 400 }); h.event('pointerup', { clientY: 400, timeStamp: 500 });
  assert.equal(h.closes, 0);
  h.event('pointerdown'); h.event('pointermove', { clientY: 400 }); h.event('pointercancel', { clientY: 400, timeStamp: 500 });
  assert.equal(h.closes, 0);
  assert.equal(h.style.transform, undefined);
  h.controller.dispose();
});
test('上端の短いフリックは閉じ、横方向・スクロール途中・複数指は閉じない', () => {
  const h = sheet();
  h.event('pointerdown'); h.event('pointermove', { clientY: 240 }); h.event('pointerup', { clientY: 240, timeStamp: 40 });
  assert.equal(h.closes, 1);
  h.event('pointerdown'); h.event('pointermove', { clientX: 300, clientY: 210 }); h.event('pointerup', { clientX: 300, clientY: 400, timeStamp: 500 });
  assert.equal(h.closes, 1);
  h.panel.scrollTop = 20;
  h.event('pointerdown'); h.event('pointermove', { clientY: 400 }); h.event('pointerup', { clientY: 400, timeStamp: 500 });
  assert.equal(h.closes, 1);
  h.panel.scrollTop = 0;
  h.event('pointerdown'); h.event('pointermove', { clientY: 300 }); h.event('pointerdown', { pointerId: 2, isPrimary: false }); h.event('pointerup', { clientY: 400, timeStamp: 500 });
  assert.equal(h.closes, 1);
  h.controller.dispose();
});


test('上端を横や上へドラッグした後のclickで誤って閉じない', () => {
  for (const move of [{ clientX: 280, clientY: 200 }, { clientX: 200, clientY: 140 }]) {
    const h = sheet();
    h.event('pointerdown'); h.event('pointermove', move); h.event('pointerup', { ...move, timeStamp: 300 });
    let prevented = false;
    h.event('click', { preventDefault() { prevented = true; }, stopPropagation() {} });
    assert.equal(h.closes, 0);
    assert.equal(prevented, true);
    h.controller.dispose();
  }
});
