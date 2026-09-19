#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export function snapshot(root) {
  if (fs.lstatSync(root).isSymbolicLink() || !fs.statSync(root).isDirectory())
    throw new Error('Expected a real directory, not a symlink.');
  const result = Object.create(null);
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const rel = prefix + entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlinks are not supported: ${rel}`);
      if (entry.isDirectory()) walk(absolute, rel + '/');
      else if (entry.isFile()) {
        if (fs.statSync(absolute).size > 10 * 1024 * 1024)
          throw new Error(`File exceeds this prototype's 10MB limit: ${rel}`);
        result[rel] = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
      } else throw new Error(`Unsupported file: ${rel}`);
    }
  }
  walk(root);
  return result;
}

export function changedFiles(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(key => before[key] !== after[key]).sort();
}

const broken = 'export function total(items) { return items.reduce((sum, item) => sum + item.price); }\n';
const fixed = 'export function total(items) { return items.reduce((sum, item) => sum + item.price, 0); }\n';
export const VERSION = '0.1.0';
const RESERVED = new Set(['baseline', 'tests', 'reports', 'node_modules', 'con', 'prn', 'aux', 'nul']);
function validateAgents(agents) {
  if (!Array.isArray(agents) || !agents.length || agents.length > 10 ||
      agents.some(name => typeof name !== 'string' ||
        !/^[a-z][a-z0-9-]{0,39}$/.test(name) || RESERVED.has(name) ||
        /^(com|lpt)[0-9]$/.test(name)) ||
      new Set(agents).size !== agents.length)
    throw new Error('Use 1-10 unique lowercase agent names, for example claude,codex,opencode; no paths or reserved names.');
}
function validatePaths(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.some(p =>
    typeof p !== 'string' || !/^[a-zA-Z0-9_.-]+(\/[a-zA-Z0-9_.-]+)*$/.test(p) ||
    p.split('/').some(part => part === '.' || part === '..')))
    throw new Error('Protected paths must be relative file or folder paths, without wildcards.');
}
function readConfig(root) {
  const file = path.join(root, 'agentlab.json');
  if (!fs.existsSync(file)) throw new Error('Missing agentlab.json. Use prepare to create a fresh v0.1 fixture.');
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Config cannot be a symlink.');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (config.schemaVersion !== 1 || config.task !== 'cart-total')
    throw new Error('Unsupported fixture schema or task.');
  validateAgents(config.agents);
  validatePaths(config.protectedPaths);
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 100 || config.timeoutMs > 120000)
    throw new Error('timeoutMs must be an integer between 100 and 120000.');
  return config;
}
function assertBaseline(root, baseline) {
  const file = path.join(root, 'baseline-manifest.json');
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Manifest cannot be a symlink.');
  const expected = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!expected || Array.isArray(expected) || typeof expected !== 'object' ||
      changedFiles(expected, baseline).length)
    throw new Error('Baseline changed. Create a fresh fixture rather than re-baselining an experiment.');
}
const verifier = `
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
const {total} = await import(pathToFileURL(path.join(process.argv[2], 'total.mjs')).href);
const cases = [
  ['empty cart', [], 0],
  ['one item', [{price: 5}], 5],
  ['multiple items', [{price: 2}, {price: 3}], 5],
  ['zero price', [{price: 0}], 0]
];
let failures = 0;
for (const [name, input, expected] of cases) {
  try { assert.equal(total(input), expected); console.log('PASS: ' + name); }
  catch (error) { failures++; console.log('FAIL: ' + name + ': ' + error.message); }
}
console.log('AGENTLAB_COMPLETE:' + JSON.stringify({cases: cases.length, failures}));
process.exitCode = failures ? 1 : 0;
`;

