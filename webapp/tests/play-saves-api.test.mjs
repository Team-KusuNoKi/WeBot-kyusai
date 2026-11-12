import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handlePlaySave } from '../server/play-saves.js';

const schema = readFileSync(new URL('../migrations/0001_play_saves.sql', import.meta.url), 'utf8');
const secret = 'test-only-secret-with-at-least-32-characters';
const scenarioId = 'november-kyusai-v4';
const now = Date.UTC(2026, 9, 29, 0);
const state = () => ({ version: 2, selected: 'N1', solved: [], branches: {}, hints: {}, combinations: [], messages: [{ speaker: '案内人', text: '開始', kind: 'dialogue' }] });
const view = () => ({ startView: true, displayedMessages: [], isPlaying: false, selectedSymbols: [] });

// Exercise the production SQL using SQLite, with the same async binding shape as D1.
class TestD1 {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec(schema); this.calls = 0; }
  prepare(sql) {
    const db = this;
    let values = [];
    return {
      bind(...params) { values = params; return this; },
      async first() { db.calls++; return db.sqlite.prepare(sql).get(...values) ?? null; },
      async run() {
        db.calls++;
        const result = db.sqlite.prepare(sql).run(...values);
        return { success: true, meta: { changes: result.changes }, results: [] };
      },
      async all() { db.calls++; return { success: true, results: db.sqlite.prepare(sql).all(...values) }; },
    };
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.all());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  close() { this.sqlite.close(); }
}

function setup(t) {
  const db = new TestD1();
  t.after(() => db.close());
  return { PLAY_SAVES: db, PLAY_SAVE_SECRET: secret };
}

function request(body, headers = {}, method = 'POST') {
  return new Request('https://team-kusunoki.com/api/play-saves', {
    method, headers: { Origin: 'https://team-kusunoki.com', 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1', ...headers },
    ...(method === 'GET' ? {} : { body: typeof body === 'string' ? body : JSON.stringify({ scenarioId, ...body }) }),
  });
}

async function call(env, body, options = {}) {
  const result = await handlePlaySave(request(body, options.headers), env, { now: () => options.now ?? now });
  return { status: result.status, headers: result.headers, body: await result.json() };
}

const create = (env, extra = {}, options) => call(env, { action: 'create', creationId: crypto.randomUUID(), state: state(), view: view(), ...extra }, options);

test('六桁の番号を発行し、別ブラウザ相当の要求で進行と表示状態を復元する', async t => {
  const env = setup(t);
  const created = await create(env);
  assert.equal(created.status, 200);
  assert.match(created.body.code, /^\d{6}$/);
  assert.notEqual(created.body.code, '000000');
  assert.equal(created.body.revision, 1);
  assert.equal(created.body.state, undefined);
  assert.equal(created.body.view, undefined);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const loaded = await call(env, { action: 'load', code: created.body.code }, { headers: { 'CF-Connecting-IP': '192.0.2.2' } });
  assert.equal(loaded.body.code, created.body.code);
  assert.equal(loaded.body.revision, 1);
  assert.deepEqual(loaded.body.state, state());
  assert.deepEqual(loaded.body.view, view());
  const unchanged = await call(env, { action: 'load', code: created.body.code, sinceRevision: 1 });
  assert.equal(unchanged.status, 200);
  assert.equal(unchanged.body.unchanged, true);
  assert.equal(unchanged.body.revision, 1);
  assert.equal(unchanged.body.state, undefined);
  const stored = env.PLAY_SAVES.sqlite.prepare('SELECT * FROM play_saves').get();
  assert.equal(stored.code_hash.length, 64);
  assert.equal(stored.creation_hash.length, 64);
  assert.ok(!Object.values(stored).includes(created.body.code));
});

test('作成成功の応答が失われても同じcreationIdで同じ保存先を取得する', async t => {
  const env = setup(t);
  const creationId = crypto.randomUUID();
  const first = await create(env, { creationId });
  const retry = await create(env, { creationId, state: { ...state(), solved: ['N1'] } });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.code, first.body.code);
  assert.equal(retry.body.revision, first.body.revision);
  // 再取得は保存済みの進行本文を返し、送信し直した別スナップショットでは上書きしない。
  assert.deepEqual(retry.body.state, state());
  assert.equal(env.PLAY_SAVES.sqlite.prepare('SELECT COUNT(*) AS total FROM play_saves').get().total, 1);
});

