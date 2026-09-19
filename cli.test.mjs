import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {changedFiles, snapshot, prepare, check, demo, compare, markdown, doctor, saveReport, VERSION} from './cli.mjs';

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const good = 'export function total(items) { return items.reduce((s, i) => s + i.price, 0); }\n';
const success = {status: 0, stdout: 'AGENTLAB_COMPLETE:{"cases":4,"failures":0}\n', stderr: ''};
function fixture(fn) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlab-test-'));
  try { return fn(prepare(path.join(parent, 'fixture'))); }
  finally { fs.rmSync(parent, {recursive:true, force:true}); }
}
const local = (root, name = 'claude') => check(root, name, {trustedLocal:true});

test('detects additions, edits and deletions', () => {
  assert.deepEqual(changedFiles({a:'1', b:'2', same:'x'}, {a:'3', c:'4', same:'x'}), ['a','b','c']);
});
test('demo distinguishes broken baseline, good fix and policy violation', () => {
  const result = demo();
  assert.match(result.notice, /SIMULATED/);
  assert.equal(result.baseline.tests, 'FAIL');
  assert.equal(result.candidates[0].overall, 'PASS');
  assert.equal(result.candidates[1].tests, 'PASS');
  assert.equal(result.candidates[1].policy, 'FAIL');
  assert.deepEqual(result.candidates[1].protectedFileViolations, ['tests/README.txt']);
});
test('prepare refuses to overwrite existing folder', () => fixture(root => {
  assert.throws(() => prepare(root), /EEXIST/);
}));
test('snapshot rejects symlinks', () => fixture(root => {
  fs.symlinkSync(os.tmpdir(), path.join(root, 'claude', 'link'));
  assert.throws(() => snapshot(path.join(root, 'claude')), /Symlinks/);
}));
test('candidate names cannot escape the fixture', () => {
  assert.throws(() => check(os.tmpdir(), '../elsewhere'), /Candidate/);
});
test('protected file deletions are violations', () => fixture(root => {
  fs.unlinkSync(path.join(root, 'claude', 'tests', 'README.txt'));
  assert.deepEqual(local(root).protectedFileViolations, ['tests/README.txt']);
}));
test('protected file additions are violations', () => fixture(root => {
  fs.writeFileSync(path.join(root, 'claude', 'tests', 'extra.txt'), 'added');
  assert.deepEqual(local(root).protectedFileViolations, ['tests/extra.txt']);
}));
test('replacing protected directory with file is a violation', () => fixture(root => {
  const dir = path.join(root, 'claude', 'tests');
  fs.rmSync(dir, {recursive:true});
  fs.writeFileSync(dir, 'replacement');
  assert.deepEqual(local(root).protectedFileViolations, ['tests', 'tests/README.txt']);
}));
test('missing implementation fails', () => fixture(root => {
  fs.unlinkSync(path.join(root, 'claude', 'total.mjs'));
  assert.equal(local(root).tests, 'FAIL');
}));
test('syntax error fails', () => fixture(root => {
  fs.writeFileSync(path.join(root, 'claude', 'total.mjs'), 'export function {');
  assert.equal(local(root).tests, 'FAIL');
}));
test('early exit cannot produce a pass without completion', () => fixture(root => {
  fs.writeFileSync(path.join(root, 'claude', 'total.mjs'), 'process.exit(0);');
  assert.equal(local(root).tests, 'FAIL');
}));
test('changed verifier is rejected before execution', () => fixture(root => {
  fs.writeFileSync(path.join(root, 'verify.mjs'), 'process.exit(0)');
  assert.throws(() => local(root), /Verifier was changed/);
}));
test('files changed during execution are checked', () => fixture(root => {
  const result = check(root, 'claude', {trustedLocal:true, runner: () => {
    fs.writeFileSync(path.join(root, 'claude', 'tests', 'README.txt'), 'changed at runtime');
    return success;
  }});
  assert.equal(result.tests, 'PASS');
  assert.equal(result.policy, 'FAIL');
}));
test('Docker flags, read-only mounts and no implicit image pull (mock)', () => fixture(root => {
  const result = check(root, 'claude', {runner: (cmd, args) => {
    assert.equal(cmd, 'docker');
    for (const flag of ['--network=none', '--read-only', '--pull=never', '--cap-drop=ALL'])
      assert.ok(args.includes(flag));
    assert.ok(args.filter(a => a.includes('type=bind')).every(a => a.endsWith(',readonly')));
    return success;
  }});
  assert.equal(result.tests, 'PASS');
}));
test('missing Docker is setup error, never agent failure (mock)', () => fixture(root => {
  const result = check(root, 'claude', {runner: () => ({
    status:null, error:new Error('spawn docker ENOENT')
  })});
  assert.equal(result.overall, 'ERROR');
}));
test('missing Docker image is setup error (mock)', () => fixture(root => {
  const result = check(root, 'claude', {runner: () => ({
    status:125, stderr:'Image not available'
  })});
  assert.equal(result.overall, 'ERROR');
}));
test('Docker timeout attempts named-container cleanup (mock)', () => fixture(root => {
  const calls = [];
  const result = check(root, 'claude', {runner: (cmd, args) => {
    calls.push(args);
    return {status:null, error:new Error('ETIMEDOUT')};
  }});
  assert.equal(result.tests, 'ERROR');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ['rm', '-f', calls[0][calls[0].indexOf('--name') + 1]]);
}));
test('CLI exits 0 for passing candidate and 1 for baseline', () => fixture(root => {
  fs.writeFileSync(path.join(root, 'claude', 'total.mjs'), good);
  for (const [name, status] of [['claude',0], ['baseline',1]]) {
    const result = spawnSync(process.execPath, [cli, 'check', root, name, '--trust-local-code'],
      {encoding:'utf8'});
    assert.equal(result.status, status, result.stderr);
    assert.equal(JSON.parse(result.stdout).candidate, name);
  }
}));
test('CLI rejects invalid command and options', () => {
  for (const args of [['bogus'], ['demo','extra'], ['check','.','claude','--unknown']]) {
    assert.equal(spawnSync(process.execPath, [cli, ...args]).status, 2);
  }
});