export function prepare(destination, {agents = ['claude', 'codex'], protectedPaths = ['tests']} = {}) {
  validateAgents(agents);
  validatePaths(protectedPaths);
  const root = path.resolve(destination);
  fs.mkdirSync(root, {recursive: false});
  for (const name of ['baseline', ...agents]) {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, 'tests'), {recursive: true});
    fs.writeFileSync(path.join(dir, 'total.mjs'), broken);
    fs.writeFileSync(path.join(dir, 'tests', 'README.txt'), 'Protected folder: do not edit.\n');
  }
  fs.writeFileSync(path.join(root, 'verify.mjs'), verifier);
  fs.writeFileSync(path.join(root, 'TASK.txt'),
    'Fix total(items) in total.mjs. An empty cart must total 0; other carts must sum item.price. Protected paths (do not add, change or delete files here): ' +
    protectedPaths.join(', ') + '. Work only inside your assigned candidate folder. Do not open or modify the baseline, checker, or other candidate. Do not install dependencies.\n');
  fs.writeFileSync(path.join(root, 'agentlab.json'), JSON.stringify({
    schemaVersion: 1, task: 'cart-total', agents, protectedPaths, timeoutMs: 15000
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'baseline-manifest.json'),
    JSON.stringify(snapshot(path.join(root, 'baseline')), null, 2) + '\n');
  return root;
}

