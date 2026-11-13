// Anonymous six-digit save synchronization. Debug sessions never use persistence.
export function normalizePlayCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.normalize('NFKC').trim();
  return /^\d{6}$/.test(code) ? code : null;
}

const copy = value => value == null ? value : JSON.parse(JSON.stringify(value));
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
// 旧保存の displayedMessages 配列と、新形式の displayedCount を同じ進行として比較する。
function normalizeComparable(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (!('displayedMessages' in value) && !('displayedCount' in value)) return value;
  const next = { ...value };
  if (Array.isArray(next.displayedMessages)) {
    if (!Number.isInteger(next.displayedCount)) next.displayedCount = next.displayedMessages.length;
    delete next.displayedMessages;
  }
  return next;
}
const equal = (left, right) => canonical(normalizeComparable(left)) === canonical(normalizeComparable(right));
const identifier = () => globalThis.crypto.randomUUID();

export function createPlaySaveController(options) {
  const {
    scenarioId, fetchImpl = globalThis.fetch?.bind(globalThis), onStatus = () => {},
    onCloudRestore = () => {}, onRecord = () => {}, debounceMs = 700,
    // 入力のたびに localStorage へ全文を書かない。通信デバウンスより短く、pagehide/flush では即書きする。
    persistDebounceMs = 400,
    requestTimeoutMs = 12000, maxAutoRetries = 2,
    endpoint = '/api/play-saves',
  } = options;
  let storage = options.storage;
  if (storage === undefined) { try { storage = globalThis.localStorage; } catch { storage = null; } }
  const storageKey = `play-save:${scenarioId}`;
  const creationKey = `${storageKey}:creating`;
  const archiveKey = `${storageKey}:archives`;
  let record = null;
  let mode = 'none';
  let status = { mode, phase: 'idle', message: '' };
  let conflict = null;
  let recovery = null;
  let expectedRaw = null;
  let storageReady = Boolean(storage);
  let epoch = 0;
  let timer;
  let persistTimer;
  let retryCount = 0;
  let disposed = false;
  let flight = null;
  let abort = null;
  let creation = null;

  function setStatus(phase, message = '') {
    status = { mode, phase, message, storageAvailable: storageReady };
    onStatus(copy(status));
  }
  function read(key) {
    if (!storage) return null;
    try { return storage.getItem(key); } catch { storageReady = false; return null; }
  }
  function write(key, raw) {
    if (!storage) { storageReady = false; return false; }
    try { storage.setItem(key, raw); storageReady = true; return true; }
    catch { storageReady = false; return false; }
  }
  function remove(key) {
    if (!storage) return;
    try { storage.removeItem(key); } catch { storageReady = false; }
  }
  function validEnvelope(value, allowDebug = false) {
    return value && typeof value === 'object' && normalizePlayCode(value.code) === value.code
      && (allowDebug || value.code !== '000000') && Number.isInteger(value.revision) && value.revision >= 0
      && value.state && typeof value.state === 'object' && !Array.isArray(value.state)
      && value.view && typeof value.view === 'object' && !Array.isArray(value.view);
  }
  function validSaveAck(value) {
    return value && typeof value === 'object' && normalizePlayCode(value.code) === value.code
      && value.code !== '000000' && Number.isInteger(value.revision) && value.revision >= 0
      && typeof value.updatedAt === 'string'
      && (value.state === undefined || value.state && typeof value.state === 'object' && !Array.isArray(value.state))
      && (value.view === undefined || value.view && typeof value.view === 'object' && !Array.isArray(value.view));
  }
  function validLoadAck(value) {
    return value && typeof value === 'object' && value.unchanged === true
      && normalizePlayCode(value.code) === value.code && Number.isInteger(value.revision) && value.revision >= 0;
  }
  function parseRecord(raw) {
    try {
      const value = JSON.parse(raw);
      const legacy = value?.code === null && typeof value.creationId === 'string' && value.state && typeof value.state === 'object' && value.view && typeof value.view === 'object';
      return value?.format === 1 && value.scenarioId === scenarioId && (validEnvelope(value) || legacy) ? value : null;
    } catch { return null; }
  }
  function localEnvelope(value) {
    return {
      format: 1, scenarioId, code: value.code, revision: value.revision,
      updatedAt: value.updatedAt ?? null, state: copy(value.state), view: copy(value.view),
      ...(value.creationId ? { creationId: value.creationId } : {}),
      pending: Boolean(value.pending), generation: Number.isInteger(value.generation) ? value.generation : 0,
    };
  }
  function archive(value, reason) {
    if (!value || mode === 'debug') return;
    let entries = [];
    try { entries = JSON.parse(read(archiveKey) ?? '[]'); } catch { /* preserve latest below */ }
    if (!Array.isArray(entries)) entries = [];
    entries.push({ id: identifier(), reason, archivedAt: new Date().toISOString(), record: copy(value) });
    write(archiveKey, JSON.stringify(entries));
  }
  function raiseConflict(remote, source) {
    cancelOperations();
    conflict = { local: copy(record), remote: copy(remote), source };
    archive(record, `${source}-local`);
    if (remote) archive(remote, `${source}-remote`);
    setStatus('conflict', '保存された進行を読み込んでいます。');
    return recoverCloud();
  }
  function persist({ replace = false } = {}) {
    if (mode !== 'normal' || !record || disposed) return false;
    const actual = read(storageKey);
    if (!replace && storageReady && actual !== expectedRaw) {
      raiseConflict(parseRecord(actual), 'storage');
      return false;
    }
    const raw = JSON.stringify(record);
    if (write(storageKey, raw)) { expectedRaw = raw; return true; }
    return false;
  }
  function notify() { onRecord(copy(record)); }
  function cancelOperations() {
    epoch++;
    clearTimeout(timer);
    clearTimeout(persistTimer);
    persistTimer = undefined;
    abort?.abort();
    abort = null;
    flight = null;
    recovery = null;
    retryCount = 0;
  }
  function schedulePersist(delay = persistDebounceMs) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
    if (!disposed && mode === 'normal' && record && !conflict) {
      if (delay <= 0) {
        persist();
        return;
      }
      persistTimer = setTimeout(() => {
        persistTimer = undefined;
        if (!disposed && mode === 'normal' && record && !conflict) persist();
      }, delay);
      persistTimer.unref?.();
    }
  }
  function schedule(delay = debounceMs) {
    clearTimeout(timer);
    if (!disposed && mode === 'normal' && record?.pending && !conflict) {
      timer = setTimeout(() => { timer = undefined; void flush(); }, delay);
      timer.unref?.();
    }
  }
  async function request(payload, operationEpoch) {
    if (!fetchImpl) throw new Error('通信機能を利用できません。');
    const controller = new AbortController();
    abort = controller;
    let timeout;
    try {
      const response = await Promise.race([
        fetchImpl(endpoint, {
          method: 'POST', credentials: 'same-origin', cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, scenarioId }), signal: controller.signal,
        }),
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            const error = new Error('通信がタイムアウトしました。');
            error.name = 'TimeoutError'; reject(error);
          }, requestTimeoutMs);
        }),
      ]);
      if (operationEpoch !== epoch || disposed) throw Object.assign(new Error('操作を切り替えました。'), { cancelled: true });
      let data;
      try { data = await response.json(); } catch { throw new Error('保存サーバーの応答を確認できません。'); }
      if (!response.ok) throw Object.assign(new Error(data.message || '保存サーバーに接続できません。'), { status: response.status, data });
      if (payload.action === 'delete' && (!data || data.deleted !== true || data.code !== undefined && data.code !== payload.code))
        throw new Error('削除の完了を確認できません。記録は端末に保持しています。');
      if (payload.action === 'load' && validLoadAck(data)) {
        if (payload.code && data.code !== payload.code) throw new Error('保存番号が一致しません。');
        return data;
      }
      if (['create', 'save'].includes(payload.action) && validSaveAck(data) && !validEnvelope(data)) {
        if (payload.code && data.code !== payload.code) throw new Error('保存番号が一致しません。');
        // 成功ACKは revision のみ返すことがある。送った進行を補って以降の処理を共通化する。
        return { ...data, state: data.state ?? payload.state, view: data.view ?? payload.view };
      }
      if (payload.action !== 'delete' && !validEnvelope(data)) throw new Error('保存データの形式を確認できません。');
      if (payload.code && payload.action !== 'delete' && data.code !== payload.code) throw new Error('保存番号が一致しません。');
      return data;
    } finally {
      clearTimeout(timeout);
      if (abort === controller) abort = null;
    }
  }
  function beginSession(value) {
    const actual = read(storageKey);
    const previous = parseRecord(actual);
    if (actual !== expectedRaw && previous?.pending) archive(previous, 'replaced-other-tab');
    record = localEnvelope(value);
    mode = 'normal'; conflict = null;
    persist({ replace: true });
    notify();
    setStatus(record.pending ? 'offline' : storageReady ? 'saved' : 'local-only', storageReady ? record.pending ? '' : '保存済み' : 'このブラウザでは記録を保持できません。再開番号を控えてください。');
    if (record.pending) schedule();
    return copy(record);
  }
  function readLocal() {
    if (mode === 'debug' || disposed) return null;
    expectedRaw = read(storageKey);
    record = parseRecord(expectedRaw);
    if (!record) { mode = 'none'; setStatus('idle'); return null; }
    record = localEnvelope(record);
    mode = 'normal'; conflict = null;
    setStatus(record.code === null ? 'local-only' : record.pending ? 'offline' : 'saved', record.pending ? '' : '保存済み');
    return copy(record);
  }
  function adoptLegacy(state, view = {}) {
    if (disposed) return null;
    cancelOperations();
    mode = 'normal'; conflict = null;
    record = localEnvelope({ code: null, creationId: identifier(), revision: 0, state, view, pending: true });
    persist({ replace: true });
    setStatus('local-only', '端末に保存済み・通信復帰後に再開番号を発行します。');
    notify();
    schedule();
    return copy(record);
  }
  async function startNew(state, view = {}) {
    if (disposed) throw new Error('保存処理は終了しています。');
    // Failed creation attempts retain their idempotency identity separately from the active save.
    const prior = mode === 'normal' ? copy(record) : null;
    cancelOperations();
    const operationEpoch = epoch;
    const snapshot = { state: copy(state), view: copy(view) };
    if (!creation) { try { creation = JSON.parse(read(creationKey)); } catch { creation = null; } }
    if (!creation || !equal(creation.snapshot, snapshot)) creation = { creationId: identifier(), snapshot };
    // New play is a normal operation even when selected from a debug session.
    mode = prior ? 'normal' : 'none';
    write(creationKey, JSON.stringify(creation));
    setStatus('saving', '再開番号を発行しています。');
    try {
      const value = await request({ action: 'create', creationId: creation.creationId, ...snapshot }, operationEpoch);
      if (operationEpoch !== epoch || disposed) return null;
      if (prior?.pending) archive(prior, 'new-play');
      creation = null; remove(creationKey);
      return beginSession(value);
    } catch (error) {
      if (operationEpoch !== epoch || disposed) return null;
      setStatus('offline', error.message);
      throw error;
    }
  }
  async function loadCode(input, { sinceRevision = null, localState = null, localView = null } = {}) {
    const code = normalizePlayCode(input);
    if (!code) throw Object.assign(new Error('数字6桁の再開番号を入力してください。'), { code: 'invalid-code' });
    if (code === '000000') return enterDebug();
    if (disposed) throw new Error('保存処理は終了しています。');
    const prior = mode === 'normal' ? copy(record) : null;
    const cachedState = localState ?? prior?.state;
    const cachedView = localView ?? prior?.view;
    const cachedRevision = Number.isInteger(sinceRevision) ? sinceRevision : prior?.code === code ? prior.revision : null;
    cancelOperations();
    const operationEpoch = epoch;
    setStatus('saving', '進行を読み込んでいます。');
    try {
      const payload = { action: 'load', code };
      if (Number.isInteger(cachedRevision) && cachedState && cachedView) payload.sinceRevision = cachedRevision;
      const value = await request(payload, operationEpoch);
      if (operationEpoch !== epoch || disposed) return null;
      if (prior?.pending) archive(prior, 'load-other-play');
      if (value.unchanged) {
        if (!cachedState || !cachedView) throw new Error('保存データの形式を確認できません。');
        return beginSession({
          code: value.code, revision: value.revision, updatedAt: value.updatedAt ?? null,
          state: cachedState, view: cachedView,
        });
      }
      return beginSession(value);
    } catch (error) {
      if (operationEpoch !== epoch || disposed) return null;
      setStatus('offline', error.message);
      throw error;
    }
  }
  function enterDebug(state = {}, view = {}) {
    cancelOperations();
    // Intentionally do not inspect, mutate or remove any stored normal record.
    mode = 'debug'; conflict = null;
    record = { code: '000000', revision: 0, updatedAt: null, state: copy(state), view: copy(view), pending: false };
    setStatus('debug', 'デバッグモード・進行は保存されません');
    notify();
    return copy(record);
  }
  function update(state, view = {}) {
    if (disposed || !record || mode === 'none') return null;
    if (equal(record.state, state) && equal(record.view, view)) return copy(record);
    record = { ...record, state: copy(state), view: copy(view) };
    if (mode === 'debug') { notify(); return copy(record); }
    record.pending = true;
    record.generation = (record.generation ?? 0) + 1;
    if (conflict) {
      conflict.local = copy(record);
      archive(record, 'conflict-local-update');
      notify(); return copy(record);
    }
    setStatus(storageReady ? 'saving' : 'local-only', storageReady ? '保存中' : '端末に保存できません。通信中はCloudflareへ保存します。');
    schedulePersist();
    schedule();
    notify();
    return copy(record);
  }
  async function sendPending(operationEpoch) {
    while (!disposed && operationEpoch === epoch && mode === 'normal' && record?.pending && !conflict) {
      const actual = read(storageKey);
      if (storageReady && actual !== expectedRaw) return raiseConflict(parseRecord(actual), 'storage');
      const sent = copy(record);
      setStatus('saving', '保存中');
      try {
        let remote;
        try {
          remote = await request(sent.code === null
            ? { action: 'create', creationId: sent.creationId, state: sent.state, view: sent.view }
            : { action: 'save', code: sent.code, revision: sent.revision, state: sent.state, view: sent.view }, operationEpoch);
        } catch (error) {
          // A timed-out request may already have committed. An identical cloud snapshot is a safe acknowledgement.
          const value = error.data?.remote;
          if (error.status === 409 && validEnvelope(value) && value.code === sent.code
            && equal(value.state, sent.state) && equal(value.view, sent.view)) remote = value;
          else throw error;
        }
        if (operationEpoch !== epoch || disposed) return null;
        record = { ...record, code: remote.code, revision: remote.revision, updatedAt: remote.updatedAt,
          pending: record.generation !== sent.generation };
        retryCount = 0;
        persist();
        if (conflict) return recoverCloud();
        notify();
        setStatus(record.pending ? 'saving' : storageReady ? 'saved' : 'local-only', storageReady ? record.pending ? '保存中' : '保存済み' : 'Cloudflareに保存済みです。再開番号を控えてください。');
      } catch (error) {
        if (operationEpoch !== epoch || disposed) return null;
        if (error.status === 409 && validEnvelope(error.data?.remote) && error.data.remote.code === sent.code) {
          return raiseConflict(error.data.remote, 'server');
        } else {
          setStatus(record.code === null || !storageReady ? 'local-only' : 'offline', storageReady ? '' : '進行を保存できません。通信状態を確認してください。');
          if ((!error.status || error.status >= 500 || error.status === 429) && retryCount < maxAutoRetries) schedule(1500 * 2 ** retryCount++);
        }
        return copy(record);
      }
    }
    return copy(record);
  }
  function flush() {
    clearTimeout(timer);
    const hadPersistTimer = Boolean(persistTimer);
    clearTimeout(persistTimer);
    persistTimer = undefined;
    if (conflict && mode === 'normal' && !disposed) return recoverCloud();
    if (disposed || mode !== 'normal' || !record?.pending) {
      // デバウンス中の端末書き込みだけを確定する。変更がなければ触らない。
      if (hadPersistTimer && mode === 'normal' && record && !conflict) persist();
      return Promise.resolve(copy(record));
    }
    persist();
    if (conflict) return recoverCloud();
    if (flight) return flight;
    const operationEpoch = epoch;
    const operation = sendPending(operationEpoch);
    flight = operation;
    operation.finally(() => { if (flight === operation) flight = null; });
    return operation;
  }
  function recoverCloud() {
    if (recovery) return recovery;
    const { source, remote, local } = conflict;
    const operationEpoch = epoch;
    const initialRaw = read(storageKey);
    const code = remote?.code ?? local.code;
    const operation = Promise.resolve().then(async () => {
      if (disposed || epoch !== operationEpoch) return null;
      try {
        // A 409 contains the committed record. A storage event contains only another tab's copy.
        const latest = source === 'server' ? remote : code
          ? await request({ action: 'load', code }, operationEpoch) : remote;
        if (disposed || epoch !== operationEpoch) return null;
        const actual = read(storageKey);
        if (storageReady && actual !== initialRaw) return raiseConflict(parseRecord(actual), 'storage');
        if (!latest) { leaveSession(); onCloudRestore(null); return null; }
        const cached = parseRecord(actual);
        // Keep a matching acknowledgement byte-for-byte stable across listening tabs.
        const synced = cached && !cached.pending && cached.code === latest.code && cached.revision === latest.revision
          && equal(cached.state, latest.state) && equal(cached.view, latest.view) ? cached : latest;
        const adopted = beginSession(synced);
        onCloudRestore(adopted);
        return adopted;
      } catch (error) {
        if (disposed || epoch !== operationEpoch) return null;
        if (error.status === 404) {
          if (parseRecord(read(storageKey))?.code === code) remove(storageKey);
          leaveSession(); onCloudRestore(null); return null;
        }
        setStatus('conflict', '保存された進行を読み込めません。接続後に再試行します。');
        if (retryCount < maxAutoRetries) {
          timer = setTimeout(() => { void flush(); }, 1500 * 2 ** retryCount++);
          timer.unref?.();
        }
        return null;
      }
    });
    recovery = operation;
    operation.finally(() => { if (recovery === operation) recovery = null; });
    return operation;
  }
  async function deleteCurrent() {
    if (!record || mode === 'none') return false;
    if (mode === 'debug') {
      cancelOperations(); record = null; mode = 'none'; conflict = null;
      setStatus('idle'); notify(); return true;
    }
    cancelOperations();
    const operationEpoch = epoch;
    const target = copy(record);
    const currentRaw = read(storageKey);
    if (storageReady && currentRaw !== expectedRaw) { await raiseConflict(parseRecord(currentRaw), 'storage'); return false; }
    try {
      if (target.code !== null) await request({ action: 'delete', code: target.code, revision: target.revision }, operationEpoch);
      if (operationEpoch !== epoch || disposed) return false;
      const actual = read(storageKey);
      if (actual === expectedRaw) { remove(storageKey); expectedRaw = null; }
      else if (storageReady) { await raiseConflict(parseRecord(actual), 'storage'); return false; }
      record = null; mode = 'none'; conflict = null;
      setStatus('idle'); notify(); return true;
    } catch (error) {
      if (operationEpoch !== epoch || disposed) return false;
      if (error.status === 409 && validEnvelope(error.data?.remote) && error.data.remote.code === target.code) { await raiseConflict(error.data.remote, 'server'); return false; }
      if (error.status === 404 && target.code !== null) {
        const actual = read(storageKey);
        const stored = parseRecord(actual);
        if (actual === expectedRaw || stored?.code === target.code) {
          if (actual === expectedRaw) expectedRaw = null;
          remove(storageKey);
        }
        record = null; mode = 'none'; conflict = null;
        setStatus('idle'); notify(); return true;
      }
      setStatus('offline', error.message);
      throw error;
    }
  }
  function handleStorageEvent(event) {
    if (disposed || mode !== 'normal' || !record || event.key !== storageKey) return;
    if (event.storageArea && event.storageArea !== storage) return;
    if (event.newValue === expectedRaw || event.newValue !== read(storageKey)) return;
    const other = parseRecord(event.newValue);
    // Let an active tab finish its pending upload before a read-only tab follows it.
    if (other?.pending && other.code === record.code && !record.pending && !conflict) return;
    return raiseConflict(other, 'storage');
  }
  function leaveSession() {
    cancelOperations(); record = null; mode = 'none'; conflict = null;
    setStatus('idle'); notify();
  }
  function dispose() { cancelOperations(); disposed = true; }
  return {
    storageKey, readLocal, getRecord: () => copy(record), getStatus: () => copy(status),
    getConflict: () => copy(conflict), adoptLegacy, startNew, loadCode, enterDebug, update, flush,
    retry: () => { retryCount = 0; return flush(); }, deleteCurrent,
    handleStorageEvent, leaveSession, dispose,
  };
}
