// Creates and deletes only its own synthetic save. Never operates on an existing player's number.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { scenario } from '../dist/scenario.js';
import { initialState, submitAnswer } from '../dist/engine.js';
import { restorePlayView } from '../dist/save-view.js';

const [base, reportPath] = process.argv.slice(2);
if (!base || !reportPath) throw new Error('Usage: node verify-play-saves.mjs https://target /absolute/report.json');
const origin = new URL(base).origin;
const steps = [];
async function call(action, fields = {}, expected = 200) {
  const response = await fetch(new URL('/api/play-saves', origin), {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ action, scenarioId: scenario.id, ...fields }), signal: AbortSignal.timeout(20000),
  });
  const value = await response.json();
  assert.equal(response.status, expected, `${action}: ${JSON.stringify(value)}`);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  steps.push({ action, status: response.status, error: value.error ?? null });
  return value;
}
const state = initialState(scenario);
const view = restorePlayView(scenario, state, null);
const creationId = crypto.randomUUID();
const created = await call('create', { creationId, state, view });
assert.match(created.code, /^\d{6}$/);
assert.notEqual(created.code, '000000');
assert.equal(created.revision, 1);
const duplicate = await call('create', { creationId, state, view });
assert.equal(duplicate.code, created.code);
const loaded = await call('load', { code: created.code });
assert.deepEqual(loaded.state, state);
const advanced = submitAnswer(scenario, state, ['10']).state;
const advancedView = restorePlayView(scenario, advanced, null);
const updated = await call('save', { code: created.code, revision: 1, state: advanced, view: advancedView });
assert.equal(updated.revision, 2);
const conflict = await call('save', { code: created.code, revision: 1, state, view }, 409);
assert.equal(conflict.remote.revision, 2);
assert.deepEqual(conflict.remote.state.solved, ['N1']);
await call('load', { code: '000000' }, 400);
await call('save', { code: '000000', revision: 1, state, view }, 400);
await call('load', { code: '12345' }, 400);
const deleted = await call('delete', { code: created.code, revision: 2 });
assert.equal(deleted.deleted, true);
await call('delete', { code: created.code, revision: 2 });
await call('load', { code: created.code }, 404);
const report = { origin, checkedAt: new Date().toISOString(), scenarioId: scenario.id, syntheticSaveDeleted: true, steps };
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ origin, checks: steps.length, syntheticSaveDeleted: true, report: reportPath }));