test('複数作成は重複せず、D1制約も番号ハッシュと作成IDの重複を拒否する', async t => {
  const env = setup(t);
  const codes = new Set();
  for (let index = 0; index < 20; index++) {
    const result = await create(env);
    assert.equal(result.status, 200);
    assert.ok(!codes.has(result.body.code));
    codes.add(result.body.code);
  }
  const row = env.PLAY_SAVES.sqlite.prepare('SELECT * FROM play_saves LIMIT 1').get();
  assert.throws(() => env.PLAY_SAVES.sqlite.prepare(`INSERT INTO play_saves
    (scenario_id, code_hash, creation_hash, allocation_nonce, state_json, view_json, created_at, updated_at)
    VALUES (?, ?, ?, 0, '{}', '{}', '', '')`).run(scenarioId, row.code_hash, 'f'.repeat(64)), /UNIQUE/);
});

test('先頭が0の番号を数値に変換せずに読み込む', async t => {
  const env = setup(t);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`code:${scenarioId}:001234`)));
  const hash = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  env.PLAY_SAVES.sqlite.prepare(`INSERT INTO play_saves
    (scenario_id, code_hash, creation_hash, allocation_nonce, state_json, view_json, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?, ?, ?)`)
    .run(scenarioId, hash, 'a'.repeat(64), JSON.stringify(state()), JSON.stringify(view()), new Date(now).toISOString(), new Date(now).toISOString());
  const loaded = await call(env, { action: 'load', code: '001234' });
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.code, '001234');
  assert.equal((await call(env, { action: 'load', code: 1234 })).status, 400);
});

test('番号候補が使用済み・削除済みなら別番号を発行し、その再試行も復元する', async t => {
  const env = setup(t);
  const creationId = crypto.randomUUID();
  const occupied = await create(env, { creationId });
  // Retain the candidate number as a deleted reservation belonging to another creation.
  env.PLAY_SAVES.sqlite.prepare(`UPDATE play_saves SET creation_hash = ?, state_json = NULL, view_json = NULL, deleted_at = ?`)
    .run('e'.repeat(64), new Date(now).toISOString());
  const created = await create(env, { creationId });
  assert.equal(created.status, 200);
  assert.notEqual(created.body.code, occupied.body.code);
  const recovered = await create(env, { creationId });
  assert.equal(recovered.body.code, created.body.code);
  assert.equal(recovered.body.revision, created.body.revision);
  assert.equal(env.PLAY_SAVES.sqlite.prepare('SELECT allocation_nonce FROM play_saves WHERE deleted_at IS NULL').get().allocation_nonce, 1);
});

test('000000は全操作でDB参照やレート制限書込みも発生させない', async () => {
  const db = { prepare() { assert.fail('debug must not touch D1'); }, batch() { assert.fail('debug must not touch D1'); } };
  for (const action of ['create', 'load', 'save', 'delete']) {
    const result = await call({ PLAY_SAVES: db, PLAY_SAVE_SECRET: secret }, { action, code: '000000' });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'debug_code');
  }
  assert.equal((await call({}, { action: 'load', code: '000000' })).body.error, 'debug_code');
});

test('更新番号で同時更新を検出し、古い進行を上書きしない', async t => {
  const env = setup(t);
  const created = await create(env);
  const code = created.body.code;
  const changed = { ...state(), solved: ['N1'], selected: 'N2' };
  const changedView = { ...view(), startView: false, composerExpanded: true };
  const saved = await call(env, { action: 'save', code, revision: 1, state: changed, view: changedView });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, 2);
  assert.equal(saved.body.state, undefined);
  assert.equal(saved.body.view, undefined);
  const stale = await call(env, { action: 'save', code, revision: 1, state: state(), view: view() });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.remote.revision, 2);
  assert.deepEqual(stale.body.remote.state, changed);
  assert.deepEqual(stale.body.remote.view, changedView);
  const loaded = await call(env, { action: 'load', code });
  assert.equal(loaded.body.revision, 2);
  assert.deepEqual(loaded.body.state, changed);
  assert.deepEqual(loaded.body.view, changedView);
  const staleDelete = await call(env, { action: 'delete', code, revision: 1 });
  assert.equal(staleDelete.status, 409);
});

test('同じ更新の再送は成功済みの保存を返す', async t => {
  const env = setup(t);
  const created = await create(env);
  const payload = { action: 'save', code: created.body.code, revision: 1, state: { ...state(), solved: ['N1'] }, view: view() };
  const saved = await call(env, payload);
  const retry = await call(env, payload);
  assert.equal(retry.status, 200);
  assert.deepEqual(retry.body, saved.body);
});

test('削除は進行本文を除去し、番号と作成IDの予約を残す', async t => {
  const env = setup(t);
  const creationId = crypto.randomUUID();
  const created = await create(env, { creationId });
  const deleted = await call(env, { action: 'delete', code: created.body.code, revision: 1 });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deleted, true);
  const deletionRetry = await call(env, { action: 'delete', code: created.body.code, revision: 1 });
  assert.equal(deletionRetry.status, 200);
  assert.deepEqual(deletionRetry.body, deleted.body);
  assert.equal((await call(env, { action: 'load', code: created.body.code })).status, 404);
  assert.equal((await create(env, { creationId })).status, 410);
  const row = env.PLAY_SAVES.sqlite.prepare('SELECT * FROM play_saves').get();
  assert.equal(row.state_json, null);
  assert.equal(row.view_json, null);
  assert.ok(row.deleted_at);
});

