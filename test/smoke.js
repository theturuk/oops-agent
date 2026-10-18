'use strict';
// End-to-end test: simulates Claude Code calling the hooks, then restores.
// Run: node test/smoke.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'scripts', 'oops.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oops-test-'));
const home = path.join(tmp, 'home');
const proj = path.join(tmp, 'my project');
const env = { ...process.env, OOPS_HOME: home, CLAUDE_PROJECT_DIR: proj };

function hook(event, tool, input, id) {
  execFileSync('node', [CLI, 'hook'], {
    env,
    input: JSON.stringify({ hook_event_name: event, tool_name: tool, tool_input: input, tool_use_id: id, cwd: proj, session_id: 's1' }),
  });
}
function oops(...args) {
  return execFileSync('node', [CLI, ...args, '--root', proj], { env, encoding: 'utf8' });
}
const read = (p) => fs.readFileSync(path.join(proj, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(proj, p));

let n = 0;
function step(name, fn) { fn(); console.log(`ok ${++n} - ${name}`); }

try {
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'src', 'app.js'), 'line1\nline2\n');
  fs.writeFileSync(path.join(proj, '.env'), 'SECRET=1\n');
  fs.writeFileSync(path.join(proj, 'node_modules', 'x', 'i.js'), 'ignored');

  step('Edit is recorded', () => {
    hook('PreToolUse', 'Edit', { file_path: path.join(proj, 'src', 'app.js') }, 't1');
    fs.writeFileSync(path.join(proj, 'src', 'app.js'), 'line1\nCHANGED\n');
    hook('PostToolUse', 'Edit', { file_path: path.join(proj, 'src', 'app.js') }, 't1');
    assert.match(oops('log'), /\[Edit\] src\/app\.js/);
  });

  step('rm -rf via Bash is recorded', () => {
    hook('PreToolUse', 'Bash', { command: 'rm -rf src .env' }, 't2');
    fs.rmSync(path.join(proj, 'src'), { recursive: true });
    fs.rmSync(path.join(proj, '.env'));
    hook('PostToolUse', 'Bash', { command: 'rm -rf src .env' }, 't2');
    const log = oops('log');
    assert.match(log, /- \.env/);
    assert.match(log, /- src\/app\.js/);
    assert.doesNotMatch(log, /node_modules/);
  });

  step('Bash with no file changes is not recorded', () => {
    hook('PreToolUse', 'Bash', { command: 'ls' }, 't3');
    hook('PostToolUse', 'Bash', { command: 'ls' }, 't3');
    assert.strictEqual((oops('log').match(/\[Bash\]/g) || []).length, 1);
  });

  step('undo brings deleted files back', () => {
    oops('undo');
    assert.strictEqual(read('src/app.js'), 'line1\nCHANGED\n');
    assert.strictEqual(read('.env'), 'SECRET=1\n');
  });

  step('undo twice = redo', () => {
    oops('undo');
    assert.ok(!exists('.env') && !exists('src/app.js'));
    oops('undo');
    assert.ok(exists('.env'));
  });

  step('restore to before the first edit', () => {
    const firstId = oops('log').split('\n')[0].split(' ')[0];
    oops('restore', firstId);
    assert.strictEqual(read('src/app.js'), 'line1\nline2\n');
  });

  step('restore a single file', () => {
    fs.writeFileSync(path.join(proj, '.env'), 'SECRET=1\n');
    hook('PreToolUse', 'Write', { file_path: path.join(proj, '.env') }, 't4');
    fs.writeFileSync(path.join(proj, '.env'), 'OVERWRITTEN\n');
    hook('PostToolUse', 'Write', { file_path: path.join(proj, '.env') }, 't4');
    const lines = oops('log').split('\n').filter((l) => /^\S/.test(l));
    const id = lines[lines.length - 1].split(' ')[0];
    oops('restore', id, '--file', '.env');
    assert.strictEqual(read('.env'), 'SECRET=1\n');
  });

  step('failed Bash command that still deleted files is recorded', () => {
    hook('PreToolUse', 'Bash', { command: 'rm src/app.js && false' }, 't5');
    fs.rmSync(path.join(proj, 'src', 'app.js'));
    hook('PostToolUseFailure', 'Bash', { command: 'rm src/app.js && false' }, 't5');
    oops('undo');
    assert.ok(exists('src/app.js'));
  });

  step('PowerShell tool deletions are recorded (Windows)', () => {
    hook('PreToolUse', 'PowerShell', { command: 'Remove-Item src/app.js' }, 't6');
    fs.rmSync(path.join(proj, 'src', 'app.js'));
    hook('PostToolUse', 'PowerShell', { command: 'Remove-Item src/app.js' }, 't6');
    assert.match(oops('log'), /\[PowerShell\] Remove-Item/);
    oops('undo');
    assert.ok(exists('src/app.js'));
  });

  step('changes made while Oops was off show up as an external step', () => {
    fs.rmSync(path.join(proj, 'src', 'app.js')); // no hooks: plugin was off
    hook('PreToolUse', 'Bash', { command: 'echo hi' }, 't7');
    hook('PostToolUse', 'Bash', { command: 'echo hi' }, 't7');
    assert.match(oops('log'), /\[external\][^\n]*\n\s+- src\/app\.js/);
    oops('undo');
    assert.ok(exists('src/app.js'));
  });

  step('agent scratch files in the temp dir are not recorded', () => {
    const scratch = path.join(os.tmpdir(), `oops-scratch-${process.pid}.js`);
    hook('PreToolUse', 'Write', { file_path: scratch }, 't8');
    fs.writeFileSync(scratch, 'x');
    hook('PostToolUse', 'Write', { file_path: scratch }, 't8');
    fs.rmSync(scratch);
    assert.doesNotMatch(oops('log', '--limit', '100'), /oops-scratch/);
  });

  step('2000 steps: hooks stay fast and restore is correct', () => {
    // Write a long history straight into the store, then time a real hook call.
    const { Store } = require('../scripts/lib/store');
    process.env.OOPS_HOME = home;
    const store = new Store(proj);
    const h = store.putBuffer(Buffer.from('v'));
    const lines = [];
    for (let i = 0; i < 2000; i++) lines.push(JSON.stringify({ id: `bulk${i}`, t: Date.now() + i, tool: 'Edit', summary: 'x', changes: [{ p: `bulk/f${i % 20}.txt`, b: h, a: h }] }));
    fs.appendFileSync(store.eventsFile, lines.join('\n') + '\n');
    const t0 = Date.now();
    hook('PreToolUse', 'Bash', { command: 'true' }, 't9');
    hook('PostToolUse', 'Bash', { command: 'true' }, 't9');
    const ms = Date.now() - t0;
    assert.ok(ms < 3000, `two hook calls took ${ms} ms`);
    fs.writeFileSync(path.join(proj, '.env'), 'before\n');
    hook('PreToolUse', 'Write', { file_path: path.join(proj, '.env') }, 't10');
    fs.writeFileSync(path.join(proj, '.env'), 'after\n');
    hook('PostToolUse', 'Write', { file_path: path.join(proj, '.env') }, 't10');
    oops('undo');
    assert.strictEqual(read('.env'), 'before\n');
  });

  step('cleanup removes old steps and their snapshots, keeps everything still needed', () => {
    const { Store } = require('../scripts/lib/store');
    const { pruneStore, autoPrune } = require('../scripts/lib/prune');
    const DAY = 24 * 60 * 60 * 1000;
    process.env.OOPS_HOME = home; // never touch the real ~/.oops-agent
    const store = new Store(proj);
    const oldHash = store.putBuffer(Buffer.from(`only in an old step ${Date.now()}`));
    const newHash = store.putBuffer(Buffer.from(`in a recent step ${Date.now()}`));
    const oldBlob = store.objectPath(oldHash);
    const longAgo = new Date(Date.now() - 2 * DAY);
    fs.utimesSync(oldBlob, longAgo, longAgo);
    fs.appendFileSync(store.eventsFile,
      JSON.stringify({ id: 'ancient', t: Date.now() - 40 * DAY, tool: 'Write', summary: 'old.txt', changes: [{ p: 'old.txt', b: null, a: oldHash }] }) + '\n' +
      JSON.stringify({ id: 'recent', t: Date.now(), tool: 'Write', summary: 'new.txt', changes: [{ p: 'new.txt', b: null, a: newHash }] }) + '\n');

    const dry = pruneStore(store, { keepDays: 30, dryRun: true });
    assert.strictEqual(dry.removedSteps, 1);
    assert.ok(fs.existsSync(oldBlob), 'dry run must not delete');
    assert.match(oops('prune', '--dry-run'), /would remove 1 step/);

    const r = pruneStore(store, { keepDays: 30 });
    assert.strictEqual(r.removedSteps, 1);
    assert.ok(!fs.existsSync(oldBlob), 'snapshot only used by the old step is deleted');
    assert.ok(store.hasBlob(newHash), 'snapshot used by a recent step is kept');
    const ids = store.events().map((e) => e.id);
    assert.ok(!ids.includes('ancient') && ids.includes('recent'));

    // Every remaining step can still be restored.
    for (const e of store.events()) for (const c of e.changes) for (const h of [c.b, c.a]) if (h) assert.ok(store.hasBlob(h), `missing ${h}`);
    fs.writeFileSync(path.join(proj, '.env'), 'x1\n');
    hook('PreToolUse', 'Write', { file_path: path.join(proj, '.env') }, 't11');
    fs.writeFileSync(path.join(proj, '.env'), 'x2\n');
    hook('PostToolUse', 'Write', { file_path: path.join(proj, '.env') }, 't11');
    oops('undo');
    assert.strictEqual(read('.env'), 'x1\n');

    // Automatic cleanup runs at most once a day.
    assert.ok(Array.isArray(autoPrune()));
    assert.strictEqual(autoPrune(), null);
    execFileSync('node', [CLI, 'prune', '--auto'], { env }); // silent, never fails
  });

  step('broken hook input never fails', () => {
    execFileSync('node', [CLI, 'hook'], { env, input: 'not json' });
  });

  step('store lives outside the project', () => {
    assert.ok(!fs.readdirSync(proj).some((f) => f.includes('oops')));
    assert.ok(fs.existsSync(path.join(home, 'projects')));
  });

  console.log(`\nall ${n} tests passed`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
