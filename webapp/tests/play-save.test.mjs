import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaySaveController, normalizePlayCode } from '../dist/play-save.js';

const scenarioId = 'test-scenario';
const state = { version: 2, selected: 'N1', solved: [], messages: [] };
const view = { startView: true, displayedMessages: [] };
const envelope = (changes = {}) => ({ code: '001234', revision: 1, updatedAt: '2026-10-29T00:00:00Z', state: structuredClone(state), view: structuredClone(view), ...changes });
function memoryStorage() {
  const items = new Map();
  const counts = { reads: 0, writes: 0, removes: 0 };
  return {
    items, counts,
    getItem(key) { counts.reads++; return items.get(key) ?? null; },
    setItem(key, value) { counts.writes++; items.set(key, value); },
    removeItem(key) { counts.removes++; items.delete(key); },
  };
}
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(data) });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function setup(fetchImpl, extras = {}) {
  const storage = memoryStorage();
  const calls = [];
  const statuses = [];
  const controller = createPlaySaveController({ scenarioId, storage, debounceMs: 60000, maxAutoRetries: 0,
    fetchImpl: async (url, options) => { const body = JSON.parse(options.body); calls.push(body); return fetchImpl(body, options, calls.length); },
    onStatus: value => statuses.push(value), ...extras });
  return { controller, storage, calls, statuses };
}

test('six digits preserve leading zeros, accept fullwidth digits, reject other code formats', () => {
  assert.equal(normalizePlayCode(' ００１２３４ '), '001234');
  assert.equal(normalizePlayCode('000000'), '000000');
  for (const value of ['12345', '1234567', 'abc123', '12 345', 123456, null]) assert.equal(normalizePlayCode(value), null);
});

test('new game activates only after server succeeds and stores issued code', async t => {
  const wait = deferred();
  const { controller, storage, calls } = setup(() => wait.promise);
  t.after(() => controller.dispose());
  const creating = controller.startNew(state, view);
  assert.equal(controller.getRecord(), null);
  assert.equal(storage.items.has(controller.storageKey), false);
  wait.resolve(response(envelope()));
  const created = await creating;
  assert.equal(created.code, '001234');
  assert.equal(created.pending, false);
  assert.equal(calls[0].action, 'create');
  assert.match(calls[0].creationId, /^[a-f\d-]{36}$/);
  assert.equal(JSON.parse(storage.items.get(controller.storageKey)).code, '001234');
});

test('failed creation preserves existing normal record and reuses idempotency identity', async t => {
  let fail = false;
  const { controller, storage, calls } = setup(body => {
    if (fail) throw new Error('offline');
    return response(envelope({ code: body.action === 'load' ? body.code : '005678' }));
  });
  t.after(() => controller.dispose());
  await controller.loadCode('001234');
  const saved = storage.items.get(controller.storageKey);
  fail = true;
  await assert.rejects(controller.startNew(state, view), /offline/);
  assert.equal(storage.items.get(controller.storageKey), saved);
  await assert.rejects(controller.startNew(state, view), /offline/);
  assert.equal(calls.at(-1).creationId, calls.at(-2).creationId);
  assert.equal(controller.getRecord().code, '001234');
});

test('debug entry, updates, retry, storage event and deletion make no network or storage accesses', async t => {
  const { controller, storage, calls } = setup(body => response(envelope({ code: body.code })));
  t.after(() => controller.dispose());
  await controller.loadCode('001234');
  const normalRaw = storage.items.get(controller.storageKey);
  const counts = { ...storage.counts };
  const callCount = calls.length;
  const debug = await controller.loadCode('000000');
  assert.equal(debug.code, '000000');
  controller.update({ ...state, solved: ['N1'] }, { ...view, startView: false });
  await controller.flush(); await controller.retry();
  controller.handleStorageEvent({ key: controller.storageKey, newValue: null });
  await controller.deleteCurrent();
  assert.deepEqual(storage.counts, counts);
  assert.equal(calls.length, callCount);
  assert.equal(storage.items.get(controller.storageKey), normalRaw);
});

