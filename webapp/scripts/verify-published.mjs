import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const [base, manifestPath, reportPath] = process.argv.slice(2);
if (!base || !manifestPath || !reportPath) throw new Error('Usage: node verify-published.mjs https://target /absolute/manifest.json /absolute/report.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const appPath = manifest.appPath ?? 'app';
const files = manifest.entries.filter(file => file.path.startsWith(`${appPath}/`));
assert.ok(files.length > 0, 'Manifest must contain application files');
const results = [];
let index = 0;
await Promise.all(Array.from({ length: 5 }, async () => {
  while (index < files.length) {
    const file = files[index++];
    const path = file.path === `${appPath}/index.html` ? `${appPath}/` : file.path;
    const response = await fetch(new URL(path, base), { cache: 'no-store', signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200, file.path);
    const data = Buffer.from(await response.arrayBuffer());
    const hash = createHash('sha256').update(data).digest('hex');
    assert.equal(hash, file.sha256, file.path);
    results.push({ path: file.path, sha256: hash, matches: true });
  }
}));
for (const path of ['functions/api/play-saves.js', 'functions/_lib/server/play-saves.js']) {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(15000) });
  const text = await response.text();
  assert.ok(!text.includes('handlePlaySave') && !text.includes('allocation_nonce'), 'Server source must not be served');
}
const report = { base, release: manifest.release, checkedAt: new Date().toISOString(), allMatch: true, serverSourceNotServed: true, files: results.sort((a, b) => a.path.localeCompare(b.path)) };
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ base, files: results.length, allMatch: true, report: reportPath }));