test('番号の連続推測をD1で制限し、ワーカーの再作成後も制限が続く', async t => {
  const env = setup(t);
  const created = await create(env);
  let wrong = '999999';
  if (created.body.code === wrong) wrong = '999998';
  for (let index = 0; index < 119; index++) assert.equal((await call(env, { action: 'load', code: wrong })).status, 404);
  const limited = await call({ ...env }, { action: 'load', code: wrong });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '600');
  assert.equal((await call(env, { action: 'load', code: created.body.code })).status, 429);
  assert.equal((await call(env, { action: 'load', code: created.body.code }, { now: now + 600001 })).status, 200);
  assert.equal((await call(env, { action: 'load', code: created.body.code }, { headers: { 'CF-Connecting-IP': '192.0.2.2' } })).status, 200);
});

test('新規作成の大量要求を制限するが同じ作成IDの回復は許可する', async t => {
  const env = setup(t);
  const creationId = crypto.randomUUID();
  const created = await create(env, { creationId });
  env.PLAY_SAVES.sqlite.prepare("UPDATE play_save_rate_limits SET attempts = 1500 WHERE kind = 'create'").run();
  assert.equal((await create(env)).status, 429);
  const recovered = await create(env, { creationId });
  assert.equal(recovered.body.code, created.body.code);
  assert.equal(recovered.body.revision, created.body.revision);
});

test('異なるOrigin・不正形式・別作品・過大データを保存前に拒否する', async t => {
  const env = setup(t);
  const base = { action: 'create', creationId: crypto.randomUUID(), state: state(), view: view() };
  assert.equal((await call(env, base, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call(env, base, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  for (const code of ['', '12345', '1234567', '１２３４５６', 'ABC123', 123456]) assert.equal((await call(env, { action: 'load', code })).status, 400);
  assert.equal((await call(env, { ...base, scenarioId: 'other' })).status, 400);
  assert.equal((await call(env, { ...base, state: { ...state(), messages: [{ kind: 'html', speaker: 'x', text: 'x' }] } })).status, 400);
  assert.equal((await call(env, { ...base, view: JSON.parse('{"__proto__":{"polluted":true}}') })).status, 400);
  assert.equal((await call(env, { ...base, view: { text: 'x'.repeat(513 * 1024) } })).status, 413);
  assert.equal((await call(env, 'not json')).status, 400);
  assert.equal((await call(env, base, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal(env.PLAY_SAVES.calls, 0);
});

test('Content-Lengthなしのストリームも上限を超えたら中断する', async t => {
  const env = setup(t);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(' '.repeat(513 * 1024))); controller.close(); } });
  const req = new Request('https://team-kusunoki.com/api/play-saves', {
    method: 'POST', duplex: 'half', body: stream,
    headers: { Origin: 'https://team-kusunoki.com', 'Content-Type': 'application/json' },
  });
  assert.equal((await handlePlaySave(req, env)).status, 413);
  assert.equal(env.PLAY_SAVES.calls, 0);
});

test('設定不足・DB障害は保存成功を返さず、秘密や内部エラーを出さない', async t => {
  const env = setup(t);
  assert.equal((await create({})).status, 503);
  assert.equal((await create({ ...env, PLAY_SAVE_SECRET: 'short' })).status, 503);
  const failed = await create({ PLAY_SAVE_SECRET: secret, PLAY_SAVES: { prepare() { throw new Error('private database detail'); } } });
  assert.equal(failed.status, 503);
  assert.ok(!JSON.stringify(failed.body).includes('private database detail'));
  assert.equal(env.PLAY_SAVES.calls, 0);
  const method = await handlePlaySave(request(null, {}, 'GET'), env);
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('cache-control'), 'no-store');
});

test('下書きは表示状態の一部として保存・別端末へ復元でき、正解記録を変えない', async t => {
  const env = setup(t);
  const created = await create(env);
  const savedView = { ...view(), answerDrafts: { Q7: ['Ｄ', '００３'], Q8: ['ハナ', '', '畏怖', ''], N2: ['法経済学部北館'], N4: ['8', '', '↙'] } };
  const saved = await call(env, { action: 'save', code: created.body.code, revision: 1, state: state(), view: savedView });
  assert.equal(saved.status, 200);
  const loaded = await call(env, { action: 'load', code: created.body.code }, { headers: { 'CF-Connecting-IP': '192.0.2.2' } });
  assert.deepEqual(loaded.body.view.answerDrafts, savedView.answerDrafts);
  assert.deepEqual(loaded.body.state.solved, []);
});
