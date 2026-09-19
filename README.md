# Agent Compat Lab

**Check whether a coding-agent patch works and respects protected files.**

First milestone: a tiny, dependency-free checker. This is not yet a cross-agent
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

## First real experiment

1. Run `node cli.mjs prepare ./practice`. This creates a new practice folder
   and refuses to overwrite an existing one.
2. Read `practice/TASK.txt`. Keep `baseline/` and `verify.mjs` unchanged.
3. Give Claude Code only a disposable copy of `practice/claude/`, and Codex
   only a disposable copy of `practice/codex/`, plus identical task text.
   **A separate folder is not a sandbox.** Use restricted environments with no
   production credentials or personal files. Do not launch either agent from
   the parent practice folder. This prototype does not start or isolate agents.
4. Copy the resulting files back into their corresponding candidate folders,
   excluding agent-created metadata folders. Keep every task-source change,
   including deleted files. Record model version and prompt yourself.
5. Install/start Docker and fetch the verification image yourself:
   `docker pull node:22-alpine`. Verification cannot access the network.
6. Confirm the original bug fails:
   `node cli.mjs check ./practice baseline`.
7. Check both candidates:
   `node cli.mjs check ./practice claude`
   and `node cli.mjs check ./practice codex`.

The JSON report separates `tests` from `policy`. Exit codes:
0 = pass, 1 = failed check, 2 = setup/execution error.
A missing Docker image is a setup error, not an agent failure.
Prepare a fresh folder for each experiment.

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

Docker verification uses read-only input mounts, no network, no capabilities,
a non-root user and resource limits. On interruption it attempts cleanup of
the specifically named verification container.

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

The baseline is not sealed. File hashes do not check modes or empty directories,
nor prove a rule was received or a command executed. Symlinks are rejected.
Concurrent file changes are unsupported. Docker permissions, operating-system
differences, mutable image tags and cleanup failures need integration testing.

## Next milestone

Run a real two-agent experiment before adding agent adapters, general repository
configuration, instruction variants, token/cost reporting or repeated trials.
One run is not a performance ranking. There is no dashboard or automatic agent
launcher in this release.

## License

No open-source license has been selected yet. This public source repository is
not yet licensed for reuse. The npm package is private and UNLICENSED until the
owner chooses a license.
