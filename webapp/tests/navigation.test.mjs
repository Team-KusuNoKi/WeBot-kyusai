import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverlayHistory } from '../dist/navigation.js';

function browser(seed = [{ route: 'app' }]) {
  const stack = structuredClone(seed);
  const jobs = [];
  let index = stack.length - 1;
  let handler;
  const win = {
    history: {
      get state() { return stack[index]; },
      pushState(state) { stack.splice(++index); stack.push(state); },
      back() { jobs.push(() => { if (index > 0) { index--; handler?.({ state: stack[index] }); } }); },
      forward() { jobs.push(() => { if (index < stack.length - 1) { index++; handler?.({ state: stack[index] }); } }); },
    },
    addEventListener(name, fn) { if (name === 'popstate') handler = fn; },
    removeEventListener(name, fn) { if (handler === fn) handler = null; },
  };
  return { win, stack, get index() { return index; }, async flush() { for (let n = 0; n < 12; n++) { jobs.shift()?.(); await Promise.resolve(); } } };
}

test('Back closes the top surface and re-arms only while another surface remains', async () => {
  const b = browser();
  const layers = ['composer', 'image'];
  const closed = [];
  const navigation = createOverlayHistory(b.win, () => { closed.push(layers.pop()); navigation.sync(layers.length); });
  navigation.sync(true);
  assert.equal(b.stack.length, 2);
  b.win.history.back(); await b.flush();
  assert.deepEqual(closed, ['image']);
  assert.equal(b.index, 1);
  b.win.history.back(); await b.flush();
  assert.deepEqual(closed, ['image', 'composer']);
  assert.equal(b.index, 0);
  navigation.dispose();
});
test('Closing with a UI button removes the temporary entry without closing another surface', async () => {
  const b = browser();
  let backs = 0;
  const navigation = createOverlayHistory(b.win, () => backs++);
  navigation.sync(true); navigation.sync(false); await b.flush();
  assert.equal(backs, 0);
  assert.equal(b.index, 0);
  b.win.history.forward(); await b.flush();
  assert.equal(b.index, 0, 'stale Forward entries do not reopen hidden surfaces');
  navigation.dispose();
});
test('Closing and immediately opening another panel during history.back does not lose the new panel', async () => {
  const b = browser();
  let backs = 0;
  const navigation = createOverlayHistory(b.win, () => backs++);
  navigation.sync(true); navigation.sync(false); navigation.sync(true);
  await b.flush();
  assert.equal(backs, 0);
  assert.equal(b.index, 1);
  assert.equal(b.stack.length, 2);
  navigation.dispose();
});
test('Reload on a temporary entry cleans it up instead of accumulating another entry', async () => {
  const b = browser([{ route: 'app' }, { route: 'app', __webbotOverlay: 'november-kyusai' }]);
  let backs = 0;
  const navigation = createOverlayHistory(b.win, () => backs++);
  navigation.sync(false); await b.flush();
  assert.equal(b.index, 0);
  assert.equal(backs, 0);
  navigation.sync(true);
  assert.equal(b.stack.length, 2);
  navigation.dispose();
});
test('Asynchronous closing animations finish before remaining surfaces are re-armed', async () => {
  const b = browser();
  let finish;
  const navigation = createOverlayHistory(b.win, () => new Promise(resolve => { finish = () => { navigation.sync(true); resolve(); }; }));
  navigation.sync(true); b.win.history.back(); await b.flush();
  assert.equal(b.index, 0);
  finish(); await b.flush();
  assert.equal(b.index, 1);
  navigation.dispose();
});
test('Unavailable or restricted History APIs do not break panel controls', () => {
  createOverlayHistory({}, () => {}).sync(true);
  const navigation = createOverlayHistory({ history: { pushState() { throw Error('denied'); }, back() {} }, addEventListener() {}, removeEventListener() {} }, () => {});
  assert.doesNotThrow(() => navigation.sync(true));
  navigation.dispose();
});
