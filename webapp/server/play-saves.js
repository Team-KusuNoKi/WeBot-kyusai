const MAX_BODY_BYTES = 512 * 1024;
const SCENARIO_ID = 'november-kyusai-v4';
const encoder = new TextEncoder();
const ACTIONS = new Set(['create', 'load', 'save', 'delete']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

class ApiError extends Error {
  constructor(status, error, message, extra = {}) {
    super(message);
    Object.assign(this, { status, error, extra });
  }
}

function response(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function invalid(message = '保存データの形式が正しくありません。') {
  throw new ApiError(400, 'invalid_request', message);
}

// Read with a hard byte bound even when Content-Length is absent or inaccurate.
async function readBody(request) {
  if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'unsupported_media_type', 'JSON形式で送信してください。');
  }
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > MAX_BODY_BYTES) throw new ApiError(413, 'too_large', '保存データが大きすぎます。');
  const reader = request.body?.getReader();
  if (!reader) invalid();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ApiError(413, 'too_large', '保存データが大きすぎます。');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { invalid('送信データを読み取れませんでした。'); }
}

function validateJson(value, depth = 0, budget = { count: 0 }) {
  if (++budget.count > 45000 || depth > 16) invalid();
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { if (value.length > 32768) invalid(); return; }
  if (typeof value === 'number') { if (!Number.isFinite(value)) invalid(); return; }
  if (typeof value !== 'object') invalid();
  if (Array.isArray(value)) {
    if (value.length > 5000) invalid();
    for (const item of value) validateJson(item, depth + 1, budget);
  } else {
    const entries = Object.entries(value);
    if (entries.length > 1000) invalid();
    for (const [key, item] of entries) {
      if (['__proto__', 'prototype', 'constructor'].includes(key) || key.length > 100) invalid();
      validateJson(item, depth + 1, budget);
    }
  }
}

function validateProgress(state, view) {
  if (!isObject(state) || ![1, 2].includes(state.version)
    || typeof state.selected !== 'string' || !state.selected || state.selected.length > 80
    || !Array.isArray(state.solved) || !state.solved.every(id => typeof id === 'string' && id.length <= 80)
    || !isObject(state.branches) || !isObject(state.hints) || !Array.isArray(state.combinations)
    || !state.combinations.every(id => typeof id === 'string' && id.length <= 80)
    || !Array.isArray(state.messages) || !isObject(view)) invalid();
  for (const message of state.messages) {
    if (!isObject(message) || typeof message.text !== 'string' || typeof message.speaker !== 'string'
      || !['dialogue', 'answer', 'error', 'success'].includes(message.kind)) invalid();
  }
  validateJson(state);
  validateJson(view);
}

function validatePayload(body, env) {
  if (!isObject(body) || !ACTIONS.has(body.action)) invalid();
  // This is intentionally before configuration/rate-limit/database access.
  if (body.code === '000000') throw new ApiError(400, 'debug_code', '000000は保存しないデバッグ専用番号です。');
  if (body.scenarioId !== (env.PLAY_SAVE_SCENARIO_ID || SCENARIO_ID)) invalid('この作品の保存データではありません。');
  if (body.action === 'create') {
    if (typeof body.creationId !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(body.creationId)) invalid();
    if (body.code !== undefined) invalid();
  } else if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) invalid('再開番号は数字6桁で入力してください。');
  if (['save', 'delete'].includes(body.action) && (!Number.isSafeInteger(body.revision) || body.revision < 1)) invalid();
  if (body.action === 'load' && body.sinceRevision !== undefined
    && (!Number.isSafeInteger(body.sinceRevision) || body.sinceRevision < 0)) invalid();
  if (['create', 'save'].includes(body.action)) validateProgress(body.state, body.view);
}

async function signer(secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return async text => new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(text)));
}

const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

function envelope(row, code) {
  return {
    code, revision: row.revision, updatedAt: row.updated_at,
    state: JSON.parse(row.state_json), view: JSON.parse(row.view_json),
  };
}

const notFound = () => { throw new ApiError(404, 'not_found', 'この番号の進行記録が見つかりません。番号を確認してください。'); };
const activeRow = row => row && !row.deleted_at;
const deletedRetry = (row, body) => row?.deleted_at && body.action === 'delete' && row.revision === body.revision + 1;
const deletedEnvelope = (row, code) => ({ code, revision: row.revision, updatedAt: row.updated_at, deleted: true });

async function rateCount(db, key, kind, now, windowMs) {
  const start = Math.floor(now / windowMs) * windowMs;
  const row = await db.prepare('SELECT attempts FROM play_save_rate_limits WHERE bucket_key = ? AND window_start = ? AND kind = ?')
    .bind(key, start, kind).first();
  return { count: row?.attempts ?? 0, start, retryAfter: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) };
}

