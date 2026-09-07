# Aztrx AI — The Complete Reference

> Everything about the startup: where it came from, what it's built with, how each
> feature works, the ideas behind it, and the accounts/resources. Written so you can
> understand the whole thing in one read before testing it on real products.

---

## 1. One sentence

**Aztrx AI is an autonomous runtime stress-tester for web apps** — it drives your app
like a hostile user, finds crashes (even ones your React Error Boundary swallows),
maps them to the exact source line, and *proves* each bug with an executable
Playwright repro test instead of a log line. Optionally it heals them too.

The whole pitch is three verbs: **find → prove → fix.**

---

## 2. Origin story (how it got here)

| Date | Event |
| --- | --- |
| before Aug | "Upstream" — an Electron focus-tracker for developers (paid, Polar.sh, Supabase). |
| Aug 2026 | Rebranded to **Aztrx** (still a focus tracker). Bought `aztrx.app`. |
| 2026-08-21 | **Pivot.** The user decided to build a *local CLI stress-tester* instead. PRD v1.0 drafted. |
| 2026-08-22 | Tracker **archived** (tag `archive/focus-tracker-2026-08-22`, not deleted). The stress-tester became a **new startup that took the "Aztrx" name + `aztrx.app` domain**. F1–F9 done. |
| 2026-08-23 | Repo renamed to free the `aztrx` GitHub name; landing page deployed to `aztrx.app` on Vercel; Ink TUI added. |
| late Aug | npm publish → `aztrx-cli` (the bare `aztrx` npm name was taken). |
| now | v0.3.0 live. |

**Key early decisions:**
- **Codename lineage:** `stt/synapse` (stale "SynapseQA") → `seism` (a passing invention) → **`aztrx`** (your choice).
- **Dropped the white-box idea.** The original SynapseQA concept relied on "React Fiber introspection." You dropped it — Aztrx is now **fully black-box**: it drives the browser over CDP and reads errors from `console.error` / `pageerror` / network. That was the right call (it works on React, Next, Vue, Svelte, anything).
- **Open-core.** The CLI core is free (Apache-2.0); the LLM healing + cloud dashboard are the paid Pro/Team layer.

**Who it's for:** solo devs and 2–20 person React/Next.js teams who have no QA.

---

## 3. The stack

| Layer | Tech |
| --- | --- |
| Language | TypeScript (ESM, `"type": "module"`), Node ≥ 18 |
| CLI arg parsing | `commander@12` |
| Terminal UI | `ink@5` + `react@18` (a live React panel in the terminal) |
| Colors | `picocolors` |
| Browser automation | `playwright@1.49` (headless Chromium, drives via Chrome DevTools Protocol) |
| Source maps | `@jridgewell/trace-mapping` |
| Build / run | `tsc` (build), `tsx` (server + bench) |
| Package | `aztrx-cli` (bin `aztrx-cli`) on npm |
| Cloud server | `server/` — TypeScript HTTP ingest (api.aztrx.app) |
| Marketing site | `web/` — Next.js 16 + Tailwind v4, deployed on Vercel (`aztrx.app`) |
| CI | GitHub Actions — `action.yml` (composite) + `.github/workflows/aztrx-pr.yml` (reusable) |
| Payments | Polar.sh (donation link today; the old tracker used Polar $8/mo) |
| Old infra (parked) | Supabase (from the tracker), Vercel project `aztrx` |

The repo is `C:\Users\dchap\aztrx`, GitHub `github.com/DanisChaparov/aztrx`, authored solely as **Danis Chaparov** (no co-author trailer — your explicit preference).

---

## 4. Architecture — how it works under the hood

Aztrx is a **decoupled, event-driven pipeline**. Modules talk only through a typed
`EventBus` (`src/core/eventBus.ts`); the `orchestrator.ts` wires them together (hexagonal
— the orchestrator could be swapped for a cloud sink).

```
[ CDP interceptor ] ─▶ [ action ring buffer ] ─▶ [ classifier (fingerprint) ]
                                │
[ verified .patch ] ◀─ [ LLM healer ] ◀─ [ ddmin minimizer ] ◀─ [ sourcemap resolver ]
                                │
                   [ Playwright spec (.spec.ts) ] ─▶ [ flake-rate validator ]
```

The stages (named F1–F13 in the code):

