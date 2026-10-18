'use strict';
// Automatic cleanup: drop steps older than N days, then delete snapshot blobs
// that no remaining step (or in-flight hook) still needs.

const fs = require('fs');
const path = require('path');
const { Store, oopsHome } = require('./store');

const DAY = 24 * 60 * 60 * 1000;
const AUTO_EVERY = DAY;
// Blobs this young are left alone: a hook may have just written them and not yet recorded them.
const BLOB_GRACE_MS = 60 * 60 * 1000;
const PENDING_MAX_AGE = DAY;

function keepDaysSetting() {
  const v = process.env.OOPS_KEEP_DAYS;
  if (v === undefined || v === '') return 30;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else try { total += fs.statSync(p).size; } catch (_) {}
    }
  }
  return total;
}

function pruneStore(store, { keepDays, dryRun = false, now = Date.now() }) {
  const result = { root: store.root, removedSteps: 0, keptSteps: 0, removedBlobs: 0, freedBytes: 0 };
  let original;
  try { original = fs.readFileSync(store.eventsFile, 'utf8'); } catch (_) { original = ''; }
  const cutoff = now - keepDays * DAY;
  const kept = [];
  for (const line of original.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch (_) { continue; }
    if (e.t < cutoff) result.removedSteps++;
    else kept.push(line);
  }
  result.keptSteps = kept.length;

  // Everything still referenced: remaining steps, in-flight hooks, and the stat cache.
  const live = new Set();
  for (const line of kept) for (const c of JSON.parse(line).changes) { if (c.b) live.add(c.b); if (c.a) live.add(c.a); }
  let pendingFiles = [];
  try { pendingFiles = fs.readdirSync(store.pendingDir); } catch (_) {}
  for (const f of pendingFiles) {
    const p = path.join(store.pendingDir, f);
    try {
      if (now - fs.statSync(p).mtimeMs > PENDING_MAX_AGE) { if (!dryRun) fs.unlinkSync(p); continue; }
      for (const h of Object.values(JSON.parse(fs.readFileSync(p, 'utf8')).files || {})) if (h) live.add(h);
    } catch (_) {}
  }
  for (const v of Object.values(store.loadIndex())) if (v && v[2]) live.add(v[2]);

  if (result.removedSteps && !dryRun) {
    // Hooks may have appended while we worked; carry those lines over before swapping the file in.
    let current;
    try { current = fs.readFileSync(store.eventsFile, 'utf8'); } catch (_) { current = original; }
    const appended = current.startsWith(original) ? current.slice(original.length) : '';
    const tmp = `${store.eventsFile}.${process.pid}.prune.tmp`;
    fs.writeFileSync(tmp, (kept.length ? kept.join('\n') + '\n' : '') + appended);
    fs.renameSync(tmp, store.eventsFile);
  }

  let shards = [];
  try { shards = fs.readdirSync(store.objects); } catch (_) {}
  for (const shard of shards) {
    const dir = path.join(store.objects, shard);
    let files;
    try { files = fs.readdirSync(dir); } catch (_) { continue; }
    for (const f of files) {
      if (live.has(shard + f)) continue;
      const p = path.join(dir, f);
      let st;
      try { st = fs.statSync(p); } catch (_) { continue; }
      if (now - st.mtimeMs < BLOB_GRACE_MS) continue;
      result.removedBlobs++;
      result.freedBytes += st.size;
      if (!dryRun) try { fs.unlinkSync(p); } catch (_) {}
    }
    if (!dryRun) try { fs.rmdirSync(dir); } catch (_) { /* not empty */ }
  }
  return result;
}

function allStores() {
  const dir = path.join(oopsHome(), 'projects');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) {}
  const stores = [];
  for (const name of names) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, name, 'project.json'), 'utf8'));
      stores.push(new Store(meta.root));
    } catch (_) {}
  }
  return stores;
}

// Called from the SessionStart hook: prunes every project, at most once a day, silently.
function autoPrune() {
  const keepDays = keepDaysSetting();
  if (keepDays === 0) return null;
  const stamp = path.join(oopsHome(), 'last-prune');
  try { if (Date.now() - fs.statSync(stamp).mtimeMs < AUTO_EVERY) return null; } catch (_) {}
  fs.mkdirSync(oopsHome(), { recursive: true });
  fs.writeFileSync(stamp, new Date().toISOString());
  return allStores().map((s) => pruneStore(s, { keepDays }));
}

module.exports = { pruneStore, autoPrune, allStores, keepDaysSetting, dirSize };