test('entering debug invalidates an in-flight normal save response', async t => {
  const wait = deferred();
  const { controller, storage } = setup(body => body.action === 'save' ? wait.promise : response(envelope()));
  t.after(() => controller.dispose());
  await controller.loadCode('001234');
  controller.update({ ...state, solved: ['N1'] }, view);
  const sending = controller.flush();
  const rawBeforeDebug = storage.items.get(controller.storageKey);
  controller.enterDebug(state, view);
  const counts = { ...storage.counts };
  wait.resolve(response(envelope({ revision: 2 })));
  await sending;
  assert.equal(controller.getRecord().code, '000000');
  assert.equal(storage.items.get(controller.storageKey), rawBeforeDebug);
  assert.deepEqual(storage.counts, counts);
});

test('updates during a request are retained and serialized after its acknowledgement', async t => {
  const wait = deferred();
  let saves = 0;
  const { controller, calls } = setup(body => {
    if (body.action === 'load') return response(envelope());
    saves++;
    if (saves === 1) return wait.promise;
    return response(envelope({ revision: 3, state: body.state, view: body.view }));
  });
  t.after(() => controller.dispose());
  await controller.loadCode('001234');
  const firstState = { ...state, solved: ['N1'] };
  controller.update(firstState, view);
  const sending = controller.flush();
  controller.update({ ...state, solved: ['N1', 'N2'] }, view);
  wait.resolve(response(envelope({ revision: 2, state: firstState })));
  await sending;
  const sent = calls.filter(call => call.action === 'save');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].revision, 2);
  assert.deepEqual(sent[1].state.solved, ['N1', 'N2']);
  assert.equal(controller.getRecord().pending, false);
  assert.equal(controller.getRecord().revision, 3);
});

test('offline outbox survives reload and retries the stored state', async t => {
  let offline = false;
  const { controller, storage } = setup(body => {
    if (offline) throw new Error('offline');
    return response(envelope({ revision: body.action === 'save' ? 2 : 1, state: body.state ?? state, view: body.view ?? view }));
  });
  t.after(() => controller.dispose());
  await controller.loadCode('001234');
  offline = true;
  controller.update({ ...state, solved: ['N1'] }, view);
  await controller.flush();
  assert.equal(controller.getStatus().phase, 'offline');
  controller.dispose();
  let sent;
  const restored = createPlaySaveController({ scenarioId, storage, debounceMs: 60000, maxAutoRetries: 0,
    fetchImpl: async (_, options) => { sent = JSON.parse(options.body); return response(envelope({ revision: 2, state: sent.state, view: sent.view })); } });
  t.after(() => restored.dispose());
  assert.deepEqual(restored.readLocal().state.solved, ['N1']);
  await restored.retry();
  assert.equal(sent.revision, 1);
  assert.deepEqual(sent.state.solved, ['N1']);
  assert.equal(restored.getRecord().pending, false);
});

test('legacy progress remains playable offline and creates a number once online', async t => {
  let offline = true;
  const { controller, storage, calls } = setup(body => {
    if (offline) throw new Error('offline');
    return response(envelope({ state: body.state, view: body.view }));
  });
  t.after(() => controller.dispose());
  storage.items.set(`webbot:${scenarioId}`, 'legacy untouched');
  controller.adoptLegacy({ ...state, solved: ['N1'] }, view);
  await controller.flush();
  assert.equal(controller.getRecord().code, null);
  assert.equal(controller.getRecord().pending, true);
  assert.equal(controller.getStatus().phase, 'local-only');
  offline = false;
  await controller.retry();
  assert.equal(controller.getRecord().code, '001234');
  assert.equal(controller.getRecord().pending, false);
  assert.equal(calls[0].creationId, calls[1].creationId);
  assert.equal(storage.items.get(`webbot:${scenarioId}`), 'legacy untouched');
});

test('a competing tab never uploads its stale draft and resumes the cloud state and view', async t => {
  const cloud = envelope({ revision: 5, state: { ...state, solved: ['N1', 'N2'] }, view: { startView: false } });
  const { controller, storage, calls } = setup(() => response(cloud));
  t.after(() => controller.dispose());
  await controller.loadCode('001234');
  const pending = { ...controller.getRecord(), pending: true, state: { ...state, selected: 'N3' } };
  storage.items.set(controller.storageKey, JSON.stringify(pending));
  controller.update({ ...state, solved: ['N1'] }, view);
  await controller.flush();
  assert.deepEqual(calls.map(call => call.action), ['load', 'load']);
  assert.deepEqual(controller.getRecord().state, cloud.state);
  assert.deepEqual(controller.getRecord().view, cloud.view);
  assert.equal(controller.getStatus().phase, 'saved');
  assert.equal(JSON.parse(storage.items.get(controller.storageKey)).pending, false);
});

