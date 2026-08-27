# <img src="media/logo.svg" width="28" height="32" alt="Aztrx logo" align="absmiddle" /> Aztrx AI

> **Autonomous runtime stress-tester, deterministic bug minimizer, and self-healing engine for web applications.**

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg?style=flat-square)](https://nodejs.org)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=flat-square)](LICENSE)

Aztrx AI drives your web app like a hostile user — clicking, entering boundary data, and racing asynchronous UI states. When a runtime crash occurs (even one swallowed by a React Error Boundary), Aztrx AI intercepts it via the Chrome DevTools Protocol, maps it back to the exact source line, shrinks the interaction trace to the bare minimum with **ddmin**, and emits an executable, standalone **Playwright test** that proves the bug — not a log line.

![aztrx demo](media/demo.gif)

---

## Why Aztrx AI

- **Sees swallowed errors.** Error Boundaries and `window.onerror` miss the errors your app *catches*. Aztrx AI reads the real throw-site stack off the `Error` object, so a crash you've never seen in your logs becomes a finding you can't ignore.
- **Proves, not reports.** Every crash/error finding ships with an executable `.spec.ts` and a flake-rate verdict — `[deterministic 5/5]`, `[flaky 3/5]`, or `[unreliable]`.
- **Heals, not just finds.** `--heal` generates a patch through an LLM, gates it (redaction + AST safety), compiles it, runs your test suite, and replays it against the repro inside an isolated git worktree — the patch is verified before a human ever sees it.
- **Safe by default.** A deny-by-default network guard blocks off-origin calls, and a destructive-action deny-list refuses to click "delete", "pay", or "logout".

---

## Quickstart

Run against any running local dev server — no install, no repo clone:

```bash
npx aztrx-cli run http://localhost:3000              # deterministic walk
npx aztrx-cli run http://localhost:3000 --fuzz       # seeded chaos (replayable)
npx aztrx-cli run http://localhost:3000 --fuzz --repro   # + minimize → compile → validate
npx aztrx-cli run http://localhost:3000 --http-fuzz --repro   # server-side 5xx hunt → proof
```

Install it globally:

```bash
npm i -g aztrx-cli
aztrx-cli run http://localhost:3000 --repro
```

Or install from source (contributors):

```bash
git clone https://github.com/DanisChaparov/aztrx
cd aztrx
npm install
npm run build
npm link        # puts `aztrx-cli` on your PATH
```

Aztrx AI drives Chromium through Playwright — the first run downloads the browser
automatically (`npx playwright install chromium` to force it).

---

## Features & Workflows

### 1. Initialize configuration

Scaffold `aztrx.config.ts`, detect the framework + dev port, and seed `.aztrx/` into `.gitignore`:

```bash
npx aztrx-cli init
```

### 2. Autonomous healing (`--heal`)

Locate the crash, hand the redacted context to an LLM, run a TypeScript check and Playwright validation inside an isolated worktree, and write a verified `.patch` file:

```bash
export ANTHROPIC_API_KEY="your-api-key"
npx aztrx-cli run http://localhost:3000 --fuzz --repro --heal
```

### 3. Live studio dashboard

Inspect real-time telemetry events and triage findings in the built-in web UI:

```bash
npx aztrx-cli studio
# → listening at http://localhost:7331
```

### 4. Cloud & CI ingest (`--upload`)

Stream sanitized, deduplicated crash fingerprints and metrics to your team's ingest server:

```bash
npx aztrx-cli run http://localhost:3000 --upload --api-key <YOUR_API_KEY> --cloud-url http://localhost:8787
```

### 5. GitHub Action

Ship a runtime gate on every PR — see [Continuous Integration](#continuous-integration-github-action) below.

### 6. HTTP mutation fuzzing (`--http-fuzz`)

The DOM fuzzer (`--fuzz`) breaks the *client*. `--http-fuzz` attacks the *server*: it harvests the endpoints your app actually calls, then throws hostile requests at them — query overflow, JSON type-confusion, header injection, method confusion — and turns every `5xx` into an executable repro.

Every `5xx` finding also captures the server's *own* error response — its message and body — and, when the body leaks a stack trace, the server-side source line. So a finding reads "`HTTP 500 /api/cart` … `server: Cannot read properties of undefined` at `app/api/cart/route.ts:14`", not just "something 500'd". (Server findings are reported and repro'd but not yet healed — see Roadmap.)

---

## CLI reference

| Flag | Description | Default |
| --- | --- | --- |
| `--fuzz` | Seeded chaos fuzzing instead of the deterministic walk | — |
| `--http-fuzz` | Server-side mutation fuzzing — hostile requests against the target origin | — |
| `--repro` | Minimize (ddmin) → emit Playwright spec → validate flake rate | — |
| `--heal` | Generate + verify an LLM patch (implies `--repro`) | — |
| `--upload` | Stream run findings to the cloud ingest backend | — |
| `--api-key <key>` | Auth key for `--upload` / `--share-data` | `$AZTRX_API_KEY` |
| `--cloud-url <url>` | Ingest server base URL | `https://api.aztrx.app` |
| `--max-actions <n>` | Max actions per pass | `100` |
| `--seed <n>` | PRNG seed for deterministic fuzz | `42` |
| `--repro-runs <n>` | Flake-rate replay iterations | `3` |
| `--heal-model <model>` | Fallback LLM tier | `claude-sonnet-5` |
| `--heal-fast-model <model>` | Fast/cheap first tier | `claude-haiku-4-5` |
| `--test-command <cmd>` | Test command run against a healed patch | `npm test` (auto-detected) |
| `--test-timeout <ms>` | Timeout for the heal test gate | `300000` |
| `--no-test` | Skip the test gate during healing | — |
| `--pr-comment [path]` | Write a GitHub PR markdown comment | `.aztrx/pr-comment.md` |
| `--badge [path]` | Write a self-contained SVG status badge | `.aztrx/badge.svg` |
| `--telemetry` | Collect anonymized tuples locally (opt-in) | — |
| `--share-data` | Also upload the sanitized tuples (opt-in) | — |
| `--repo <path>` | Root path for sourcemap → source resolution | cwd |
| `--allow-host <host>` | Add a host to the network allow-list (repeatable) | — |
| `--auth <path>` / `--storage-state <path>` | Playwright storage-state for authenticated pages | — |
| `--fail-on` | Exit `1` if any crash/error finding is present | — |
| `--dry-run` | Log planned actions without executing them | — |
| `--crash-test` | Throw a deliberate error to verify capture | — |
| `--plain` / `--ui` | Force plain logs / force the live panel | — |

---

## Output artifacts

Every run writes self-contained artifacts inside `.aztrx/` (gitignored):

```
.aztrx/
├── report.html                  # zero-CDN interactive triage report
├── repro/
│   └── 458f6bf71977.spec.ts     # minimal, executable Playwright repro
├── heal/
│   └── fix.patch                # gated, compiler-checked fix
├── events.jsonl                 # run log, streamed by `aztrx-cli studio`
├── telemetry/dataset.jsonl      # opt-in anonymized tuple dataset
├── pr-comment.md                # GitHub PR markdown (with --pr-comment)
└── badge.svg                    # status badge (with --badge)
```

---

## Architecture

Aztrx AI is a decoupled, event-driven pipeline — modules talk only through an
`EventBus`; the orchestrator wires them together.

```
[ CDP interceptor ] ──▶ [ action ring buffer ] ──▶ [ classifier (fingerprint) ]
                                │
[ verified .patch ] ◀── [ LLM healer ] ◀── [ ddmin minimizer ] ◀── [ sourcemap resolver ]
                                │
                   [ Playwright spec (.spec.ts) ] ──▶ [ flake-rate validator ]
```

| Stage | Module | Role |
| --- | --- | --- |
| F1 | `interceptor.ts` | CDP interceptor — captures raw runtime errors and console/network events |
| F2 | `recorder.ts` | Ring buffer of the last 25 actions; selector cascade `data-testid → text → CSS path` |
| F3 | `classifier.ts` | Fingerprints + dedups findings, assigns severity; suppresses `.aztrx/baseline.json` (input) |
| F4 | `resolver.ts` | Maps minified frames to source files, lines, and snippets via sourcemaps |
| F5 | `fuzzer.ts` + `domWalker.ts` | Seeded chaos fuzzer; `domWalker` (F5-lite) discovers interactive elements |
| F6 | `networkGuard.ts` + `domWalker.ts` | Deny-by-default network policy + destructive-action deny-list |
| F7 | `minimizer.ts` | ddmin delta-debugging — eliminates irrelevant actions |
| F8 | `specCompiler.ts` | Emits standalone, clean Playwright `.spec.ts` repro |
| F9 | `validator.ts` | Multi-pass replays → `deterministic` / `flaky` / `unreliable` |
| F10 | `heal/` | Closed-loop healing — redact → generate → AST gate → sandbox → `tsc` → verify |
| F11 | `telemetry/` | Opt-in anonymized crash→repro→patch tuple collection (data flywheel) |
| F12 | `cloud/` | Opt-in cloud sync — streams sanitized findings to the ingest dashboard |

---

## Continuous Integration (GitHub Action)

Runtime gate on every PR. The action boots your dev server, runs
`aztrx-cli run --fail-on --repro --heal`, posts a markdown comment with the
deterministic repro + gated patch, and fails the check on a crash/error.

```yaml
# .github/workflows/ci.yml — composite action, inline
on: pull_request
jobs:
  aztrx:
    runs-on: ubuntu-latest
    permissions: { contents: read, pull-requests: write }
    steps:
      - uses: actions/checkout@v4
      - uses: DanisChaparov/aztrx@8dbf3921b72eaaf0d97c73433994a8aa160c5c69
        with:
          url: http://localhost:3000
          start-command: npm run dev          # optional — boot the app in the background
          token: ${{ github.token }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}   # optional — enables --heal
```

Or as a reusable workflow:

```yaml
on: pull_request
jobs:
  aztrx:
    uses: DanisChaparov/aztrx/.github/workflows/aztrx-pr.yml@8dbf3921b72eaaf0d97c73433994a8aa160c5c69
    with:
      url: http://localhost:3000
      start-command: npm run dev
    secrets:
      anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

---

## Status badge

Hang a live badge in your README that reflects your *actual* crash/error state —
not a static "protected" sticker.

```bash
npx aztrx-cli run http://localhost:3000 --badge badge.svg
```

```markdown
[![aztrx](badge.svg)](https://github.com/DanisChaparov/aztrx)
```

The badge is a self-contained SVG generated from the run's findings — green
`crash-free` or red `N findings`. It's honest because it's *earned*: regenerate it
in CI on every push to `main` and commit it back.

```yaml
# .github/workflows/badge.yml — keep the badge honest on every push to main
on:
  push:
    branches: [main]
jobs:
  badge:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - name: Boot dev server
        run: |
          nohup npm run dev > /tmp/dev.log 2>&1 &
          for i in $(seq 1 60); do
            curl -sS -o /dev/null http://localhost:3000 && break
            sleep 2
          done
      - name: Generate badge
        run: npx --yes aztrx-cli@0.1.0 run http://localhost:3000 --badge badge.svg
      - name: Commit badge
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add badge.svg
          git commit -m "chore: update aztrx badge" || echo "no change"
          git push
```

No `--fail-on` here on purpose: the badge reflects the findings whatever they
are, and the run still exits 0 so the commit step always runs. Swap `push` for a
`schedule` cron if you'd rather regenerate daily than on every push.

---

## Smart Cloud Router

`--heal` is backed by a two-tier router. The fast/cheap model
(`claude-haiku-4-5`) generates first; its patch is gated, compiled, and replayed
against the repro. If the bug still reproduces — or the patch fails a gate —
aztrx falls back to `claude-sonnet-5` and tries again. Most one-line fixes never
pay for the big model. Tiers are configurable via `AZTRX_FAST_MODEL` /
`AZTRX_MODEL` or `--heal-fast-model` / `--heal-model`.

## Telemetry & privacy

Off by default and strictly opt-in. `--telemetry` collects the anonymized tuple
`[crash_fingerprint, min_repro_spec, verified_patch, framework_metadata,
model_tier_used]` locally (nothing leaves the machine); `--share-data` uploads it
to the telemetry endpoint. Every field passes a sanitizer that irreversibly
strips secrets, anonymizes URLs to `<host>`, and scrubs repo paths to `<repo>`.
Uploads are fire-and-forget, bounded by a 2s timeout, and never affect the exit
code.

## Security & data flow

**Local-first by default.** A run never phones home unless you pass an opt-in
flag. By default nothing leaves your machine — no telemetry, no cloud sync, no
LLM call.

| What | Leaves your machine | When |
| --- | --- | --- |
| `run` (default) | nothing | — |
| `--heal` | redacted file + redacted error/stack, to the LLM API | only with `--heal` + `ANTHROPIC_API_KEY` |
| `--share-data` | a sanitized crash→repro→patch tuple | explicit opt-in |
| `--upload` | sanitized findings + counts | explicit opt-in |

### Invariants

- **Sourcemap containment.** A hostile sourcemap or stack URL can't read outside
  your repo: every path is resolved against the repo root and rejected if it
  escapes it — including through symlinks. Secret-bearing files (`.env`, `.npmrc`,
  private keys) are never read into a report or PR comment.
- **Redaction before the model.** `--heal` redacts common secret patterns (keys,
  tokens, credentials) from the file, error, and stack before they're sent; only
  the repo-relative path and line/column are visible. Redaction is heuristic — it
  is not a substitute for not committing secrets.
- **Isolated sandbox, no commits.** Patches land in a detached `git worktree` in
  the OS temp dir — never your working tree. Aztrx AI never commits. A patch must
  parse, add no new imports / `eval` / `child_process`, typecheck, *and* pass your
  own test suite before it's offered as a `.patch` for you to review.
- **Deny-by-default network.** Only the target origin (plus explicit
  `--allow-host`) is reachable; off-origin calls are blocked.
- **Destructive-action deny-list.** Never clicks delete / pay / logout.
- **Studio is localhost-only.** The dashboard binds `127.0.0.1` with no wildcard
  CORS.
- **`.aztrx/` is gitignored** on `init` — repro specs, reports, and patches stay
  out of history.
- **Pinned supply chain.** The GitHub Action pins `aztrx-cli@0.1.0` (never
  `@latest`).

---

## Open benchmark

The detector is scored against a 13-target corpus of **real Next.js App Router
apps** — one seeded runtime bug per app across the archetype matrix (null deref,
async race, JSON parse, stack overflow, Server Action, route transition, and more).

| metric | value |
| --- | --- |
| seeded bugs | 13 |
| detection recall | **100%** (13 / 13) |
| deterministic repros | **100%** (12 / 12) |
| repro not attempted | 1 (mount-time bug, no action history) |
| unseeded findings | 5 — two root causes (`/api/cart` → 500, Server Action → 500) |

```bash
cd bench/frameworks
npm install                  # once — installs next/react for the target apps
npm run bench                # detection
npm run bench:repro          # detection + repro scoring
```

Full per-case table and scoring notes live in
[`bench/frameworks/RESULTS.md`](bench/frameworks/RESULTS.md).

---

## Roadmap

- [x] Closed-loop healing — redact → generate → gate → sandbox → verify (F10)
- [ ] Open-source launch — npm publish, `npx aztrx-cli run`, hero screencast
- [x] Hardening — `--auth`/`--storage-state`, tsc compile fast-fail, React 19/Next.js 15 triage
- [x] Real-project benchmark — 13 Next.js App Router targets (100% recall, 100% deterministic repro)
- [x] B2B ($29/mo) — GitHub Action (`action.yml` + reusable workflow), PR bot markdown comment
- [x] B2B ($29/mo) — Smart Cloud Router (haiku fast-tier → verify → Sonnet fallback)
- [x] B2B ($29/mo) — Cloud dashboard (api.aztrx.app)
- [x] Data flywheel — opt-in anonymized patch-tuple collection (F11)
- [ ] Server-side healing — heal server `5xx` findings (verify a patch by booting the patched server, not static-serving it)

## Contributing

```bash
git clone https://github.com/DanisChaparov/aztrx
cd aztrx
npm install
npx playwright install chromium
npm run build

# smoke fixture (throws on the "Break me" button)
node fixtures/serve.mjs &
node dist/cli.js http://localhost:8901/crash.html --repo fixtures --repro
# → one ● crash mapped to crash.html:13:15, minimized to 1 step
```

## License

Apache-2.0 © DanisChaparov
