# <img src="media/logo.svg" width="28" height="32" alt="Aztrx logo" align="absmiddle" /> Aztrx AI

> **Catch the runtime crash your Error Boundary hid — and prove it with a test, not a log line.**

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg?style=flat-square)](https://nodejs.org)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=flat-square)](LICENSE)

Aztrx AI finds **runtime** bugs, not security holes. It drives your web app like a hostile
user and catches the crashes that ship to real users — *including ones a React Error Boundary
swallows* (the errors `window.onerror` never sees). Each crash comes back as an exact source
line plus an executable **Playwright repro** that fails `3/3` times. Then it fixes it.

```bash
npx aztrx-cli run http://localhost:3000          # find crashes — zero setup, no key
npx aztrx-cli run http://localhost:3000 --fix    # fix them — free for common bugs
```

![aztrx demo](media/demo.gif)

---

## Why Aztrx AI

- **Sees swallowed errors.** Error Boundaries and `window.onerror` miss the errors your app *catches*. Aztrx reads the real throw-site stack off the `Error` object — a crash you've never seen in your logs becomes a finding you can't ignore.
- **Proves, not reports.** Every crash ships with an executable `.spec.ts` repro and a flake-rate verdict — `[deterministic 3/3]`, `[flaky 3/5]`, or `[unreliable]`.
- **Safe by default.** A deny-by-default network guard blocks off-origin calls, a destructive-action deny-list refuses to click "delete", "pay", or "logout", and nothing leaves your machine unless you opt in.

---

## Quickstart

```bash
npm i -g aztrx-cli                        # or use npx — no install needed

aztrx-cli run http://localhost:3000       # 1. find the crashes (no key, no account)
aztrx-cli run http://localhost:3000 --repro   # 2. prove them with an executable test
aztrx-cli run http://localhost:3000 --fix     # 3. fix them
```

Point it at any running dev server. It drives Chromium through Playwright (the first run
downloads the browser automatically).

---

## Fix it — free for common crashes

`--fix` has two engines:

**1. Free, no key.** For the most common crash — `Cannot read properties of
undefined/null` — a built-in rule adds `?.` (optional chaining) and applies the fix. No LLM,
no key, no cost:

```bash
aztrx-cli run http://localhost:3000 --fix   # works out of the box for null/undefined derefs
```

**2. Your model, for complex bugs.** Logic errors, races, and anything the rule can't handle
— point it at any model:

```bash
# Anthropic
export ANTHROPIC_API_KEY="sk-ant-..."

# or any OpenAI-compatible provider: OpenAI, Grok, DeepSeek, Gemini, Kimi, OpenRouter, Ollama
export AZTRX_API_BASE="https://openrouter.ai/api/v1"
export AZTRX_API_KEY="your-key"
export AZTRX_MODEL="anthropic/claude-sonnet-5"
```

Every fix is redacted, sandboxed in a detached git worktree, compiler-checked, and gated on
your test suite before you see it. Aztrx never commits. `--pr` opens a merge-ready PR;
`--regression-test` drops the repro into your test dir so the bug can't come back.

---

## More ways to run

| Flag | What it does |
| --- | --- |
| `--fuzz` | coverage-guided chaos fuzz — steers toward code it hasn't reached |
| `--http-fuzz` | attack the server's endpoints (turns every `5xx` into a repro) |
| `--swarm` / `--workers N` | parallel detection workers |
| `--login` | auto-login to test authenticated pages |
| `--badge` / `--pr-comment` / `--fail-on` | CI artifacts |
| `modernize <file>` | rewrite legacy JS/TS into modern idiomatic syntax |
| `studio` | live dashboard on `localhost:7331` |

Full list: `aztrx-cli run --help`, or the [CLI reference](#cli-reference).

---

## Security

- **Local-first.** Nothing leaves your machine unless you opt in.
- **Never commits.** Fixes land in a detached worktree for your review.
- **Redacted.** Secrets are stripped from the file, error, and stack before any LLM call.
- **Deny-by-default network.** Off-origin calls are blocked; destructive clicks (delete/pay/logout) are refused.
- **`.aztrx/` is gitignored** — repros, reports, and patches stay out of history.

---

## Continuous Integration (GitHub Action)

Runtime gate on every PR — boots your dev server, runs
`aztrx-cli run --fail-on --repro --heal`, posts a comment with the repro + patch, and fails on
a crash/error.

```yaml
# .github/workflows/ci.yml — composite action, inline
on: pull_request
jobs:
  aztrx:
    runs-on: ubuntu-latest
    permissions: { contents: read, pull-requests: write }
    steps:
      - uses: actions/checkout@v4
      - uses: Aztrx-AI/aztrx@v0.4.3
        with:
          url: http://localhost:3000
          start-command: npm run dev          # optional — boot the app in the background
          token: ${{ github.token }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}   # optional — enables --heal
```

A status badge (`--badge`) and PR comment (`--pr-comment`) work the same way — regenerate in
CI on every push.

---

## CLI reference

`aztrx-cli run --help` is grouped by intent (Detect / Prove / Fix / Report & ship / Auth);
the table below is the complete reference — including flags hidden from `--help` (aliases and
niche tuning knobs).

| Flag | Description | Default |
| --- | --- | --- |
| `--fuzz` | Seeded chaos fuzzing instead of the deterministic walk | — |
| `--http-fuzz` | Server-side mutation fuzzing — hostile requests against the target origin | — |
| `--http-fuzz-mutations` | With `--http-fuzz`: also send POST/PUT body mutations (default: GET-only) | — |
| `--repro` | Minimize (ddmin) → emit Playwright spec → validate flake rate | — |
| `--heal` | Generate + verify a fix (implies `--repro`) | — |
| `--fix` | Find → explain → heal → apply — the one-command fix (free for null/undefined derefs) | — |
| `--magic-fix` | Hidden alias for `--fix` (deprecated) | — |
| `--explain` | Print a human-language summary of the findings | — |
| `--yes` / `-y` | Auto-apply verified fixes without prompting (with `--fix`) | — |
| `--pr` | Open a merge-ready PR with the verified fixes (with `--fix`) | — |
| `--lang <code>` | Language for the human-language summary (`en`, `ru`) | `en` |
| `--upload` | Stream run findings to the cloud ingest backend | — |
| `--api-key <key>` | Auth key for `--upload` / `--share-data` | `$AZTRX_API_KEY` |
| `--cloud-url <url>` | Ingest server base URL | `https://api.aztrx.app` |
| `--max-actions <n>` | Max actions per pass | `100` |
| `--seed <n>` | PRNG seed for deterministic fuzz | `42` |
| `--workers <n>` | Number of parallel detection workers | `1` |
| `--swarm` | Auto-size the swarm to CPU cores (capped at 8) | — |
| `--repro-runs <n>` | Flake-rate replay iterations | `3` |
| `--heal-model <model>` | Fallback LLM tier | `claude-sonnet-5` / `$AZTRX_MODEL` |
| `--heal-fast-model <model>` | Fast/cheap first tier | `claude-haiku-4-5-20251001` / `$AZTRX_FAST_MODEL` |
| `--test-command <cmd>` | Test command run against a healed patch | `npm test` (auto-detected) |
| `--test-timeout <ms>` | Timeout for the heal test gate | `300000` |
| `--no-test` | Skip the test gate during healing | — |
| `--start-command <cmd>` | Command to boot the app for server healing | `scripts.dev` → `scripts.start` |
| `--pr-comment [path]` | Write a GitHub PR markdown comment | `.aztrx/pr-comment.md` |
| `--badge [path]` | Write a self-contained SVG status badge | `.aztrx/badge.svg` |
| `--regression-test [dir]` | Copy validated repro specs into the project test dir | `e2e/` or `tests/` |
| `--telemetry` | Collect anonymized tuples locally (opt-in) | — |
| `--share-data` | Also upload the sanitized tuples (opt-in) | — |
| `--repo <path>` | Root path for sourcemap → source resolution | cwd |
| `--allow-host <host>` | Add a host to the network allow-list (repeatable) | — |
| `--storage-state <path>` | Playwright storage-state for authenticated pages | — |
| `--auth <path>` | Hidden alias for `--storage-state` | — |
| `--login` | Auto-login before the pass (needs `AZTRX_AUTH_EMAIL`/`AZTRX_AUTH_PASSWORD`) | — |
| `--login-email <email>` | Email for `--login` (default: `$AZTRX_AUTH_EMAIL`) | — |
| `--login-password <pass>` | Password for `--login` (default: `$AZTRX_AUTH_PASSWORD`) | — |
| `--login-url <url>` | Explicit login page URL for `--login` (default: current page) | — |
| `--fail-on` | Exit `1` if any crash/error finding is present | — |
| `--dry-run` | Log planned actions without executing them | — |
| `--crash-test` | Throw a deliberate error to verify capture | — |
| `--plain` / `--ui` | Force plain logs / force the live panel | — |

---

## Output artifacts

Every run writes self-contained artifacts inside `.aztrx/` (gitignored):

```
.aztrx/
├── report.html                  # interactive triage report
├── repro/<id>.spec.ts           # minimal, executable Playwright repro
├── heal/<id>.patch              # gated, compiler-checked fix (one per finding)
├── events.jsonl                 # run log (streamed by `aztrx-cli studio`)
├── pr-comment.md                # GitHub PR markdown (with --pr-comment)
└── badge.svg                    # status badge (with --badge)
```

---

## Contributing

```bash
git clone https://github.com/Aztrx-AI/aztrx
cd aztrx
npm install
npx playwright install chromium
npm run build

# smoke fixture (throws on the "Break me" button)
node fixtures/serve.mjs &
node dist/cli.js http://localhost:8901/crash.html --repo fixtures --repro
# → one ● crash mapped to crash.html:13:15, minimized to 1 step
```

## Support

If Aztrx AI saved you hours of debugging, you can support the author directly —
name a fair price on Polar.sh:

**[Donate on Polar.sh →](https://buy.polar.sh/polar_cl_f1vBaxUv3S4fJ0o28GfgzQz7gHDHXkecCQtxY0WqeFs)**

## License

Apache-2.0 © DanisChaparov
