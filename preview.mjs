import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
const base = path.resolve('dist');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const filename = path.resolve(base, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!filename.startsWith(base + path.sep)) { res.writeHead(403).end(); return; }
    if (!(await stat(filename)).isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(filename)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(filename));
  } catch { res.writeHead(404).end('Não encontrado'); }
});
server.listen(4173, '127.0.0.1', () => console.log('Local: http://127.0.0.1:4173'));
