import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../frontend/preview-dist/', import.meta.url));
const prefix = '/ComposeOps/';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer(async (request, reply) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname === '/') { reply.writeHead(302, { location: prefix }); reply.end(); return; }
    if (!pathname.startsWith(prefix)) { reply.writeHead(404); reply.end(); return; }
    const file = path.resolve(root, pathname.slice(prefix.length) || 'index.html');
    if (!file.startsWith(root)) { reply.writeHead(403); reply.end(); return; }
    const body = await readFile(file);
    reply.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    reply.end(body);
  } catch { reply.writeHead(404); reply.end(); }
});
server.listen(Number(process.env.PREVIEW_PORT || 4174), '127.0.0.1', () => console.log('Preview: http://127.0.0.1:' + (process.env.PREVIEW_PORT || 4174) + prefix));
