# ⚡ Aztrx

> **Autonomous runtime stress-tester, deterministic bug minimizer, and self-healing engine for web applications.**

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg?style=flat-square)](https://nodejs.org)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=flat-square)](LICENSE)

Aztrx drives your web app like a hostile user — clicking, entering boundary data, and racing asynchronous UI states. When a runtime crash occurs (even one swallowed by a React Error Boundary), Aztrx intercepts it via the Chrome DevTools Protocol, maps it back to the exact source line, shrinks the interaction trace to the bare minimum with **ddmin**, and emits an executable, standalone **Playwright test** that proves the bug — not a log line.

![aztrx demo](media/demo.gif)

---

## Why Aztrx

- **Sees swallowed errors.** Error Boundaries and `window.onerror` miss the errors your app *catches*. Aztrx reads the real throw-site stack off the `Error` object, so a crash you've never seen in your logs becomes a finding you can't ignore.
- **Proves, not reports.** Every crash/error finding ships with an executable `.spec.ts` and a flake-rate verdict — `[deterministic 5/5]`, `[flaky 3/5]`, or `[unreliable]`.
- **Heals, not just finds.** `--heal` generates a patch through an LLM, gates it (redaction + AST safety), compiles it, and replays it against the repro inside an isolated git worktree — the patch is verified before a human ever sees it.
- **Safe by default.** A deny-by-default network guard blocks off-origin calls, and a destructive-action deny-list refuses to click "delete", "pay", or "logout".

---

## Quickstart

Run against any running local dev server — no install, no repo clone:

```bash
npx aztrx run http://localhost:3000              # deterministic walk
npx aztrx run http://localhost:3000 --fuzz       # seeded chaos (replayable)
npx aztrx run http://localhost:3000 --fuzz --repro   # + minimize → compile → validate
```

Install it globally once it's published:

```bash
npm i -g aztrx
aztrx run http://localhost:3000 --repro
```

> **Not on npm yet?** Install from source (contributors):
> ```bash
> git clone https://github.com/DanisChaparov/aztrx
> cd aztrx
> npm install
> npm run build
> npm link        # puts `aztrx` on your PATH
> ```

Aztrx drives Chromium through Playwright — the first run downloads the browser
automatically (`npx playwright install chromium` to force it).

---

## Features & Workflows

### 1. Initialize configuration

Scaffold `aztrx.config.ts`, detect the framework + dev port, and seed `.aztrx/` into `.gitignore`:

```bash
npx aztrx init
```

### 2. Autonomous healing (`--heal`)

Locate the crash, hand the redacted context to an LLM, run a TypeScript check and Playwright validation inside an isolated worktree, and write a verified `.patch` file:

```bash
export ANTHROPIC_API_KEY="your-api-key"
npx aztrx run http://localhost:3000 --fuzz --repro --heal
```

### 3. Live studio dashboard

Inspect real-time telemetry events and triage findings in the built-in web UI:

```bash
npx aztrx studio
# → listening at http://localhost:7331
```

### 4. Cloud & CI ingest (`--upload`)

Stream sanitized, deduplicated crash fingerprints and metrics to your team's ingest server:

```bash
npx aztrx run http://localhost:3000 --upload --api-key <YOUR_API_KEY> --cloud-url http://localhost:8787
```

### 5. GitHub Action

Ship a runtime gate on every PR — see [Continuous Integration](#continuous-integration-github-action) below.

---

## CLI reference

| Flag | Description | Default |
| --- | --- | --- |
| `--fuzz` | Seeded chaos fuzzing instead of the deterministic walk | — |
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
| `--pr-comment [path]` | Write a GitHub PR markdown comment | `.aztrx/pr-comment.md` |
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
├── events.jsonl                 # run log, streamed by `aztrx studio`
├── telemetry/dataset.jsonl      # opt-in anonymized tuple dataset
└── pr-comment.md                # GitHub PR markdown (with --pr-comment)
```

---

## Architecture

Aztrx is a decoupled, event-driven pipeline — modules talk only through an
`EventBus`; the orchestrator wires them together.

```
[ CDP interceptor ] ──▶ [ action ring buffer ] ──▶ [ classifier (fingerprint) ]
                                │
[ verified .patch ] ◀── [ LLM healer ] ◀── [ ddmin minimizer ] ◀── [ sourcemap resolver ]
                                │
                   [ Playwright spec (.spec.ts) ] ──▶ [ flake-rate validator ]
```

| Module | Role |
| --- | --- |
| `interceptor.ts` | Captures raw runtime errors and CDP console/network events |
| `recorder.ts` | Rolling action buffer with deterministic selector cascades |
| `classifier.ts` | Hashes call sites + messages into deduplicated crash fingerprints |
| `resolver.ts` | Maps minified frames to source files, lines, and snippets via sourcemaps |
| `minimizer.ts` | ddmin delta-debugging — eliminates irrelevant actions |
| `specCompiler.ts` | Emits standalone, clean Playwright test scripts |
| `validator.ts` | Multi-pass replays → `deterministic` / `flaky` / `unreliable` |
| `heal/` | Redact → generate → AST gate → sandbox → `tsc` → verify (F10) |
| `networkGuard.ts` | Deny-by-default network policy (F6) |

---

## Continuous Integration (GitHub Action)

Runtime gate on every PR. The action boots your dev server, runs
`aztrx run --fail-on --repro --heal`, posts a markdown comment with the
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
      - uses: DanisChaparov/aztrx@main
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
    uses: DanisChaparov/aztrx/.github/workflows/aztrx-pr.yml@main
    with:
      url: http://localhost:3000
      start-command: npm run dev
    secrets:
      anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

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

## Security invariants

- **Deny-by-default network** — only the target origin (plus explicit `--allow-host`) is reachable.
- **Destructive-action deny-list** — never clicks delete / pay / logout.
- **`.aztrx/` is gitignored** on `init` — repro specs and reports stay out of history.

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
- [ ] Open-source launch — npm publish, `npx aztrx run`, hero screencast
- [x] Hardening — `--auth`/`--storage-state`, tsc compile fast-fail, React 19/Next.js 15 triage
- [x] Real-project benchmark — 13 Next.js App Router targets (100% recall, 100% deterministic repro)
- [x] B2B ($29/mo) — GitHub Action (`action.yml` + reusable workflow), PR bot markdown comment
- [x] B2B ($29/mo) — Smart Cloud Router (haiku fast-tier → verify → Sonnet fallback)
- [x] B2B ($29/mo) — Cloud dashboard (api.aztrx.app)
- [x] Data flywheel — opt-in anonymized patch-tuple collection (F11)

## Contributing

```bash
git clone https://github.com/DanisChaparov/aztrx
cd aztrx
npm install
npx playwright install chromium
npm run build

# smoke fixture (throws on the "Break me" button)
node fixtures/serve.mjs &
node dist/cli.js run http://localhost:8901 --fuzz --repro
```

## License

Apache-2.0 © DanisChaparov