| Stage | Module | What it does |
| --- | --- | --- |
| F1 | `interceptor.ts` | Captures `console.error`, `pageerror`, renderer `crash`, `requestfailed`, and 5xx responses. `console.error` is the key trick — Error Boundaries log there instead of rethrowing, so `window.onerror` never fires for swallowed errors. |
| F2 | `recorder.ts` | Ring buffer of the last 25 actions + a selector cascade `data-testid → text → CSS path`. |
| F3 | `classifier.ts` | Fingerprints + dedups findings, assigns severity (`crash`/`error`/`warning`/`noise`), suppresses `.aztrx/baseline.json`. |
| F4 | `resolver.ts` | Maps minified stack frames to source files/lines via sourcemaps. |
| F5 | `fuzzer.ts` + `domWalker.ts` | Seeded chaos fuzzer (click/hover/keypress/select/garbage input) + deterministic walk. |
| F5-http | `httpFuzzer.ts` | Harvests the app's real endpoints, throws hostile requests at them (query overflow, JSON type-confusion, header injection), turns every 5xx into a repro. |
| F6 | `networkGuard.ts` | Deny-by-default network policy (only target origin + `--allow-host`). |
| F7 | `minimizer.ts` | `ddmin` delta-debugging — shrinks the action trace to the minimum that still reproduces. |
| F8 | `specCompiler.ts` | Emits a standalone, clean Playwright `.spec.ts`. |
| F9 | `validator.ts` | Replays multiple times → verdict `deterministic` / `flaky` / `unreliable`. |
| F10 | `heal/` | Closed-loop healing: redact → LLM → AST gate → git worktree → `tsc` → test → verify. |
| F11 | `telemetry/` | Opt-in anonymized crash→repro→patch tuples (local, or `--share-data`). |
| F12 | `cloud/` | Opt-in upload of sanitized findings to the dashboard. |
| F13 | `summarize.ts` + `heal/apply.ts` | Human-language "X-ray" summary + opt-in apply of verified patches. |

**The swarm** (`swarm.ts`): one run = a roster of workers, each with its own browser
context, recorder, and classifier. Default is one "walk" worker; `--swarm`/`--workers`
fan out into walk + several fuzz seeds + the HTTP fuzzer, and findings merge by
fingerprint. Auto-size caps at **8 workers** (each is a full Chromium context, ~200–400 MB
RAM).

**LLM layer** (`src/core/llm.ts`): one `complete()` with two transports — Anthropic
native (default) and any OpenAI-compatible `/v1/chat/completions` endpoint, selected by
`AZTRX_API_BASE`.

---

## 5. Features (and how each was built)

### Detection
- **`run <url>`** — deterministic walk: visits every visible `a/button/input/select/textarea/[role=button]/[onclick]`, clicks/fills in document order, and now **recovers from navigation** (re-scan + `goto(startUrl)`) instead of bailing on the first link.
- **`--fuzz`** — seeded chaos (replayable via `--seed`). Richer vocabulary: double-clicks, hover, keypresses, select-option changes, scrolls, garbage input.
- **`--http-fuzz`** — server-side attack surface (Node-side, not the browser).
- **`--swarm` / `--workers <n>`** — parallel detection.

### Prove
- **`--repro`** — ddmin → spec compiler → flake-rate validator. Every crash/error finding gets an executable `.spec.ts` and a verdict (`[deterministic 3/3]`).

### Fix (LLM)
- **`--heal`** — generate a patch, gate it (redaction + AST safety + no new imports/eval/child_process), compile it, run your test suite, replay against the repro in an isolated git worktree. Verified *before* you see it.
- **`--fix`** — the one-command version: find → explain → heal → apply, with a `y/N` prompt. Never commits.
- **`--explain`** — a human-language summary (LLM when a key is set, deterministic offline fallback otherwise; `--lang ru` for Russian).
- **`modernize <file>`** — rewrite a legacy JS/TS file into modern syntax, applied only after you confirm (parse-gated).

### Auth
- **`--login`** — auto-detects the login form (`input[type=password]`), fills creds, saves the session, continues authenticated.
- **`--storage-state <path>`** — use a saved Playwright storage-state.

### Ship / CI
- **`--fail-on`** — exit 1 on any crash/error (for CI gates).
- **`--pr-comment`** — write a GitHub PR markdown comment with the repro.
- **`--badge`** — write a self-contained SVG status badge.
- **`--upload` / `--api-key` / `--cloud-url`** — stream findings to the cloud dashboard.
- **`--telemetry` / `--share-data`** — opt-in anonymized data (local, or uploaded).

### Tooling
- **`studio`** — a localhost dashboard (`:7331`) streaming findings live.
- **`init`** — scaffold `aztrx.config.ts` and gitignore `.aztrx/`.