test('a server conflict automatically restores the committed snapshot, archiving unsent progress', async t => {
  const remote = envelope({ revision: 4, state: { ...state, solved: ['N2'] } });
  const resumed = [];
  const { controller, storage, calls } = setup(body => body.action === 'load' ? response(envelope())
    : response({ error: 'conflict', remote }, 409), { onCloudRestore: r => resumed.push(r) });
  t.after(() => controller.dispose());
  await controller.loadCode('001234');
  controller.update({ ...state, solved: ['N1'] }, view);
  await controller.flush();
  assert.deepEqual(calls.map(call => call.action), ['load', 'save']);
  assert.deepEqual(resumed.map(r => r.state), [remote.state]);
  assert.equal(controller.getStatus().phase, 'saved');
  assert.equal(controller.getRecord().revision, 4);
  assert.equal(controller.getConflict(), null);
  assert.ok(JSON.parse(storage.items.get(`${controller.storageKey}:archives`)).some(entry => entry.record.state.solved.includes('N1')));
});

test('reconnection retries loading a conflicting cloud save without writing either pending draft', async t => {
  let offline = false;
  const { controller, storage, calls } = setup(() => {
    if (offline) throw new Error('offline');
    return response(envelope());
  });
  t.after(() => controller.dispose());
  await controller.loadCode('001234');
  storage.items.set(controller.storageKey, JSON.stringify({ ...controller.getRecord(), pending: true, generation: 1 }));
  offline = true;
  controller.update({ ...state, solved: ['N1'] }, view);
  await controller.flush();
  assert.equal(controller.getStatus().phase, 'conflict');
  offline = false;
  await controller.retry();
  assert.equal(controller.getStatus().phase, 'saved');
  assert.deepEqual(controller.getRecord().state, state);
  assert.deepEqual(calls.map(c => c.action), ['load', 'load', 'load']);
});

test('identical server data after a lost acknowledgement is accepted without conflict', async t => {
  const { controller } = setup(body => body.action === 'load' ? response(envelope())
    : response({ error: 'conflict', remote: envelope({ revision: 2, state: body.state, view: body.view }) }, 409));
  t.after(() => controller.dispose());
  await controller.loadCode('001234');
  controller.update({ ...state, solved: ['N1'] }, view);
  await controller.flush();
  assert.equal(controller.getStatus().phase, 'saved');
  assert.equal(controller.getRecord().pending, false);
  assert.equal(controller.getRecord().revision, 2);
});

test('storage failure still allows cloud saving and reports lack of browser persistence', async t => {
  const storage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const { controller } = setup(body => response(envelope({ revision: body.action === 'save' ? 2 : 1, state: body.state ?? state, view: body.view ?? view })), { storage });
  t.after(() => controller.dispose());
  await controller.startNew(state, view);
  controller.update({ ...state, solved: ['N1'] }, view);
  await controller.flush();
  assert.equal(controller.getRecord().pending, false);
  assert.equal(controller.getStatus().storageAvailable, false);
  assert.equal(controller.getStatus().phase, 'local-only');
});

test('failed lookup preserves current save and returns a useful error', async t => {
  const { controller, storage } = setup(body => body.code === '999999' ? response({ error: 'not_found', message: 'この番号の記録が見つかりません。' }, 404) : response(envelope()));
  t.after(() => controller.dispose());
  await controller.loadCode('001234');
  const before = storage.items.get(controller.storageKey);
  await assert.rejects(controller.loadCode('999999'), /見つかりません/);
  assert.equal(storage.items.get(controller.storageKey), before);
  assert.equal(controller.getRecord().code, '001234');
});

test('identical app snapshots leave saved status and revision untouched', async t => {
  const { controller, storage, calls } = setup(() => response(envelope()));
  t.after(() => controller.dispose());
  await controller.loadCode('001234');
  const counts = { ...storage.counts };
  const saved = controller.getRecord();
  assert.deepEqual(controller.update(state, view), saved);
  await controller.flush();
  assert.deepEqual(storage.counts, counts);
  assert.equal(calls.length, 1);
  assert.equal(controller.getStatus().message, '保存済み');
});

