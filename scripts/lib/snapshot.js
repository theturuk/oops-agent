'use strict';
// Taking snapshots of files and computing what changed between two snapshots.

const fs = require('fs');
const path = require('path');

const IGNORED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__',
  '.next', '.nuxt', '.turbo', '.cache', '.gradle', '.idea', 'target',
  '.pytest_cache', '.mypy_cache', '.tox', 'bower_components',
]);
const MAX_FILE_BYTES = Number(process.env.OOPS_MAX_FILE_MB || 20) * 1024 * 1024;
const MAX_FILES = Number(process.env.OOPS_MAX_FILES || 50000);

// Paths inside the project are stored relative with forward slashes,
// paths outside it are stored absolute.
function toKey(root, absPath) {
  const rel = path.relative(root, absPath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  return path.resolve(absPath);
}

function toAbs(root, key) {
  return path.isAbsolute(key) ? key : path.join(root, ...key.split('/'));
}

function readIgnoreFile(root) {
  const extra = new Set();
  try {
    for (const line of fs.readFileSync(path.join(root, '.oopsignore'), 'utf8').split(/\r?\n/)) {
      const name = line.trim().replace(/\/$/, '');
      if (name && !name.startsWith('#')) extra.add(name);
    }
  } catch (_) {}
  return extra;
}

// Snapshot a single file: returns its hash, or null if it doesn't exist / isn't a regular file.
function snapshotFile(store, absPath, index) {
  let st;
  try { st = fs.lstatSync(absPath); } catch (_) { return null; }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
  const key = toKey(store.root, absPath);
  const cached = index && index[key];
  if (cached && cached[0] === st.size && cached[1] === st.mtimeMs && store.hasBlob(cached[2])) {
    return cached[2];
  }
  let buf;
  try { buf = fs.readFileSync(absPath); } catch (e) {
    store.log(`read failed ${absPath}: ${e.message}`);
    return null;
  }
  const hash = store.putBuffer(buf);
  if (index) index[key] = [st.size, st.mtimeMs, hash];
  return hash;
}

// Snapshot the whole project tree: returns { key: hash }.
function snapshotTree(store) {
  const index = store.loadIndex();
  const ignored = new Set([...IGNORED_DIRS, ...readIgnoreFile(store.root)]);
  const files = {};
  let count = 0;
  let truncated = false;
  const stack = [store.root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!ignored.has(ent.name)) stack.push(abs);
      } else if (ent.isFile()) {
        if (count >= MAX_FILES) { truncated = true; continue; }
        const hash = snapshotFile(store, abs, index);
        if (hash) { files[toKey(store.root, abs)] = hash; count++; }
      }
    }
  }
  // Drop cache entries for files that no longer exist so the index doesn't grow forever.
  for (const key of Object.keys(index)) {
    if (!(key in files) && !path.isAbsolute(key)) delete index[key];
  }
  store.saveIndex(index);
  if (truncated) store.log(`project has more than ${MAX_FILES} files; snapshot truncated`);
  return files;
}

function diffSnapshots(before, after) {
  const changes = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const p of [...keys].sort()) {
    const b = before[p] || null;
    const a = after[p] || null;
    if (b !== a) changes.push({ p, b, a });
  }
  return changes;
}

module.exports = { snapshotFile, snapshotTree, diffSnapshots, toKey, toAbs };
