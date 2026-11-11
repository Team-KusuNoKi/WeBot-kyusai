import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, relative, dirname, extname, isAbsolute, sep, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Build an overlay for the existing official-site repository, never a replacement site.
const project = fileURLToPath(new URL('../../', import.meta.url));
const source = resolve(project, 'webapp');
const dist = resolve(source, 'dist');
const args = process.argv.slice(2);
const backendOnly = args.includes('--backend-only');
const destinations = args.filter(value => value !== '--backend-only');
if (destinations.length !== 1 || !isAbsolute(destinations[0])) {
  throw new Error('Usage: node webapp/scripts/package-play-save.mjs /absolute/project/.build/output [--backend-only]');
}
const output = resolve(destinations[0]);
const buildRoot = resolve(project, '.build');
if (!output.startsWith(buildRoot + sep)) throw new Error('Output must be a new directory inside this project’s .build directory.');
const site = resolve(output, 'site');
const snapshots = new Map();
const publicFiles = new Map();
const appPath = '11月の救祭/app';
const appUrl = `/${appPath}/`;
const hash = data => createHash('sha256').update(data).digest('hex');
const slash = path => path.split(sep).join('/');
// Match module statements, so HTML such as class="room-from" inside a template is ignored.
const moduleReferences = text => [...text.matchAll(/(?:^[ \t]*(?:import|export)\s+(?:[\w$*,{}\s]+?\bfrom\s*)?|\bimport\s*\(\s*)["']([^"'\n]+)["']/gm)].map(match => match[1]);
const cssReferences = text => [...text.matchAll(/url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s)"']+))\s*\)/gi)]
  .map(match => match[1] ?? match[2] ?? match[3]);
const local = value => !/^(?:[a-z]+:|\/|#)/i.test(value);
const referencePath = value => value.split(/[?#]/, 1)[0];
function within(root, path) {
  if (path !== root && !path.startsWith(root + sep)) throw new Error(`Reference escapes source directory: ${path}`);
  return path;
}
async function snapshot(path) {
  if (!snapshots.has(path)) snapshots.set(path, await readFile(path));
  return snapshots.get(path);
}
async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not packaged: ${path}`);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

// Keep helper modules beneath /functions so they are bundled rather than served as static files.
const functionFiles = (await listFiles(resolve(source, 'functions'))).filter(path => /\.[cm]?js$/.test(path));
const serverFiles = (await listFiles(resolve(source, 'server'))).filter(path => /\.[cm]?js$/.test(path));
const backendPaths = new Map();
for (const path of functionFiles) backendPaths.set(path, `functions/${slash(relative(resolve(source, 'functions'), path))}`);
for (const path of serverFiles) backendPaths.set(path, `functions/_lib/server/${slash(relative(resolve(source, 'server'), path))}`);
if (!backendPaths.has(resolve(source, 'functions/api/play-saves.js'))) throw new Error('Missing save API entry point.');
for (const [path, target] of backendPaths) {
  let text = (await snapshot(path)).toString('utf8');
  for (const ref of moduleReferences(text)) {
    if (!ref.startsWith('.')) continue;
    const imported = resolve(dirname(path), ref);
    const destination = backendPaths.get(imported);
    if (!destination) throw new Error(`Unpackaged backend import: ${ref} in ${path}`);
    let mapped = posix.relative(posix.dirname(target), destination);
    if (!mapped.startsWith('.')) mapped = './' + mapped;
    text = text.replaceAll(`'${ref}'`, `'${mapped}'`).replaceAll(`"${ref}"`, `"${mapped}"`);
  }
  publicFiles.set(target, Buffer.from(text));
}
publicFiles.set('_routes.json', Buffer.from(JSON.stringify({ version: 1, include: ['/api/play-saves'], exclude: [] }, null, 2) + '\n'));

const assetPaths = new Set();
let html;
if (!backendOnly) {
  const entry = resolve(dist, 'app/index.html');
  html = (await snapshot(entry)).toString('utf8');
  async function collect(path) {
    within(dist, path);
    if (assetPaths.has(path)) return;
    if (/\.prompt\.txt$/.test(path)) throw new Error('Prompt metadata must not be published.');
    assetPaths.add(path);
    const data = await snapshot(path);
    if (extname(path) === '.js' || extname(path) === '.mjs') {
      const text = data.toString('utf8');
      for (const ref of moduleReferences(text)) {
        if (!ref.startsWith('.')) throw new Error(`Browser module imports must be local: ${ref}`);
        await collect(resolve(dirname(path), ref));
      }
      for (const match of text.matchAll(/["'](\.\.\/assets\/[^"']+)["']/g)) {
        await collect(resolve(dist, match[1].replace(/^\.\.\//, '')));
      }
    } else if (extname(path) === '.css') {
      for (const ref of cssReferences(data.toString('utf8')).filter(local)) await collect(resolve(dirname(path), ref));
    }
  }
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    if (local(match[1])) await collect(resolve(dirname(entry), referencePath(match[1])));
  }
}

const releaseHash = createHash('sha256');
for (const [path, bytes] of [...snapshots].sort(([a], [b]) => a.localeCompare(b))) {
  releaseHash.update(slash(relative(source, path)) + '\0').update(bytes).update('\0');
}
const release = `release-save-${releaseHash.digest('hex').slice(0, 12)}`;
if (!backendOnly) {
  for (const path of [...assetPaths].sort()) {
    let data = snapshots.get(path);
    if (/\.[cm]?js$/.test(path)) {
      data = Buffer.from(data.toString('utf8').replaceAll('../assets/', `./assets/${release}/assets/`));
    }
    publicFiles.set(`${appPath}/assets/${release}/${slash(relative(dist, path))}`, data);
  }
  for (const match of [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]) {
    const ref = match[1];
    if (local(ref)) {
      const pathname = referencePath(ref);
      const path = resolve(dist, 'app', pathname);
      html = html.replaceAll(ref, `./assets/${release}/${slash(relative(dist, path))}${ref.slice(pathname.length)}`);
    }
  }
  publicFiles.set(`${appPath}/index.html`, Buffer.from(html));
  // Redirect only legacy entry points; keep old assets available for open tabs.
  publicFiles.set('_redirects', Buffer.from(['/app', '/app/', '/app/index', '/app/index.html']
    .map(path => `${path} ${encodeURI(appUrl)} 301`).join('\n') + '\n'));
}

// Verify references against the frozen package before any output is written.
for (const [target, bytes] of publicFiles) {
  if (/\.[cm]?js$/.test(target)) {
    for (const ref of moduleReferences(bytes.toString('utf8')).filter(ref => ref.startsWith('.'))) {
      const resolved = posix.normalize(posix.join(posix.dirname(target), ref));
      if (!publicFiles.has(resolved)) throw new Error(`Broken packaged import: ${target} -> ${ref}`);
    }
  }
}
for (const [path, bytes] of snapshots) {
  if (!(await readFile(path)).equals(bytes)) throw new Error(`Source changed during packaging: ${path}`);
}
await mkdir(buildRoot, { recursive: true });
await mkdir(output); // Refuse to overwrite a previous release or mix versions.
for (const [path, bytes] of publicFiles) {
  const target = resolve(site, path);
  within(site, target);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}
const entries = [...publicFiles].sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) }));
const manifest = {
  release, backendOnly, repository: 'codedev0625-source/kusunoki-official-site', branch: 'main',
  pagesProject: 'kusunoki-official-site', appPath, url: `https://team-kusunoki.com${appUrl}`,
  sourceSha256: Object.fromEntries([...snapshots].map(([path, bytes]) => [slash(relative(source, path)), hash(bytes)])),
  entries,
};
await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
for (const entry of entries) {
  if (hash(await readFile(resolve(site, entry.path))) !== entry.sha256) throw new Error(`Package hash mismatch: ${entry.path}`);
}
console.log(JSON.stringify({ output, site, manifest: resolve(output, 'manifest.json'), release, backendOnly, files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) }));
