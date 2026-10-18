'use strict';
// Hook handling (record what the agent changed) and restore logic.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./store');
const { snapshotFile, snapshotTree, diffSnapshots, toKey, toAbs } = require('./snapshot');

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// Shell tools can touch any file, so they get a whole-project snapshot.
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// The temp dir has more than one spelling (macOS: /var vs /private/var, Windows: 8.3 short
// names like RUNNER~1), so compare both the given and the resolved forms of each path.
function realOr(p) {
  try { return fs.realpathSync.native(p); } catch (_) {
    try { return path.join(fs.realpathSync.native(path.dirname(p)), path.basename(p)); } catch (__) { return p; }
  }
}
function isInTempDir(abs) {
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const tmp = os.tmpdir();
  for (const dir of [tmp, realOr(tmp)]) {
    for (const p of [abs, realOr(abs)]) {
      const rel = path.relative(norm(dir), norm(p));
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
    }
  }
  return false;
}

function newId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

function filePathsFor(toolName, input) {
  const p = input && (input.file_path || input.notebook_path || input.path);
  return p ? [p] : [];
}

function summarize(toolName, input, root) {
  if (SHELL_TOOLS.has(toolName)) return String((input && input.command) || '').slice(0, 500);
  const files = filePathsFor(toolName, input);
  return files.map((f) => toKey(root, path.resolve(root, f))).join(', ');
}

// ---------- hooks ----------

// Files Oops knows about that changed while it wasn't looking (edited by hand, or by
// an agent session without the plugin). Recorded as their own step so the timeline
// matches the disk and those changes can be undone too.
function recordExternalChanges(store, current) {
  const known = {};
  for (const e of store.events()) for (const c of e.changes) known[c.p] = c.a;
  const changes = [];
  for (const [p, hash] of Object.entries(known)) {
    if (path.isAbsolute(p)) continue;
    const now = current[p] || null;
    if (now === hash) continue;
    // Not in the scan but still on disk = ignored folder or too large, not a change.
    if (!now && fs.existsSync(toAbs(store.root, p))) continue;
    changes.push({ p, b: hash, a: now });
  }
  if (changes.length) {
    const t = Date.now();
    store.appendEvent({ id: newId(), t, started: t, tool: 'external', summary: 'changed outside the agent (by hand, or while Oops was off)', changes });
  }
}

function handlePre(store, ev) {
  const tool = ev.tool_name;
  const input = ev.tool_input || {};
  const pending = { tool, t: Date.now(), summary: summarize(tool, input, store.root), session: ev.session_id };
  if (SHELL_TOOLS.has(tool)) {
    // Our own restore commands record themselves; don't log them twice.
    if (/oops\.js["']?\s/.test(pending.summary)) return;
    pending.mode = 'tree';
    pending.files = snapshotTree(store);
    recordExternalChanges(store, pending.files);
  } else if (FILE_TOOLS.has(tool)) {
    pending.mode = 'files';
    pending.files = {};
    const index = store.loadIndex();
    for (const f of filePathsFor(tool, input)) {
      const abs = path.resolve(ev.cwd || store.root, f);
      const key = toKey(store.root, abs);
      // Scratch files the agent writes to the OS temp dir (outside the project) are just noise.
      if (path.isAbsolute(key) && isInTempDir(abs)) continue;
      pending.files[key] = snapshotFile(store, abs, index);
    }
    store.saveIndex(index);
  } else {
    return;
  }
  store.savePending(ev.tool_use_id || newId(), pending);
}

function handlePost(store, ev) {
  const pending = store.takePending(ev.tool_use_id);
  if (!pending) return;
  let after;
  if (pending.mode === 'tree') {
    after = snapshotTree(store);
  } else {
    after = {};
    const index = store.loadIndex();
    for (const key of Object.keys(pending.files)) {
      after[key] = snapshotFile(store, toAbs(store.root, key), index);
    }
    store.saveIndex(index);
  }
  const before = {};
  for (const [k, v] of Object.entries(pending.files)) if (v) before[k] = v;
  for (const k of Object.keys(after)) if (!after[k]) delete after[k];
  const changes = diffSnapshots(before, after);
  if (!changes.length) return;
  store.appendEvent({
    id: newId(),
    t: Date.now(),
    started: pending.t,
    tool: pending.tool,
    summary: pending.summary,
    session: pending.session,
    failed: ev.hook_event_name === 'PostToolUseFailure' || undefined,
    changes,
  });
}

function handleHook(ev) {
  const root = process.env.CLAUDE_PROJECT_DIR || ev.cwd || process.cwd();
  const store = new Store(root);
  try {
    if (ev.hook_event_name === 'PreToolUse') handlePre(store, ev);
    else if (ev.hook_event_name === 'PostToolUse' || ev.hook_event_name === 'PostToolUseFailure') handlePost(store, ev);
  } catch (e) {
    store.log(`hook ${ev.hook_event_name} ${ev.tool_name}: ${e.stack || e.message}`);
  }
}

// ---------- restore ----------

// State of every file touched at or after `eventId`, as it was right BEFORE that event.
function stateBefore(events, eventId) {
  const idx = events.findIndex((e) => e.id === eventId);
  if (idx < 0) throw new Error(`no such event: ${eventId}`);
  const target = {};
  for (let i = events.length - 1; i >= idx; i--) {
    for (const c of events[i].changes) target[c.p] = c.b;
  }
  return target;
}

function stateAfter(events, eventId) {
  const idx = events.findIndex((e) => e.id === eventId);
  if (idx < 0) throw new Error(`no such event: ${eventId}`);
  if (idx + 1 >= events.length) {
    // Already the latest event: restoring "after" means re-applying its result.
    const target = {};
    for (const c of events[idx].changes) target[c.p] = c.a;
    return target;
  }
  const target = stateBefore(events, events[idx + 1].id);
  for (const c of events[idx].changes) if (!(c.p in target)) target[c.p] = c.a;
  return target;
}

// Write `target` ({key: hash|null}) to disk. Records the restore as its own event so it can be undone too.
function applyState(store, target, label) {
  const index = store.loadIndex();
  const changes = [];
  for (const [key, hash] of Object.entries(target)) {
    const abs = toAbs(store.root, key);
    const current = snapshotFile(store, abs, index);
    if (current === hash) continue;
    if (hash) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, store.getBuffer(hash));
    } else {
      try { fs.unlinkSync(abs); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    delete index[key];
    changes.push({ p: key, b: current, a: hash });
  }
  store.saveIndex(index);
  if (changes.length) {
    const t = Date.now();
    store.appendEvent({ id: newId(), t, started: t, tool: 'oops', summary: label, changes });
  }
  return changes;
}

function restoreBefore(store, eventId, onlyPath) {
  let target = stateBefore(store.events(), eventId);
  if (onlyPath) target = onlyPath in target ? { [onlyPath]: target[onlyPath] } : {};
  return applyState(store, target, `restore${onlyPath ? ` ${onlyPath}` : ''} to before ${eventId}`);
}

function restoreAfter(store, eventId, onlyPath) {
  let target = stateAfter(store.events(), eventId);
  if (onlyPath) target = onlyPath in target ? { [onlyPath]: target[onlyPath] } : {};
  return applyState(store, target, `restore${onlyPath ? ` ${onlyPath}` : ''} to after ${eventId}`);
}

module.exports = { handleHook, restoreBefore, restoreAfter, stateBefore, stateAfter };
