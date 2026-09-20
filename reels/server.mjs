/* Tiny static server for the repository root.
 *
 * The stage fetches JSON, so it has to run over http rather than file://.
 * Serving the repository root also means the logo PNGs sitting next to the
 * README are reachable at their own names.
 *
 *   node server.mjs --port=4321     # then open /reels/preview.html
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
};

export function startServer({ root = ROOT, port = 0 } = {}) {
  const server = http.createServer((req, res) => {
    let rel;
    try {
      rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    if (rel.endsWith('/')) rel += 'index.html';
    if (rel === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }
    // Lets the preview page list the projects without hard-coding their names.
    if (rel === '/reels/projects/index.json') {
      const dir = path.join(root, 'reels', 'projects');
      const names = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json') && f !== 'index.json')
        .map((f) => path.basename(f, '.json'))
        .sort();
      res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
      res.end(JSON.stringify(names));
      return;
    }

    const file = path.join(root, path.normalize(rel));
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(data);
    });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address();
      resolve({
        url: `http://127.0.0.1:${actual}`,
        port: actual,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const portArg = process.argv.find((a) => a.startsWith('--port='));
  const { url } = await startServer({ port: portArg ? Number(portArg.split('=')[1]) : 4321 });
  console.log(`Предпросмотр: ${url}/reels/preview.html`);
}