export function check(root, candidateName, {trustedLocal = false, runner = spawnSync} = {}) {
  if (typeof candidateName !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(candidateName))
    throw new Error('Candidate must be a configured agent name or baseline.');
  root = fs.realpathSync(path.resolve(root));
  const config = readConfig(root);
  if (candidateName !== 'baseline' && !config.agents.includes(candidateName))
    throw new Error('Candidate is not listed in agentlab.json.');
  const candidate = path.join(root, candidateName);
  const baseline = snapshot(path.join(root, 'baseline'));
  assertBaseline(root, baseline);
  const before = snapshot(candidate);
  const verifierPath = path.join(root, 'verify.mjs');
  if (fs.lstatSync(verifierPath).isSymbolicLink() ||
      fs.readFileSync(verifierPath, 'utf8') !== verifier)
    throw new Error('Verifier was changed. Create a fresh practice folder.');
  let execution;
  let cleanupError = '';
  const started = performance.now();
  if (trustedLocal) {
    execution = runner(process.execPath, [verifierPath, candidate],
      {encoding: 'utf8', timeout: config.timeoutMs, killSignal: 'SIGKILL',
       maxBuffer: 1024 * 1024, cwd: candidate});
  } else {
    if (root.includes(',') || root.includes('\n')) throw new Error('Unsupported path characters.');
    const containerName = 'agentlab-' + crypto.randomUUID();
    execution = runner('docker', [
      'run', '--rm', '--name', containerName, '--pull=never',
      '--network=none', '--read-only', '--cap-drop=ALL',
      '--security-opt=no-new-privileges', '--pids-limit=64',
      '--memory=256m', '--cpus=1', '--user=65534:65534',
      '--tmpfs=/tmp:rw,noexec,nosuid,size=16m',
      '--mount', `type=bind,source=${candidate},target=/candidate,readonly`,
      '--mount', `type=bind,source=${verifierPath},target=/verify.mjs,readonly`,
      '--workdir=/candidate', 'node:22-alpine', 'node', '/verify.mjs', '/candidate'
    ], {encoding: 'utf8', timeout: config.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024});
    // Killing the Docker client on timeout does not reliably stop its container.
    if (execution.error || execution.signal) {
      const cleanup = runner('docker', ['rm', '-f', containerName],
        {encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL'});
      if (cleanup.error || cleanup.status !== 0)
        cleanupError = 'Container cleanup was not confirmed; inspect Docker before continuing.';
    }
  }
  const verificationMs = Math.round(performance.now() - started);
  assertBaseline(root, snapshot(path.join(root, 'baseline')));
  if (fs.lstatSync(verifierPath).isSymbolicLink() || fs.readFileSync(verifierPath, 'utf8') !== verifier ||
      JSON.stringify(readConfig(root)) !== JSON.stringify(config))
    throw new Error('Checker configuration or verifier changed during execution.');
  const infrastructureError = !!execution.error || execution.status == null ||
    (!trustedLocal && [125, 126, 127].includes(execution.status));
  const completion = 'AGENTLAB_COMPLETE:{"cases":4,"failures":0}';
  const completed = (execution.stdout || '').split(/\r?\n/).includes(completion);
  const tests = infrastructureError ? 'ERROR' :
    execution.status === 0 && completed ? 'PASS' : 'FAIL';
  // Include pre-run and post-run violations; the execution cannot erase evidence.
  const changed = [...new Set([...changedFiles(baseline, before),
    ...changedFiles(baseline, snapshot(candidate))])].sort();
  const violations = changed.filter(file => config.protectedPaths.some(p => file === p || file.startsWith(p + '/')));
  return {
    schemaVersion: 1,
    version: VERSION,
    task: config.task,
    checkedAt: new Date().toISOString(),
    candidate: candidateName,
    execution: trustedLocal ? 'trusted-local (not sandboxed)' : 'docker',
    tests,
    policy: violations.length ? 'FAIL' : 'PASS',
    overall: infrastructureError ? 'ERROR' : tests === 'PASS' && !violations.length ? 'PASS' : 'FAIL',
    changedFiles: changed,
    protectedFileViolations: violations,
    verificationMs,
    cleanupWarning: cleanupError,
    output: execution.stdout || '',
    error: execution.error?.message || execution.stderr || ''
  };
}

export function compare(root, options = {}) {
  root = fs.realpathSync(path.resolve(root));
  const config = readConfig(root);
  // A broken control must fail before candidate results mean anything.
  const baseline = check(root, 'baseline', options);
  if (baseline.tests !== 'FAIL')
    throw new Error('Baseline verification must FAIL before comparison. Check the fixture and Docker setup.');
  const results = config.agents.map(candidate => {
    try { return check(root, candidate, options); }
    catch (error) {
      return {candidate, tests: 'ERROR', policy: 'NOT_CHECKED', overall: 'ERROR',
        changedFiles: [], protectedFileViolations: [], error: error.message};
    }
  });
  return {
    schemaVersion: 1, version: VERSION, task: config.task,
    checkedAt: new Date().toISOString(),
    notice: 'Checks existing patches only. No agents invoked. Verification time is not agent runtime. No cost, model identity or performance ranking is inferred.',
    baseline,
    summary: {
      total: results.length,
      passed: results.filter(r => r.overall === 'PASS').length,
      failed: results.filter(r => r.overall === 'FAIL').length,
      errors: results.filter(r => r.overall === 'ERROR').length
    },
    results
  };
}

export function markdown(report) {
  const escape = value => String(value ?? '').replace(/[\\`*_{}\[\]()<>|#]/g, c => '\\' + c).replace(/[\r\n]+/g, ' ');
  const results = report.results || [report];
  const lines = ['# Agent Compat Lab report', '', report.notice ||
    'Checks an existing patch, not agent performance.', ''];
  if (report.summary) lines.push(
    `Results: ${report.summary.passed} pass, ${report.summary.failed} fail, ${report.summary.errors} error.`, '');
  for (const row of results) {
    lines.push(`## ${escape(row.candidate)}: ${escape(row.overall)}`, '',
      `Tests: ${escape(row.tests)}. Protected files: ${escape(row.policy)}.`,
      `Verification time (not agent runtime): ${row.verificationMs ?? 'unknown'} ms.`, '',
      `Changed files: ${(row.changedFiles || []).map(escape).join(', ') || 'none'}.`,
      `Protected-file violations: ${(row.protectedFileViolations || []).map(escape).join(', ') || 'none'}.`, '');
    if (row.error) lines.push('Error: ' + escape(row.error), '');
    if (row.cleanupWarning) lines.push('Warning: ' + escape(row.cleanupWarning), '');
  }
  lines.push('One fixture is not a benchmark. Results do not prove an instruction was received.');
  return lines.join('\n') + '\n';
}

export function doctor(runner = spawnSync) {
  function probe(command, args) {
    const r = runner(command, args, {encoding:'utf8', timeout:5000, killSignal:'SIGKILL'});
    return {ok: !r.error && r.status === 0,
      detail: (r.error?.message || r.stderr || r.stdout || '').trim().slice(0, 500)};
  }
  return {version: VERSION, node: {ok: Number(process.versions.node.split('.')[0]) >= 22, detail: process.version},
    docker: probe('docker', ['--version']),
    daemon: probe('docker', ['info', '--format', '{{.ServerVersion}}']),
    image: probe('docker', ['image', 'inspect', 'node:22-alpine', '--format', '{{.Id}}']),
    notice: 'Read-only setup checks. No images pulled, containers started, agents launched or API credits spent.'};
}

export function saveReport(destination, text, fixtureRoot) {
  // Reports must stay outside the fixture so they cannot alter measured inputs.
  const target = path.join(fs.realpathSync(path.dirname(path.resolve(destination))), path.basename(destination));
  const root = fs.realpathSync(fixtureRoot);
  const relative = path.relative(root, target);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)))
    throw new Error('Save reports outside the practice folder.');
  fs.writeFileSync(target, text, {flag: 'wx'});
}