### Multi-provider LLM (v0.3.0)
Any model via one OpenAI-compatible endpoint:
```bash
export AZTRX_API_BASE="https://openrouter.ai/api/v1"  # or api.x.ai/v1, api.openai.com/v1, ...
export AZTRX_API_KEY="your-key"
export AZTRX_MODEL="anthropic/claude-sonnet-5"
```
Covers Grok, DeepSeek, Gemini, GPT, Kimi, Mistral, OpenRouter, and local Ollama/vLLM.

---

## 6. Design philosophy (the ideas behind the decisions)

1. **Prove, not report.** The moat is the executable repro — a log line can be dismissed, a `[deterministic 3/3]` Playwright test can't.
2. **Black-box, not white-box.** CDP + console interception works on any framework; no React/Next hooks. (The original Fiber-introspection idea was dropped.)
3. **Safe by default.** Deny-by-default network, a destructive-action deny-list (never clicks delete/pay/logout), redaction before any LLM call, isolated git worktree, never commits, `.aztrx/` gitignored, pinned supply chain.
4. **"Report as teacher."** Instead of dumping every flag, the tool suggests the *next* flag after a run (`Tip: run with --fix …`) so users learn on demand, not by memorizing.
5. **Progressive disclosure.** The `--help` is grouped by intent (Detect / Prove / Fix / Report & ship / Auth), aliases and niche knobs are hidden (but still work), and `--fix` is the one memorable verb.
6. **No lock-in.** Any LLM provider via `AZTRX_API_BASE` — "works with the key you already have" is table stakes.
7. **Open-core.** The detect/prove/report core is free Apache-2.0; healing + cloud are the paid layer.

---

## 7. Monetization & business model

- **Open-core:** CLI is free (Apache-2.0). Paid Pro/Team = closed-loop healing (LLM) + cloud dashboard (api.aztrx.app). Target price point was **$29/mo**.
- **Donations:** a Polar.sh "name your price" link in the README.
- The old tracker's Polar.sh subscription ($8/mo, `upstreamai` org) is parked with the archived tracker.

---

## 8. Resources & accounts

| Resource | Where |
| --- | --- |
| Repo | `github.com/DanisChaparov/aztrx` (local `C:\Users\dchap\aztrx`) |
| npm | `aztrx-cli` (v0.3.0 = `latest`; account `karnezz`, headless publish via a granular token with **Bypass 2FA**) |
| Landing page | `https://aztrx.app` (Vercel project `aztrx`, Next.js) |
| Cloud API | `https://api.aztrx.app` (the `server/` dir) |
| Donations | Polar.sh link in the README |
| Benchmarks | `bench/` (13 seeded Next.js apps) + `fixtures/` (crash/kitchen/app/login/http500) |
| Parked | Supabase + old tracker git (tag `archive/focus-tracker-2026-08-22`) |

---

## 9. What shipped recently (v0.1.1 → v0.3.0)

- **CLI redesign** — grouped `--help`, the `--fix` verb (replacing `--magic-fix`), hidden aliases (`--swarm`, `--auth`, `--login-*`).
- **README restructure** — leads with the one-command, zero-setup story.
- **Version fix** — the banner reads from `package.json` (was hardcoded).
- **TUI fix** — worker `action`/`route` events now forwarded to the live panel (counters were stuck at 0).
- **Walker fix** — re-scan + recover from navigation (17 actions on a link page vs 1).
- **Noise fixes** — `net::ERR_ABORTED`/`ERR_BLOCKED_*` filtered; guard-blocked third-party requests now `blockedbyclient`.
- **Multi-provider LLM** — any OpenAI-compatible model.
- **`suggestNext`** — the "next flag" hint after a run.

---

## 10. What's left / open questions

- **Real-key heal test** — the full find→prove→heal→apply loop hasn't run against a real LLM key yet (only graceful no-key degradation).
- **Cloud dashboard** — `api.aztrx.app` (`server/`) exists but isn't fully wired/launched.
- **Domain flip** — `aztrx.app` currently serves the marketing page; the QA dashboard was meant to live there eventually.
- **Launch** — Show HN / public launch.
- **Flagship demo** — the 13-app `bench/` (100% recall claim in the README) needs `npm install` + a run to back the numbers.

---

*This doc is a snapshot to help you hold the whole thing in your head. If anything here
disagrees with what you remember, tell me and I'll correct it — I reconstructed the
history from my notes, which are point-in-time.*