async function incrementRate(db, key, kind, now, windowMs, max) {
  const start = Math.floor(now / windowMs) * windowMs;
  const result = await db.batch([
    db.prepare('DELETE FROM play_save_rate_limits WHERE rowid IN (SELECT rowid FROM play_save_rate_limits WHERE expires_at < ? LIMIT 100)').bind(now),
    db.prepare(`INSERT INTO play_save_rate_limits (bucket_key, window_start, kind, attempts, expires_at) VALUES (?, ?, ?, 1, ?)
      ON CONFLICT (bucket_key, window_start, kind) DO UPDATE SET attempts = MIN(attempts + 1, ?)`)
      .bind(key, start, kind, start + windowMs, max + 1),
    db.prepare('SELECT attempts FROM play_save_rate_limits WHERE bucket_key = ? AND window_start = ? AND kind = ?').bind(key, start, kind),
  ]);
  return result[2].results[0].attempts;
}

function rateLimited(retryAfter) {
  throw new ApiError(429, 'rate_limited', '入力回数が多いため、しばらく待ってからもう一度お試しください。', { retryAfter });
}

// Deterministic from the secret + creationId so an uncertain create response can be recovered
// without storing the original six-digit code. Rejection sampling avoids modulo bias.
async function allocatedCode(sign, scenarioId, creationId, nonce) {
  for (let sample = 0; sample < 32; sample++) {
    const bytes = await sign(`allocate:${scenarioId}:${creationId}:${nonce}:${sample}`);
    const value = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
    if (value < Math.floor(2 ** 32 / 999999) * 999999) return String(value % 999999 + 1).padStart(6, '0');
  }
  throw new ApiError(503, 'allocation_failed', '番号を発行できませんでした。もう一度お試しください。');
}