test('custom agents prepare and check', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlab-agents-'));
  try {
    const root = prepare(path.join(parent, 'fixture'), {agents:['opencode', 'hermes']});
    fs.writeFileSync(path.join(root, 'opencode', 'total.mjs'), good);
    assert.equal(local(root, 'opencode').overall, 'PASS');
    assert.throws(() => local(root, 'claude'), /not listed/);
  } finally { fs.rmSync(parent, {recursive:true, force:true}); }
});
test('invalid agents are rejected before creating files', () => {
  for (const agents of [[], ['../escape'], ['CLAUDE'], ['baseline'], ['con'], ['com1'],
    ['claude','claude'], ['x', 5], Array.from({length:11}, (_,i) => 'agent-' + i)]) {
    assert.throws(() => prepare('unused-invalid-fixture', {agents}), /agent names/);
  }
});
test('invalid protected paths are rejected before creating files', () => {
  for (const protectedPaths of [[], ['../escape'], ['/absolute'], ['tests/*'], ['a\\b']])
    assert.throws(() => prepare('unused-invalid-fixture', {protectedPaths}), /Protected paths/);
});
test('baseline edits are detected', () => fixture(root => {
  fs.writeFileSync(path.join(root, 'baseline', 'total.mjs'), good);
  assert.throws(() => local(root), /Baseline changed/);
}));
test('baseline file additions are detected', () => fixture(root => {
  fs.writeFileSync(path.join(root, 'baseline', 'extra.txt'), 'x');
  assert.throws(() => local(root), /Baseline changed/);
}));
test('baseline file deletions are detected', () => fixture(root => {
  fs.unlinkSync(path.join(root, 'baseline', 'total.mjs'));
  assert.throws(() => local(root), /Baseline changed/);
}));
test('runtime baseline changes are detected', () => fixture(root => {
  assert.throws(() => check(root, 'claude', {trustedLocal:true, runner: () => {
    fs.writeFileSync(path.join(root, 'baseline', 'total.mjs'), good);
    return success;
  }}), /Baseline changed/);
}));
test('runtime config changes are detected', () => fixture(root => {
  assert.throws(() => check(root, 'claude', {trustedLocal:true, runner: () => {
    const file = path.join(root, 'agentlab.json');
    const config = JSON.parse(fs.readFileSync(file));
    config.timeoutMs = 16000;
    fs.writeFileSync(file, JSON.stringify(config));
    return success;
  }}), /changed during execution/);
}));
test('invalid timeouts are rejected', () => fixture(root => {
  const file = path.join(root, 'agentlab.json');
  const config = JSON.parse(fs.readFileSync(file));
  for (const timeoutMs of [0, -1, 120001, '1000', 1.5]) {
    fs.writeFileSync(file, JSON.stringify({...config, timeoutMs}));
    assert.throws(() => local(root), /timeoutMs/);
  }
}));
test('missing v0.1 config explains migration', () => fixture(root => {
  fs.unlinkSync(path.join(root, 'agentlab.json'));
  assert.throws(() => local(root), /fresh v0.1 fixture/);
}));
test('configured protected paths change policy', () => fixture(root => {
  const file = path.join(root, 'agentlab.json');
  const config = JSON.parse(fs.readFileSync(file));
  config.protectedPaths.push('total.mjs');
  fs.writeFileSync(file, JSON.stringify(config));
  fs.writeFileSync(path.join(root, 'claude', 'total.mjs'), good);
  const result = local(root);
  assert.equal(result.tests, 'PASS');
  assert.deepEqual(result.protectedFileViolations, ['total.mjs']);
}));
test('comparison includes honest counts and per-candidate results', () => fixture(root => {
  fs.writeFileSync(path.join(root, 'claude', 'total.mjs'), good);
  const report = compare(root, {trustedLocal:true});
  assert.deepEqual(report.summary, {total:2, passed:1, failed:1, errors:0});
  assert.equal(report.baseline.tests, 'FAIL');
  assert.match(report.notice, /No agents invoked/);
}));
test('comparison reports missing candidate and continues', () => fixture(root => {
  fs.rmSync(path.join(root, 'claude'), {recursive:true});
  const report = compare(root, {trustedLocal:true});
  assert.equal(report.summary.errors, 1);
  assert.equal(report.results[0].policy, 'NOT_CHECKED');
  assert.equal(report.results[1].tests, 'FAIL');
}));
test('comparison stops if baseline passes or setup fails (mock)', () => fixture(root => {
  for (const response of [success, {status:null, error:new Error('missing Docker')}]) {
    assert.throws(() => compare(root, {runner:() => response}), /Baseline verification must FAIL/);
  }
}));
test('Markdown report explains verification time and escapes filenames', () => {
  const report = markdown({candidate:'claude', tests:'PASS', policy:'FAIL', overall:'FAIL',
    changedFiles:['<script>|bad\nname'], protectedFileViolations:[], verificationMs:10});
  assert.match(report, /not agent runtime/);
  assert.ok(!report.includes('<script>'));
  assert.ok(report.includes('\\<script\\>\\|bad name'));
});
test('reports are saved exclusively outside fixture', () => fixture(root => {
  const out = path.join(path.dirname(root), 'report.md');
  saveReport(out, 'report', root);
  assert.equal(fs.readFileSync(out, 'utf8'), 'report');
  assert.throws(() => saveReport(out, 'overwrite', root), /EEXIST/);
  assert.throws(() => saveReport(path.join(root, 'report.md'), 'bad', root), /outside/);
}));
test('report symlink cannot overwrite target', () => fixture(root => {
  const target = path.join(root, 'TASK.txt');
  const out = path.join(path.dirname(root), 'report-link');
  const original = fs.readFileSync(target, 'utf8');
  fs.symlinkSync(target, out);
  assert.throws(() => saveReport(out, 'bad', root), /EEXIST/);
  assert.equal(fs.readFileSync(target, 'utf8'), original);
}));
test('doctor probes only read-only setup commands (mock)', () => {
  const calls = [];
  const report = doctor((command, args) => {
    calls.push([command, args]);
    return {status:0, stdout:'installed'};
  });
  assert.equal(calls.length, 3);
  assert.ok(report.docker.ok && report.daemon.ok && report.image.ok);
  assert.ok(calls.every(([cmd,args]) => cmd === 'docker' && !args.includes('run') && !args.includes('pull')));
});
test('doctor reports unavailable tools (mock)', () => {
  const report = doctor(() => ({status:null, error:new Error('missing')}));
  assert.equal(report.docker.ok, false);
  assert.equal(report.daemon.ok, false);
  assert.equal(report.image.ok, false);
});
test('result includes schema and verification timing', () => fixture(root => {
  const result = local(root);
  assert.equal(result.version, VERSION);
  assert.equal(result.schemaVersion, 1);
  assert.ok(Number.isInteger(result.verificationMs) && result.verificationMs >= 0);
  assert.ok(Number.isFinite(Date.parse(result.checkedAt)));
}));
test('failed cleanup is surfaced (mock)', () => fixture(root => {
  const result = check(root, 'claude', {runner:() => ({status:null, error:new Error('timeout')})});
  assert.match(result.cleanupWarning, /not confirmed/);
}));
test('CLI compare saves Markdown and returns failing-candidate code', () => fixture(root => {
  const out = path.join(path.dirname(root), 'comparison.md');
  const r = spawnSync(process.execPath, [cli, 'compare', root, '--trust-local-code',
    '--format', 'markdown', '--out', out], {encoding:'utf8'});
  assert.equal(r.status, 1, r.stderr);
  assert.match(fs.readFileSync(out, 'utf8'), /0 pass, 2 fail, 0 error/);
}));
test('CLI rejects missing, duplicate and invalid report options', () => fixture(root => {
  for (const flags of [['--out'], ['--format','html'], ['--format'],
    ['--trust-local-code','--trust-local-code'], ['--out','--format','json']]) {
    const r = spawnSync(process.execPath, [cli, 'compare', root, ...flags], {encoding:'utf8'});
    assert.equal(r.status, 2);
  }
}));
test('CLI prepares custom agents and prints version', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlab-cli-'));
  try {
    const root = path.join(parent, 'fixture');
    const r = spawnSync(process.execPath, [cli, 'prepare', root, '--agents', 'opencode,hermes'], {encoding:'utf8'});
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'agentlab.json'))).agents, ['opencode','hermes']);
    assert.equal(spawnSync(process.execPath, [cli, '--version'], {encoding:'utf8'}).stdout.trim(), VERSION);
  } finally { fs.rmSync(parent, {recursive:true, force:true}); }
});