export function demo() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlab-'));
  try {
    const root = prepare(path.join(parent, 'fixture'));
    const baseline = check(root, 'baseline', {trustedLocal: true});
    fs.writeFileSync(path.join(root, 'claude', 'total.mjs'), fixed);
    fs.writeFileSync(path.join(root, 'codex', 'total.mjs'), fixed);
    fs.writeFileSync(path.join(root, 'codex', 'tests', 'README.txt'), 'Changed protected file.\n');
    return {
      notice: 'SIMULATED fixtures, not Claude Code or Codex runs. No model calls or measured agent performance.',
      baseline,
      candidates: ['claude', 'codex'].map(name => check(root, name, {trustedLocal: true}))
    };
  } finally { fs.rmSync(parent, {recursive: true, force: true}); }
}

function main(args) {
  const command = args[0];
  if (command === 'demo' && args.length === 1) {
    console.log(JSON.stringify(demo(), null, 2));
  } else if (command === 'doctor' && args.length === 1) {
    const report = doctor();
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = ['node', 'docker', 'daemon', 'image'].every(k => report[k].ok) ? 0 : 2;
  } else if (command === '--version' && args.length === 1) {
    console.log(VERSION);
  } else if (command === 'prepare' && (args.length === 2 ||
      (args.length === 4 && args[2] === '--agents'))) {
    const options = args.length === 4 ? {agents: args[3].split(',')} : {};
    console.log(`Practice fixture created: ${prepare(args[1], options)}\nRead README.md before running agents.`);
  } else if ((command === 'check' && args.length >= 3) || (command === 'compare' && args.length >= 2)) {
    const folder = args[1];
    let trustedLocal = false, format = 'json', out;
    const seen = new Set();
    for (let i = command === 'check' ? 3 : 2; i < args.length; i++) {
      const flag = args[i];
      if (seen.has(flag)) throw new Error('Duplicate option: ' + flag);
      seen.add(flag);
      if (flag === '--trust-local-code') trustedLocal = true;
      else if (['--format', '--out'].includes(flag)) {
        const value = args[++i];
        if (!value || value.startsWith('--')) throw new Error('Missing value for ' + flag);
        if (flag === '--format') format = value; else out = value;
      } else throw new Error('Unknown option: ' + flag);
    }
    if (!['json', 'markdown'].includes(format)) throw new Error('Format must be json or markdown.');
    const result = command === 'compare' ? compare(folder, {trustedLocal}) : check(folder, args[2], {trustedLocal});
    const text = format === 'markdown' ? markdown(result) : JSON.stringify(result, null, 2) + '\n';
    if (out) saveReport(out, text, folder);
    process.stdout.write(text);
    process.exitCode = result.summary ?
      (result.summary.errors ? 2 : result.summary.failed ? 1 : 0) :
      result.overall === 'PASS' ? 0 : result.overall === 'ERROR' ? 2 : 1;
  } else {
    console.log('Agent Compat Lab ' + VERSION + '\nUsage:\n  node cli.mjs doctor\n  node cli.mjs demo\n  node cli.mjs prepare <new-folder> [--agents claude,codex,opencode]\n  node cli.mjs check <folder> <agent|baseline> [--trust-local-code] [--format json|markdown] [--out report-file]\n  node cli.mjs compare <folder> [--trust-local-code] [--format json|markdown] [--out report-file]\n  node cli.mjs --version\nReports must be outside the fixture; existing files are never overwritten.');
    process.exitCode = !command || (command === '--help' && args.length === 1) ? 0 : 2;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
