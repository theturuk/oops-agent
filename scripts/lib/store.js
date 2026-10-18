'use strict';
// Content-addressed snapshot store. Lives OUTSIDE the project (~/.oops-agent)
// so that an agent running `rm -rf .` cannot delete its own undo history.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const IS_WIN = process.platform === 'win32';

function oopsHome() {
  return process.env.OOPS_HOME || path.join(os.homedir(), '.oops-agent');
}

function normalizeRoot(root) {
  let r = path.resolve(root);
  if (IS_WIN) r = r.replace(/^[a-z]:/, (d) => d.toUpperCase());
  return r;
}

function projectKey(root) {
  const r = normalizeRoot(root);
  const id = IS_WIN ? r.toLowerCase() : r;
  const hash = crypto.createHash('sha1').update(id).digest('hex').slice(0, 10);
  const name = path.basename(r).replace(/[^A-Za-z0-9_.-]/g, '_') || 'root';
  return `${name}-${hash}`;
}

function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    if (!fs.existsSync(file)) throw e;
  }
}

class Store {
  constructor(root) {
    this.root = normalizeRoot(root);
    this.dir = path.join(oopsHome(), 'projects', projectKey(this.root));
    this.objects = path.join(this.dir, 'objects');
    this.pendingDir = path.join(this.dir, 'pending');
    this.eventsFile = path.join(this.dir, 'events.jsonl');
    this.indexFile = path.join(this.dir, 'index.json');
    fs.mkdirSync(this.objects, { recursive: true });
    fs.mkdirSync(this.pendingDir, { recursive: true });
    const meta = path.join(this.dir, 'project.json');
    if (!fs.existsSync(meta)) {
      writeAtomic(meta, JSON.stringify({ root: this.root, created: new Date().toISOString() }, null, 2));
    }
  }

  // ---- blobs ----
  objectPath(hash) {
    return path.join(this.objects, hash.slice(0, 2), hash.slice(2));
  }

  putBuffer(buf) {
    const hash = hashBuffer(buf);
    const p = this.objectPath(hash);
    if (!fs.existsSync(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      writeAtomic(p, zlib.gzipSync(buf, { level: 6 }));
    }
    return hash;
  }

  hasBlob(hash) {
    return fs.existsSync(this.objectPath(hash));
  }

  getBuffer(hash) {
    return zlib.gunzipSync(fs.readFileSync(this.objectPath(hash)));
  }

  // ---- stat cache (path -> [size, mtimeMs, hash]) ----
  loadIndex() {
    try { return JSON.parse(fs.readFileSync(this.indexFile, 'utf8')); } catch (_) { return {}; }
  }

  saveIndex(index) {
    writeAtomic(this.indexFile, JSON.stringify(index));
  }

  // ---- pending snapshots between Pre and Post hooks ----
  pendingPath(id) {
    return path.join(this.pendingDir, `${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  }

  savePending(id, data) {
    writeAtomic(this.pendingPath(id), JSON.stringify(data));
  }

  takePending(id) {
    const p = this.pendingPath(id);
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      fs.unlinkSync(p);
      return data;
    } catch (_) {
      return null;
    }
  }

  // ---- events ----
  appendEvent(ev) {
    fs.appendFileSync(this.eventsFile, JSON.stringify(ev) + '\n');
  }

  events() {
    let text;
    try { text = fs.readFileSync(this.eventsFile, 'utf8'); } catch (_) { return []; }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (_) { /* skip torn line */ }
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  log(msg) {
    try {
      fs.appendFileSync(path.join(this.dir, 'error.log'), `[${new Date().toISOString()}] ${msg}\n`);
    } catch (_) {}
  }
}

module.exports = { Store, oopsHome, normalizeRoot, projectKey, hashBuffer };
