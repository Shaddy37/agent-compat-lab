# Agent Compat Lab

**Check whether a coding-agent patch works and respects protected files.**

Version 0.1.0: a small, dependency-free checker. This is not yet a cross-agent
benchmark, instruction compatibility test, or production security product.
Requires Node.js 22 or newer. No API keys, installs, or paid model calls for the demo.

## Quick start

```bash
git clone https://github.com/Shaddy37/agent-compat-lab.git
cd agent-compat-lab
node --test cli.test.mjs
node cli.mjs demo
```

If npm is installed, `npm test` and `npm run demo` are equivalent shortcuts.

The demo uses **simulated fixes**, not real Claude Code or Codex output:
the original cart-total function fails; a scripted fix passes; another scripted
fix works but changes a protected file and fails policy. Agent names are labels,
not performance claims.

## New in v0.1

- Custom candidate names, including OpenCode and Hermes, without claiming integrations.
- Compare all existing patches in one command, after checking the broken baseline.
- JSON or Markdown reports, saved without overwriting existing files.
- Read-only setup checks with `doctor`; no automatic installs or paid calls.
- Baseline file manifest, verifier checks, configurable protected paths and timeouts.
- Timestamped results and verification duration, explicitly not agent runtime.
- 43 passing local regression tests; Docker integration still awaits a real run.

```bash
node cli.mjs doctor
node cli.mjs prepare ./practice --agents claude,codex,opencode
# After each agent has produced a patch in its separate environment:
node cli.mjs compare ./practice --format markdown --out ./comparison.md
```

`doctor` checks Node, the Docker CLI, the Docker daemon and the local
`node:22-alpine` image. It does not pull images or start containers.
Missing Docker is expected on machines without Docker installed.

**Upgrading from v0.0.1:** create a new practice folder. Old folders do not contain
the new config and manifest. Existing practice folders are never auto-migrated.

## First real experiment

1. Run `node cli.mjs prepare ./practice`. This creates a new practice folder
   and refuses to overwrite an existing one.
2. Read `practice/TASK.txt`. Keep `baseline/` and `verify.mjs` unchanged.
3. Give Claude Code only a disposable copy of `practice/claude/`, and Codex
   only a disposable copy of `practice/codex/`, plus identical task text.
   **A separate folder is not a sandbox.** Use restricted environments with no
   production credentials or personal files. Do not launch either agent from
   the parent practice folder. This prototype does not start or isolate agents.
4. Copy the resulting files back into their corresponding candidate folders.
   Keep every task-source change,
   including deleted files. Record model version and prompt yourself.
5. Install/start Docker and fetch the verification image yourself:
   `docker pull node:22-alpine`. Verification cannot access the network.
6. Confirm the original bug fails:
   `node cli.mjs check ./practice baseline`.
7. Check both candidates:
   `node cli.mjs check ./practice claude`
   and `node cli.mjs check ./practice codex`.

Instead of checking separately, use `node cli.mjs compare ./practice`.
The comparison stops if the unchanged broken baseline unexpectedly passes or
cannot execute. Individual candidate errors remain visible while other
candidates are checked. There is no winner or leaderboard.

The JSON report separates `tests` from `policy`. Exit codes:
0 = pass, 1 = failed check, 2 = setup/execution error.
A missing Docker image is a setup error, not an agent failure.
Prepare a fresh folder for each experiment.

## Reports

```bash
node cli.mjs check ./practice claude --format markdown --out ./claude-report.md
node cli.mjs compare ./practice --out ./comparison.json
```

Reports must be outside the practice folder; their parent folder must exist.
Existing files and symlink targets are not overwritten. JSON includes raw verifier
output; review it for secrets before sharing. Markdown escapes file names and
shows results, errors and cleanup warnings, without including raw test output.

## Configuration

`prepare` creates `agentlab.json` outside the candidate folders:

```json
{
  "schemaVersion": 1,
  "task": "cart-total",
  "agents": ["claude", "codex"],
  "protectedPaths": ["tests"],
  "timeoutMs": 15000
}
```

Use `--agents` during preparation so matching candidate folders are created.
Names must be unique lowercase letters/digits/hyphens, start with a letter,
and not be reserved names. Maximum: ten candidates.

Protected paths match a file or all files under a directory, not wildcard patterns.
If you edit protection rules, update the prompt supplied to both agents to match.
Configure rules **before** an experiment, never to retroactively improve results.
Timeouts are 100-120000 milliseconds per verification run. The time includes
container startup; it does not time agent work. The built-in cart-total task
is the only supported task in this release.

### Without Docker

Only for code you have reviewed and trust, add `--trust-local-code`:

```bash
node cli.mjs check ./practice claude --trust-local-code
```

**This executes candidate JavaScript on your computer with your permissions.**
It can access files, credentials and the network. It is not isolated; never
use this option for untrusted patches. The built-in demo/tests use this mode
only for fixtures included in this repository.

## What the starter checks

- Four cart-total cases: empty, one item, multiple items and zero-price item.
- Protected `tests/` file additions, edits and deletions.
- File changes before and after verification, not just command exit status.
- A completion record so a plain early exit does not count as a successful test.
- Verifier integrity before execution, rejecting a modified answer key.
- Baseline file hashes before and after execution, compared to a saved manifest.
- Verifier and configuration rechecks after execution.

Docker verification uses read-only input mounts, no network, no capabilities,
a non-root user and resource limits. On interruption it attempts cleanup of
the specifically named verification container. If cleanup cannot be confirmed,
the report says so. A cleanup attempt is not a guarantee.

## Testing status and boundaries

Local Node tests cover real fixture execution, CLI exit codes, validation,
tampering, and protected files. Docker command construction and failure/cleanup
handling are tested with mocks. **Actual Docker execution and actual coding-agent
runs have not been tested in the build environment.**

This is a trusted-user experiment, not a safe service for public submissions.
Candidate code and assertions share a Node process: malicious code could forge
the completion record or interfere with assertions. Docker reduces exposure;
it is not an absolute security boundary. Use a disposable machine for unknown
code. The local timeout does not isolate or reliably terminate descendant processes.

The manifest detects accidental baseline changes; it is not a cryptographic
trust boundary. A malicious actor with parent-folder access can edit both the
manifest and baseline, or tamper with the checker. File hashes do not check modes or empty directories,
nor prove a rule was received or a command executed. Symlinks are rejected.
Concurrent file changes are unsupported. Docker permissions, operating-system
differences, mutable image tags and cleanup failures need integration testing.

## Next milestone

Run a real two-agent experiment before adding agent adapters, arbitrary task
support, instruction variants, token/cost reporting or repeated trials.
One run is not a performance ranking. There is no dashboard or automatic agent
launcher in this release.

## License

No open-source license has been selected yet. This public source repository is
not yet licensed for reuse. The npm package is private and UNLICENSED until the
owner chooses a license.
