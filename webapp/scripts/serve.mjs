import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const port = Number(process.env.PORT ?? 4173);
const appUrl = '/11月の救祭/app/';
let saveEnv;
let handlePlaySave;
if (process.argv.includes('--with-saves')) {
  const [{ createLocalD1 }, api] = await Promise.all([import('./local-d1.mjs'), import('../server/play-saves.js')]);
  handlePlaySave = api.handlePlaySave;
  saveEnv = {
    PLAY_SAVES: createLocalD1(fileURLToPath(new URL('../artifacts/play-saves-local.sqlite', import.meta.url))),
    // Fixed only for repeatable local QA. Never use this value in Cloudflare production/preview.
    PLAY_SAVE_SECRET: 'local-development-only-not-a-production-secret',
  };
}
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host ?? `127.0.0.1:${port}`}`);
    if (requestUrl.pathname === '/api/play-saves' && saveEnv) {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else if (value !== undefined) headers.set(name, value);
      }
      headers.set('CF-Connecting-IP', req.socket.remoteAddress ?? '127.0.0.1');
      const request = new Request(requestUrl, {
        method: req.method, headers,
        ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
      });
      const result = await handlePlaySave(request, saveEnv);
      res.writeHead(result.status, Object.fromEntries(result.headers));
      res.end(req.method === 'HEAD' ? undefined : Buffer.from(await result.arrayBuffer()));
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const pathname = decodeURIComponent(requestUrl.pathname);
    if (['/app', '/app/', '/app/index', '/app/index.html'].includes(pathname)) {
      res.writeHead(301, { Location: encodeURI(appUrl) + requestUrl.search }); res.end(); return;
    }
    if (pathname === appUrl.slice(0, -1)) {
      res.writeHead(308, { Location: encodeURI(appUrl) + requestUrl.search }); res.end(); return;
    }
    // Local source assets stay in dist/app and dist/assets; mirror the public URL.
    const sourcePath = pathname.startsWith('/11月の救祭/') ? pathname.slice('/11月の救祭'.length) : pathname;
    const withoutQuery = sourcePath === '/' ? '/index.html' : sourcePath;
    const path = resolve(root, `.${withoutQuery.endsWith('/') ? `${withoutQuery}index.html` : withoutQuery}`);
    if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) { res.writeHead(403); res.end(); return; }
    if (!extname(path)) { res.writeHead(308, { Location: encodeURI(`${pathname}/`) + requestUrl.search }); res.end(); return; }
    const content = await readFile(path);
    res.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream', 'Cache-Control': types[extname(path)]?.startsWith('image/') ? 'private, max-age=60' : 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
server.on('close', () => saveEnv?.PLAY_SAVES.close());
server.listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}${saveEnv ? ' (local SQLite saves enabled)' : ''}`));