test('leaveSession exits debug without storage access and readLocal recovers normal save', async t => {
  const { controller, storage } = setup(() => response(envelope()));
  t.after(() => controller.dispose());
  await controller.loadCode('001234');
  controller.enterDebug(state, view);
  const counts = { ...storage.counts };
  controller.leaveSession();
  assert.equal(controller.getStatus().mode, 'none');
  assert.equal(controller.getRecord(), null);
  assert.deepEqual(storage.counts, counts);
  assert.equal(controller.readLocal().code, '001234');
});

test('switching to another tab clean save restores that tab code rather than the old game', async t => {
  const { controller, storage, calls } = setup(body => response(envelope({ code: body.code, state: { ...state, selected: body.code === '005678' ? 'N2' : 'N1' } })));
  t.after(() => controller.dispose());
  await controller.loadCode('001234');
  const other = { format: 1, scenarioId, ...envelope({ code: '005678', state: { ...state, selected: 'N2' } }), pending: false, generation: 0 };
  const raw = JSON.stringify(other);
  storage.items.set(controller.storageKey, raw);
  const selected = await controller.handleStorageEvent({ key: controller.storageKey, newValue: raw });
  assert.equal(selected.code, '005678');
  assert.equal(selected.state.selected, 'N2');
  assert.equal(calls.at(-1).code, '005678');
});

test('stale-tab deletion loads the cloud save instead of deleting it', async t => {
  const { controller, storage, calls } = setup(body => response(envelope({ code: body.code })));
  t.after(() => controller.dispose());
  await controller.loadCode('001234');
  storage.items.set(controller.storageKey, JSON.stringify({ format: 1, scenarioId, ...envelope({ code: '005678' }) }));
  assert.equal(await controller.deleteCurrent(), false);
  assert.equal(controller.getStatus().phase, 'saved');
  assert.deepEqual(calls.map(c => c.action), ['load', 'load']);
});

test('request timeout rejects new creation while preserving old save', async t => {
  const { controller, storage } = setup(body => body.action === 'load' ? response(envelope()) : new Promise(() => {}), { requestTimeoutMs: 5 });
  t.after(() => controller.dispose());
  await controller.loadCode('001234');
  const raw = storage.items.get(controller.storageKey);
  await assert.rejects(controller.startNew(state, view), /タイムアウト/);
  assert.equal(storage.items.get(controller.storageKey), raw);
});

test('snapshot equality ignores JSON object key order across restore and capture', async t => {
  const { controller, calls, storage } = setup(() => response(envelope()));
  t.after(() => controller.dispose());
  await controller.loadCode('001234');
  const reversedState = Object.fromEntries(Object.entries(state).reverse());
  const reversedView = Object.fromEntries(Object.entries(view).reverse());
  const counts = { ...storage.counts };
  controller.update(reversedState, reversedView);
  await controller.flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(storage.counts, counts);
  assert.equal(controller.getStatus().phase, 'saved');
});

test('deletion needs explicit matching acknowledgement before removing the browser record', async t => {
  let deletionResponse = {};
  const { controller, storage } = setup(body => body.action === 'delete' ? response(deletionResponse) : response(envelope()));
  t.after(() => controller.dispose());
  await controller.loadCode('001234');
  const raw = storage.items.get(controller.storageKey);
  await assert.rejects(controller.deleteCurrent(), /削除の完了を確認できません/);
  assert.equal(storage.items.get(controller.storageKey), raw);
  assert.equal(controller.getRecord().code, '001234');
  deletionResponse = { deleted: true, code: '005678' };
  await assert.rejects(controller.deleteCurrent(), /削除の完了を確認できません/);
  assert.equal(storage.items.get(controller.storageKey), raw);
  deletionResponse = { deleted: true, code: '001234', revision: 2 };
  assert.equal(await controller.deleteCurrent(), true);
  assert.equal(storage.items.has(controller.storageKey), false);
  assert.equal(controller.getRecord(), null);
});

test('deletion clears a local record even when the cloud save is already missing', async t => {
  const { controller, storage } = setup(body => body.action === 'delete'
    ? response({ error: 'not_found', message: 'この番号の進行記録が見つかりません。' }, 404)
    : response(envelope()));
  t.after(() => controller.dispose());
  await controller.loadCode('001234');
  assert.equal(await controller.deleteCurrent(), true);
  assert.equal(storage.items.has(controller.storageKey), false);
  assert.equal(controller.getRecord(), null);
  assert.equal(controller.getStatus().phase, 'idle');
});
