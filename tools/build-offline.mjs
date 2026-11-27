import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('Pass a Vite build directory.');
const files = (await readdir(root, { recursive: true, withFileTypes: true }))
  .filter(entry => entry.isFile() && entry.name !== 'offline-sw.js' && !entry.name.endsWith('.map'))
  .map(entry => join(entry.parentPath, entry.name).slice(root.length + 1).replaceAll('\\', '/')).sort();
if (!files.includes('index.html')) throw new Error('The build has no index.html.');
const hash = createHash('sha256');
for (const path of files) hash.update(path).update(await readFile(join(root, path)));
const version = hash.digest('hex').slice(0, 24);
const script = `const scope = self.registration.scope;
const prefix = 'assetfixer:' + scope;
const build = prefix + ':${version}';
const index = new URL('index.html', scope).href;
const files = ${JSON.stringify(files)}.map(file => new URL(file, scope).href);
const assets = new Set(files);
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(build);
    try {
      await cache.addAll(files.map(url => new Request(url, { cache: 'reload' })));
    } catch (error) {
      await caches.delete(build);
      throw error;
    }
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(prefix + ':') && key !== build) await caches.delete(key);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === 'navigate' && (url.pathname === new URL(scope).pathname || url.pathname === new URL(index).pathname)) {
    event.respondWith(fetch(request).catch(async () => (await (await caches.open(build)).match(index)) ?? Response.error()));
  } else if (assets.has(url.href)) {
    event.respondWith((async () => (await (await caches.open(build)).match(url.href)) ?? fetch(request))());
  }
});
`;
await writeFile(join(root, 'offline-sw.js'), script);
