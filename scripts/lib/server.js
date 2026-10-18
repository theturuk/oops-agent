'use strict';
// Local timeline UI. Binds to 127.0.0.1 only, and every API call needs a random
// token from the URL so other websites can't trigger restores on localhost.

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { restoreBefore, restoreAfter } = require('./core');

const IDLE_EXIT_MS = 30 * 60 * 1000;
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
};

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function openBrowser(url) {
  const opts = { detached: true, stdio: 'ignore' };
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '""', url], { ...opts, windowsVerbatimArguments: true }).unref();
    else if (process.platform === 'darwin') spawn('open', [url], opts).unref();
    else spawn('xdg-open', [url], opts).unref();
  } catch (_) {}
}

function startServer(store, { port = 0, open = true } = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const html = fs.readFileSync(path.join(__dirname, '..', 'ui', 'index.html'), 'utf8');
  let idleTimer;
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => process.exit(0), IDLE_EXIT_MS);
  };

  const send = (res, code, body, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    touch();
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') return send(res, 200, html, 'text/html; charset=utf-8');
    if (url.searchParams.get('token') !== token) return send(res, 403, { error: 'bad token' });

    try {
      if (url.pathname === '/api/events') {
        return send(res, 200, { root: store.root, events: store.events() });
      }
      if (url.pathname === '/api/blob') {
        const hash = url.searchParams.get('hash');
        if (!/^[0-9a-f]{64}$/.test(hash || '') || !store.hasBlob(hash)) return send(res, 404, { error: 'not found' });
        const buf = store.getBuffer(hash);
        const ext = path.extname(url.searchParams.get('p') || '').toLowerCase();
        if (url.searchParams.get('raw')) return send(res, 200, buf, MIME[ext] || 'application/octet-stream');
        if (isBinary(buf)) return send(res, 200, { binary: true, size: buf.length, image: !!MIME[ext] });
        return send(res, 200, { binary: false, size: buf.length, text: buf.toString('utf8') });
      }
      if (url.pathname === '/api/restore' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try {
            const { id, file, after } = JSON.parse(body || '{}');
            const changes = after ? restoreAfter(store, id, file) : restoreBefore(store, id, file);
            send(res, 200, { restored: changes.length });
          } catch (e) {
            send(res, 400, { error: e.message });
          }
        });
        return;
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}/?token=${token}`;
      console.log(`Oops timeline for ${store.root}\n${url}\n(closes after 30 minutes idle, Ctrl+C to stop)`);
      if (open) openBrowser(url);
      touch();
      resolve(server);
    });
  });
}

module.exports = { startServer };
