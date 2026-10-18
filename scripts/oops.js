#!/usr/bin/env node
'use strict';
// oops — undo anything your AI agent did.
//
//   oops hook                      (called by Claude Code hooks, reads JSON on stdin)
//   oops log [--limit N]           list recorded changes
//   oops show <id>                 files changed by one event
//   oops undo [<id>]               restore the project to before <id> (default: the last change)
//   oops restore <id> [--file P] [--after]
//   oops ui [--port N] [--no-open] open the timeline in the browser
//   oops prune [--keep-days N] [--all] [--dry-run]
//                                  delete steps older than N days (default 30, or OOPS_KEEP_DAYS)
//
// Global option: --root <dir> (defaults to the current directory)

const path = require('path');
const { Store } = require('./lib/store');
const { handleHook, restoreBefore, restoreAfter } = require('./lib/core');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { args[key] = next; i++; } else args[key] = true;
    } else args._.push(a);
  }
  return args;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function fmtTime(t) {
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function changeMark(c) {
  if (!c.b) return '+';
  if (!c.a) return '-';
  return '~';
}

function printChanges(changes, max = Infinity) {
  changes.slice(0, max).forEach((c) => console.log(`    ${changeMark(c)} ${c.p}`));
  if (changes.length > max) console.log(`    … and ${changes.length - max} more`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (cmd === 'hook') {
    // Never block or break the agent: swallow everything and exit 0.
    try {
      const input = JSON.parse(await readStdin());
      handleHook(input);
    } catch (_) {}
    process.exit(0);
  }

  if (cmd === 'prune' && args.auto) {
    // From the SessionStart hook: stdout there is added to Claude's context, so stay silent.
    try { require('./lib/prune').autoPrune(); } catch (_) {}
    process.exit(0);
  }

  const store = new Store(args.root || process.cwd());

  switch (cmd) {
    case 'log': {
      const events = store.events();
      const limit = Number(args.limit || 20);
      if (!events.length) { console.log(`No changes recorded yet for ${store.root}`); return; }
      for (const e of events.slice(-limit)) {
        console.log(`${e.id}  ${fmtTime(e.t)}  [${e.tool}] ${e.summary.split('\n')[0].slice(0, 80)}`);
        printChanges(e.changes, 5);
      }
      return;
    }
    case 'show': {
      const e = store.events().find((x) => x.id === args._[0]);
      if (!e) throw new Error(`no such event: ${args._[0]}`);
      console.log(`${e.id}  ${fmtTime(e.t)}  [${e.tool}]\n${e.summary}\n`);
      printChanges(e.changes);
      return;
    }
    case 'undo':
    case 'restore': {
      const events = store.events();
      let id = args._[0];
      if (!id) {
        if (cmd === 'restore') throw new Error('usage: oops restore <id> [--file P] [--after]');
        // Undo the most recent event, including a previous restore (so `undo` twice = redo).
        const last = events[events.length - 1];
        if (!last) { console.log('Nothing to undo.'); return; }
        id = last.id;
      }
      const file = typeof args.file === 'string' ? args.file.split(path.sep).join('/') : undefined;
      const changes = args.after ? restoreAfter(store, id, file) : restoreBefore(store, id, file);
      if (!changes.length) { console.log('Already in that state, nothing to restore.'); return; }
      console.log(`Restored ${changes.length} file(s):`);
      printChanges(changes.map((c) => ({ p: c.p, b: c.b, a: c.a })));
      console.log('\nThis restore is itself recorded — run `oops undo` again to revert it.');
      return;
    }
    case 'prune': {
      const { pruneStore, allStores, keepDaysSetting, dirSize } = require('./lib/prune');
      const keepDays = args['keep-days'] !== undefined ? Number(args['keep-days']) : keepDaysSetting();
      if (!Number.isFinite(keepDays) || keepDays < 0) throw new Error('--keep-days must be a number ≥ 0');
      if (keepDays === 0 && args['keep-days'] === undefined) { console.log('Cleanup is off (OOPS_KEEP_DAYS=0).'); return; }
      const stores = args.all ? allStores() : [store];
      const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;
      for (const s of stores) {
        const r = pruneStore(s, { keepDays, dryRun: !!args['dry-run'] });
        console.log(`${s.root}\n  ${args['dry-run'] ? 'would remove' : 'removed'} ${r.removedSteps} step(s) older than ${keepDays} day(s), kept ${r.keptSteps}; ` +
          `${args['dry-run'] ? 'would free' : 'freed'} ${mb(r.freedBytes)} (${r.removedBlobs} snapshots). History now ${mb(dirSize(s.dir))}.`);
      }
      return;
    }
    case 'ui': {
      const { startServer } = require('./lib/server');
      await startServer(store, { port: Number(args.port || 0), open: !args['no-open'] });
      return;
    }
    default:
      console.log(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(2, 14).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
      if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`oops: ${e.message}`);
  process.exit(1);
});
