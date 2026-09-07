/**
 * Dependency-free static server for the XPZ demo portal.
 * Run:  node scripts/serve-demo.mjs   (or: npm run demo:xpz)
 * Serves demo/xpz-portal on http://localhost:4173
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'demo', 'xpz-portal');
const PORT = Number(process.env.DEMO_PORT || 4173);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/') path = '/index.html';
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
    const s = await stat(file).catch(() => null);
    if (!s || !s.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});

// An already-running portal is the common case, not a crash — say so plainly
// instead of dumping an EADDRINUSE stack trace mid-demo.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`XPZ demo portal is already running  →  http://localhost:${PORT}`);
    console.log('Nothing to do — just open that URL.');
    console.log(`To restart it, stop the process on port ${PORT} first.`);
    process.exit(0);
  }
  console.error(`Could not start the demo portal: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`XPZ demo portal  →  http://localhost:${PORT}`);
  console.log(`Serving ${ROOT}`);
  console.log('Make sure the Settlement API is running on http://localhost:3000 (npm run dev).');
});