async function createSave(db, body, sign, now, ipKey) {
  const creationHash = hex(await sign(`creation:${body.scenarioId}:${body.creationId}`));
  const existing = await db.prepare('SELECT * FROM play_saves WHERE scenario_id = ? AND creation_hash = ?')
    .bind(body.scenarioId, creationHash).first();
  if (existing) {
    if (!activeRow(existing)) throw new ApiError(410, 'deleted', 'このプレイデータは削除されています。新しくはじめてください。');
    return envelope(existing, await allocatedCode(sign, body.scenarioId, body.creationId, existing.allocation_nonce));
  }
  const windowMs = 60 * 60 * 1000;
  // A venue may share one public IP. This caps bulk allocation without limiting ordinary attendance.
  const max = 1500;
  const rate = await rateCount(db, ipKey, 'create', now, windowMs);
  if (rate.count >= max) rateLimited(rate.retryAfter);
  const count = await incrementRate(db, ipKey, 'create', now, windowMs, max);
  if (count > max) rateLimited(rate.retryAfter);
  const timestamp = new Date(now).toISOString();
  for (let nonce = 0; nonce < 64; nonce++) {
    const code = await allocatedCode(sign, body.scenarioId, body.creationId, nonce);
    const codeHash = hex(await sign(`code:${body.scenarioId}:${code}`));
    const result = await db.prepare(`INSERT INTO play_saves
      (scenario_id, code_hash, creation_hash, allocation_nonce, state_json, view_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .bind(body.scenarioId, codeHash, creationHash, nonce, JSON.stringify(body.state), JSON.stringify(body.view), timestamp, timestamp).run();
    if (result.meta.changes) return { code, revision: 1, updatedAt: timestamp };
    // Also handles another request committing the same creationId concurrently.
    const winner = await db.prepare('SELECT * FROM play_saves WHERE scenario_id = ? AND creation_hash = ?')
      .bind(body.scenarioId, creationHash).first();
    if (winner) {
      if (!activeRow(winner)) throw new ApiError(410, 'deleted', 'このプレイデータは削除されています。');
      return envelope(winner, await allocatedCode(sign, body.scenarioId, body.creationId, winner.allocation_nonce));
    }
  }
  throw new ApiError(503, 'allocation_failed', '番号を発行できませんでした。しばらく待ってからお試しください。');
}

async function accessSave(db, body, sign, now, ipKey) {
  const windowMs = 10 * 60 * 1000;
  const max = 120;
  const rate = await rateCount(db, ipKey, 'failed-code', now, windowMs);
  if (rate.count >= max) rateLimited(rate.retryAfter);
  const codeHash = hex(await sign(`code:${body.scenarioId}:${body.code}`));
  let row = await db.prepare('SELECT * FROM play_saves WHERE scenario_id = ? AND code_hash = ?').bind(body.scenarioId, codeHash).first();
  if (deletedRetry(row, body)) return deletedEnvelope(row, body.code);
  if (!activeRow(row)) {
    const attempts = await incrementRate(db, ipKey, 'failed-code', now, windowMs, max);
    if (attempts >= max) rateLimited(rate.retryAfter);
    notFound();
  }
  if (body.action === 'load') {
    // 端末の revision と一致するときは進行本文を返さず、再開時の下りを小さくする。
    if (Number.isSafeInteger(body.sinceRevision) && body.sinceRevision === row.revision) {
      return { code: body.code, revision: row.revision, updatedAt: row.updated_at, unchanged: true };
    }
    return envelope(row, body.code);
  }
  // A lost successful save response may be retried. Only an exactly equal snapshot can be acknowledged.
  const stateJson = body.action === 'save' ? JSON.stringify(body.state) : null;
  const viewJson = body.action === 'save' ? JSON.stringify(body.view) : null;
  if (body.action === 'save' && body.revision < row.revision && row.state_json === stateJson && row.view_json === viewJson) {
    return { code: body.code, revision: row.revision, updatedAt: row.updated_at };
  }
  if (body.revision !== row.revision) throw new ApiError(409, 'conflict', '別の端末で進行が更新されています。', { remote: envelope(row, body.code) });
  const timestamp = new Date(now).toISOString();
  const result = body.action === 'delete'
    ? await db.prepare(`UPDATE play_saves SET state_json = NULL, view_json = NULL, deleted_at = ?, updated_at = ?, revision = revision + 1
        WHERE scenario_id = ? AND code_hash = ? AND revision = ? AND deleted_at IS NULL`)
      .bind(timestamp, timestamp, body.scenarioId, codeHash, body.revision).run()
    : await db.prepare(`UPDATE play_saves SET state_json = ?, view_json = ?, updated_at = ?, revision = revision + 1
        WHERE scenario_id = ? AND code_hash = ? AND revision = ? AND deleted_at IS NULL`)
      .bind(stateJson, viewJson, timestamp, body.scenarioId, codeHash, body.revision).run();
  if (!result.meta.changes) {
    row = await db.prepare('SELECT * FROM play_saves WHERE scenario_id = ? AND code_hash = ?').bind(body.scenarioId, codeHash).first();
    if (deletedRetry(row, body)) return deletedEnvelope(row, body.code);
    if (!activeRow(row)) notFound();
    if (body.action === 'save' && row.state_json === stateJson && row.view_json === viewJson) {
      return { code: body.code, revision: row.revision, updatedAt: row.updated_at };
    }
    throw new ApiError(409, 'conflict', '別の端末で進行が更新されています。', { remote: envelope(row, body.code) });
  }
  if (body.action === 'delete') return { code: body.code, revision: body.revision + 1, updatedAt: timestamp, deleted: true };
  return { code: body.code, revision: body.revision + 1, updatedAt: timestamp };
}

export async function handlePlaySave(request, env, { now = () => Date.now() } = {}) {
  try {
    if (request.method !== 'POST') return response({ error: 'method_not_allowed', message: 'POSTで送信してください。' }, 405, { Allow: 'POST' });
    if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') {
      throw new ApiError(403, 'forbidden', 'このページから操作してください。');
    }
    const body = await readBody(request);
    validatePayload(body, env);
    if (!env.PLAY_SAVES || typeof env.PLAY_SAVE_SECRET !== 'string' || env.PLAY_SAVE_SECRET.length < 32) {
      throw new ApiError(503, 'unavailable', 'オンライン保存の準備ができていません。しばらく待ってからお試しください。');
    }
    const sign = await signer(env.PLAY_SAVE_SECRET);
    const ipKey = hex(await sign(`rate:${request.headers.get('cf-connecting-ip') || 'unknown'}`));
    const data = body.action === 'create'
      ? await createSave(env.PLAY_SAVES, body, sign, now(), ipKey)
      : await accessSave(env.PLAY_SAVES, body, sign, now(), ipKey);
    return response(data);
  } catch (error) {
    if (error instanceof ApiError) return response({ error: error.error, message: error.message, ...error.extra }, error.status,
      error.extra.retryAfter ? { 'Retry-After': String(error.extra.retryAfter) } : {});
    // Never log the request, number, secret, or progress. DB failures preserve client-side progress.
    return response({ error: 'unavailable', message: 'オンライン保存に接続できません。端末の記録を保ったまま、後でもう一度お試しください。' }, 503);
  }
}
