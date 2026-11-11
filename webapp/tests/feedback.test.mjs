import test from 'node:test';
import assert from 'node:assert/strict';
import { animateEmphasis, toggleDisclosure, animateCombination, copyWithFeedback } from '../dist/feedback.js';

function animated(extra = {}) {
  const animations = [];
  return Object.assign({ animations,
    animate(frames, options) {
      let finish, reject;
      const animation = { frames, options, finished: new Promise((resolve, fail) => { finish = resolve; reject = fail; }),
        cancelled: false, finish() { finish(); }, cancel() { this.cancelled = true; reject(new Error('cancelled')); } };
      animations.push(animation);
      return animation;
    },
  }, extra);
}

test('コピーは成功後だけチェックと振動を出し、失敗では再試行できる', async () => {
  let successes = 0;
  const icon = animated();
  const button = { disabled: false, innerHTML: 'copy', attributes: {}, setAttribute(k, v) { this.attributes[k] = v; }, querySelector: () => icon };
  const message = {};
  const options = { code: '001234', button, message, checkIcon: 'check', copyIcon: 'copy', isCurrent: () => true,
    onSuccess() { successes++; }, writeText: async code => assert.equal(code, '001234') };
  await copyWithFeedback(options);
  assert.ok(button.innerHTML.startsWith('check'));
  assert.equal(message.textContent, 'コピーしました');
  assert.equal(successes, 1);
  assert.equal(button.disabled, false);
  await copyWithFeedback({ ...options, writeText: async () => { throw new Error('denied'); } });
  assert.ok(button.innerHTML.startsWith('copy'));
  assert.match(message.textContent, /コピーできませんでした/);
  assert.equal(successes, 1);
  assert.equal(button.disabled, false);
});

test('コピー完了前に別パネルや別セッションへ移ると古い成功通知を出さない', async () => {
  let finish;
  let current = true;
  const button = { disabled: false, innerHTML: 'copy' };
  const message = {};
  const pending = copyWithFeedback({ code: '001234', button, message, isCurrent: () => current,
    writeText: () => new Promise(resolve => { finish = resolve; }), onSuccess: () => assert.fail('古い完了通知') });
  assert.equal(button.disabled, true);
  current = false;
  finish();
  await pending;
  assert.equal(button.innerHTML, 'copy');
  assert.equal(message.textContent, undefined);
});

test('開閉を連打しても履歴本文を隠したままにせず、最後の操作を反映する', async t => {
  const oldStyle = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ paddingTop: '4px', paddingBottom: '4px' });
  t.after(() => { globalThis.getComputedStyle = oldStyle; });
  const body = { inert: false };
  const summary = { getBoundingClientRect: () => ({ height: 44 }) };
  const details = animated({ open: false, offsetHeight: 200, clientHeight: 198,
    getBoundingClientRect() { return { height: this.open ? 200 : 54 }; },
    querySelector: selector => selector === 'summary' ? summary : body });
  assert.equal(toggleDisclosure(details), true);
  assert.equal(details.open, true);
  assert.equal(toggleDisclosure(details), true);
  assert.equal(body.inert, true);
  assert.equal(details.animations[0].cancelled, true);
  assert.equal(details.animations[1].frames[1].height, '54px');
  toggleDisclosure(details);
  details.animations[2].finish();
  await Promise.resolve();
  assert.equal(details.open, true);
  assert.equal(body.inert, false);
  toggleDisclosure(details);
  details.animations[3].finish();
  await Promise.resolve();
  assert.equal(details.open, false);
  assert.equal(body.inert, false);
  // Native details toggles remain available when reduced motion is enabled.
  assert.equal(toggleDisclosure(details, true), false);
});

test('動きを減らす設定では組み合わせや強調に待ち時間を入れない', () => {
  const cards = [animated(), animated()];
  assert.equal(animateCombination(cards, true), null);
  animateEmphasis(cards[0], true);
  assert.equal(cards[0].animations.length, 0);
});

test('組み合わせは2枚を互いの方向へ動かし、キャンセルでも後処理を完了する', async () => {
  const cards = [0, 120].map(left => animated({ getBoundingClientRect: () => ({ left, width: 100 }) }));
  const pending = animateCombination(cards);
  assert.match(cards[0].animations[0].frames[1].transform, /translateX\(12px\)/);
  assert.match(cards[1].animations[0].frames[1].transform, /translateX\(-12px\)/);
  cards[0].animations[0].cancel();
  cards[1].animations[0].finish();
  await pending;
  assert.ok(cards.every(card => card.animations[0].cancelled));
});
