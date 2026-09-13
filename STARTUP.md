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
| late Aug | npm publish → `aztrx-cli`. |
| now | v0.5.2 in `package.json`; npm `latest` is 0.5.1 (0.5.2 is committed, not yet published). |

**Key early decisions:**
- **Codename lineage:** `stt/synapse` (stale "SynapseQA") → `seism` (a passing invention) → **`aztrx`** (your choice).
- **Dropped the white-box idea.** The original SynapseQA concept relied on "React Fiber introspection." You dropped it — Aztrx is now **fully black-box**: it drives the browser over CDP and reads errors from `console.error` / `pageerror` / network. That was the right call (it works on React, Next, Vue, Svelte, anything).
- **Free, bring your own key.** The whole CLI is free and Apache-2.0; healing runs on *your* model key (`ANTHROPIC_API_KEY`, or any OpenAI-compatible endpoint via `AZTRX_API_BASE`). There is no paid tier.

**Who it's for:** solo devs and 2–20 person React/Next.js teams who have no QA.

---

## 3. The stack

| Layer | Tech |
| --- | --- |
| Language | TypeScript (ESM, `"type": "module"`), Node ≥ 20 |
| CLI arg parsing | `commander@12` |
| Terminal UI | `ink@5` + `react@18` (a live React panel in the terminal) |
| Colors | `picocolors` |
| Browser automation | `playwright@1.62.1` (headless Chromium, drives via Chrome DevTools Protocol) |
| Source maps | `@jridgewell/trace-mapping` |
| Build / run | `tsc` (build), `tsx` (server + bench) |
| Package | `aztrx-cli` (bin `aztrx-cli`) on npm |
| Cloud server | `server/` — TypeScript HTTP ingest (api.aztrx.app) |
| Marketing site | `web/` — Next.js 16 + Tailwind v4, deployed on Vercel (`aztrx.app`) |
| CI | GitHub Actions — `action.yml` (composite) + `.github/workflows/aztrx-pr.yml` (reusable) |
| Payments | None — no billing, plan or pricing code in the repo. A Polar.sh donation link lives in the README |
| Old infra (parked) | Supabase (from the tracker), Vercel project `aztrx` |

The repo is `C:\Users\dchap\aztrx`, GitHub `github.com/Aztrx-AI/aztrx`, authored solely as **Danis Chaparov** (no co-author trailer — your explicit preference).

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

The stages (named F1–F14 in the code):

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
| F14 | `diagnose.ts` | The one-line "why + what to change" headline rendered inline with every crash/error — deterministic, keyed on the V8 message shape, no key needed. |

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

### Multi-provider LLM
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
7. **Free and open source.** Everything — detect, prove, heal, cloud — is Apache-2.0 and free. The only cost is your own model key.

---

## 7. Monetization & business model

- **No paid product.** Everything in the repo — the CLI (`src/`), the cloud ingest (`server/`) and the landing page (`web/`) — is free under Apache-2.0. There is no pricing, plan, subscription or billing code anywhere in `src/`, and the README sells nothing.
- **Bring your own key.** The one thing that can cost money is the LLM healing, and it runs on the user's own key: `ANTHROPIC_API_KEY`, or `AZTRX_API_BASE` + `AZTRX_API_KEY` + `AZTRX_MODEL` for any OpenAI-compatible provider. Scanning, proving and the null-deref `--fix` rule need no key at all.
- **Donations:** a Polar.sh "name your price" link in the README.

---

## 8. Resources & accounts

| Resource | Where |
| --- | --- |
| Repo | `github.com/Aztrx-AI/aztrx` (local `C:\Users\dchap\aztrx`) |
| npm | `aztrx-cli` (`latest` = 0.5.1; account `karnezz`) |
| Landing page | `https://aztrx.app` (Vercel project `aztrx`, Next.js) |
| Cloud API | `https://api.aztrx.app` (the `server/` dir) |
| Donations | Polar.sh link in the README |
| Benchmarks | `bench/frameworks/` (13 Next.js 16 apps) + `bench/cases/` (13 vanilla archetypes) + `fixtures/` (crash/kitchen/app/login/http500) |
| Parked | Supabase + old tracker git (tag `archive/focus-tracker-2026-08-22`) |

---

## 9. What shipped recently (v0.1.1 → v0.5.2)

**0.5.2 — the sandbox stopped deleting your `node_modules`.** The heal sandbox
links the repo's `node_modules` into its throwaway worktree, and on Windows that
link is a junction. `git worktree remove --force` recurses *through* a junction,
so the routine cleanup was recursively deleting the real `node_modules` — on
every `--fix` run, on Windows. It was found by running the loop for real rather
than by reading the code: this repo's own `node_modules` came back empty. The
cleanup now unlinks directory links before git is handed the worktree. The fix is
verified twice over — a regression test that fails without it, and an A/B on a
live target where a real heal run empties the target's `node_modules` with the
fix removed and leaves a sentinel file untouched with it in place.

**0.5.2 also made the repro actually reproduce.** Running the loop against a real
Next.js app — and looking at *why* only one of its three crashes was being
healed — turned up four defects in the middle of the pipeline. The headline is
that a recorded trace never said which page it was on: the walker reaches each
crawled route with `page.goto`, which emitted no action at all, so a finding on
`/agents` produced a trace of clicks that only mean anything there. Replayed
from the start URL every one of them resolved to nothing, the crash was never
reached, and a bug that fires on every single click was reported
`unreliable 0/3` — which reads as "your bug is flaky" and is in fact "we did not
replay your bug". `navigate` was already understood by every consumer of a
trace; only the producer was missing. With it, plus the three timing and patch
defects listed below, **3 of 3 findings on that app are now proven
`[deterministic 3/3]` and healed with no API key at all** — the app where 1 of 3
was healed before.

**0.5.2 also closed the gap between what the repo says and what it does.** Every
CI snippet in the README pinned `@v0.5.2` — a tag that is not on origin, for a
version that is not on npm. Anyone who copied the snippet got a failing job that
reported `aztrx did not run (exit code: N)`, wording chosen so it cannot be
mistaken for a verdict about the app, which means it read as infrastructure
rather than as a wrong README. The pins were bumped in a commit titled "Release
0.5.2 … on npm" four commits before that publish existed. The bump was never the
mistake — doing it early was. So the pins now name 0.5.1, the last version a
stranger can actually install, and three checks keep it that way.

**0.5.1 — a fix is now proven, not assumed.** A healed patch could previously be
reported as fixed *without the patched code ever running*: client findings were
static-served, so a `.tsx` reached the browser as text it never executes; replays
kept their original absolute URLs and walked back into the unpatched code; and an
unreachable page emitted no telemetry, which read identically to a fixed bug. Each
is closed — the app is booted when a start command exists, every recorded URL is
rewritten to the served origin, and `ReplayResult.loaded` now gates `fixed`. Both
PR openers stage only the files they healed instead of `git add -A`, so an
automatic fix can no longer commit your unrelated working tree.

- **Wrong line on Next.js, and what it cost** — a `webpack-internal://` frame carries a position in the module webpack *generated*, not in the `.tsx` on disk: Next dev reported `app/page.tsx:29:21` for a crash on line 15. The path is the real source path, so the file was found and a confidently wrong line was shown — a snippet that did not contain the bug. It also silently killed the free fix: `generateRulePatch` reads the property on the mapped line, found a `</div>`, and declined, so every finding fell through to a paid model. The message is the signal — `(reading 'agents')` can only be thrown by a line that reads `.agents` — so a mapped line that does not is provably wrong, and the real one is findable. Ambiguity (several unguarded reads, none distinguishable) is left alone rather than guessed at. Verified on the real project: lines now land on 15/13/12, and `--heal` produces a fix with **no API key at all**.
- **A trace now carries its navigations** — see above. The producer is `framenavigated`, and it records a URL once: Playwright fires that event *twice* for a single `goto` (measured against Chromium rather than assumed), and the action buffer is only 25 deep. The walker also stopped re-loading the start page it is already on — the browser normalises `http://host` to `http://host/`, so a raw string compare said "different page" and every run paid for a full extra load that re-fired every mount effect.
- **A replayed navigation now waits before acting** — the walker waits 300ms after its own `goto` before it touches anything, so every recorded selector was resolved against a page given 300ms to render; a replay that clicks the instant the navigation commits is asking for something the recording never was. Measured: 0ms reproduced **0/3**, 300ms reproduced **3/3**. Same trace, same app.
- **A replay no longer stops watching too early** — it waited a fixed 300ms after the last action, which turned out to be *exactly* a real app's own async delay, so the same trace flipped between reproducing and not from one run to the next. It now polls, and returns the moment the fingerprint appears: the window is a ceiling, not a delay, and only a trace headed for an `unreliable` verdict pays for it — which is the case that must not be wrong.
- **The free rule fixer no longer mangles spread syntax** — `/\.(?=[a-zA-Z_$])/` matches the third dot of `...s`, so `{ ...s, [id]: result.ok }` came out as `{ ..?.s, [id]: result?.ok }` and an already-guarded `d?.agents` became `d??.agents`. Both are syntax errors, which the AST gate refused — correctly, but the user saw `rejected` with nothing to say the *rule engine* had emitted garbage, and the free fixer silently declined every line containing a spread or an existing `?.`, which is most React code. A lookbehind fixes it. Its limit is documented: it is a regex on a line, not a lexer, so a `.name` inside a string literal on the failing line is rewritten too.
- **The advertised version is checked, not remembered** — a `uses: owner/repo@vX` whose tag does not exist does not report a bad pin; it reports `aztrx did not run`, which is worded to look like infrastructure. The five places that name an installable version (two in `README.md`, two in `action.yml`, one in the reusable workflow's own `uses:`) must agree, and none may *lead* `package.json` — lagging is the normal state between releases, leading names a version that exists nowhere. Equality is reached only by bumping the pins, committing, and pushing the tag in the same push. `tests/action.test.ts` used to assert the opposite — pin *equals* `package.json`'s version — which is the rule that forced the premature bump; its intent was right, but it equated "this release" with "this tree", and those differ until the tag is pushed.
- **The README is checked against the code** — its reference tables promise 52 flags and 10 environment variables, and nothing connected either list to the parser or to `process.env`. A deleted flag at least answers `error: unknown option`; a renamed environment variable answers nothing at all — it reads as undefined, the feature falls back to its default in silence, and there is no error to search for. Both are now asserted a subset of the code, with a guard that fails loudly if the patterns stop matching rather than passing vacuously. Both sets were clean when this was added; the value is that they have to stay clean.
- **The tarball a user installs was verified, not assumed** — `npm pack` into a clean project, `npm i` the tarball, and then: `--version` reports 0.5.2, the grouped `run --help` renders, all five `exports` entries resolve (`aztrx-cli`, `/vite`, `/next`, `/mcp`, `/package.json`), and the `--repo` guard from below is present in the shipped artifact — it exits 1 and creates nothing. Then the real thing: a page with a seeded null-deref, served on 127.0.0.1, scanned by the *packaged* build — found, mapped to `index.html:9:32`, diagnosed, minimized to 1 step, compiled to a standalone spec, and validated **`✓ deterministic 3/3`**. The emitted spec is a clean seven-line Playwright test. 479 kB, 142 files.
- **`--repo` is checked, not trusted** — commander consumes a `<required>` option's value even when it looks like a flag, so `aztrx run <url> --repo --fix` set the project root to the literal string `--fix`. `path.resolve` turned that into `<cwd>/--fix`, and the run then *succeeded* against a directory it had invented, leaving `.aztrx/events.jsonl` and `report.html` inside — exit code 0, no warning. Found as a stray `C:\Users\dchap\--fix\` holding nothing but `.aztrx/`; reproduced against the published 0.5.1 to confirm that exact shape. The root must now exist and be a directory, and a refused path whose last segment is a flag says so. An empty directory nobody can explain is a worse failure than an error message, because nothing reports it.
- **A provider failure now says what it was** — an empty completion used to reach the user as `Unexpected end of JSON input`, which blames our parser rather than the model. Both transports now throw with the stop reason ("the token limit was reached before any text was emitted…", "the provider failed mid-response"), and `data.error` is checked because OpenRouter reports upstream failures in the body under HTTP 200.
- **Heal's token ceiling is 8192** — a patch is a few hundred tokens, but a reasoning model spends the budget on its thinking first and at 2048 hit the cap before emitting a single character. It is a ceiling, not a charge, so the headroom is free for models that do not reason.
- **The loop is proven, not just wired** — find → prove → heal → apply now has a real run behind it: a live OpenRouter key, a real crash, `✓ deterministic (3/3 runs)`, `✓ healed`, `✓ applied heal-llm.html (1 edit)`. It needed a new fixture to get there — every other fixture in the repo is a null-deref, so the free rule engine answered them all and the LLM path was never reached.
- **CLI redesign** — grouped `--help`, the `--fix` verb (replacing `--magic-fix`), hidden aliases (`--swarm`, `--auth`, `--login-*`).
- **README restructure** — leads with the one-command, zero-setup story.
- **Version fix** — the banner reads from `package.json` (was hardcoded).
- **TUI fix** — worker `action`/`route` events now forwarded to the live panel (counters were stuck at 0).
- **Walker fix** — re-scan + recover from navigation (17 actions on a link page vs 1).
- **Noise fixes** — `net::ERR_ABORTED`/`ERR_BLOCKED_*` filtered; guard-blocked third-party requests now `blockedbyclient`.
- **Multi-provider LLM** — any OpenAI-compatible model.
- **`suggestNext`** — the "next flag" hint after a run.
- **`--version` / `-V`** — reads `VERSION` from the installed `package.json`, so it cannot drift from what npm shipped. It did not exist before 0.5.1.
- **Published `.d.ts`** — every `exports` subpath carries a `types` condition, so consumers stop getting implicit-any modules. `declarationMap` is deliberately off: its maps would point into `src/`, which `files` does not ship.
- **Node floor is 20, and honest** — Playwright declares `>=20`, so the previously advertised 18 could never have worked. CI runs 20/22/24 to check the claim rather than assert it.

---

## 10. What's left / open questions

- **Cloud dashboard** — `api.aztrx.app` (`server/`) exists but isn't fully wired/launched.
- **Domain flip** — `aztrx.app` currently serves the marketing page; the QA dashboard was meant to live there eventually.
- **Launch** — Show HN / public launch.
- **Flagship demo** — the numbers behind the README's recall claim are recorded: `bench/frameworks/RESULTS.md` (13/13 found, 12/12 deterministic repros) and `bench/RESULTS.md` (13/13, 11/12).
- **Orphan `v0.5.0` tag** — the tag is on origin but 0.5.0 was never published to npm, so `uses: Aztrx-AI/aztrx@v0.5.0` fails with ETARGET. Nothing tells users to pin it (the documented pin is `v0.5.1`), and the failure is safe — the check reports "aztrx did not run", not a verdict about the app — but the tag is dead weight. Deleting it or publishing 0.5.0 are both deliberate calls, so it is left standing.
- **Release sequence, and why 0.5.2 is deliberately not in the README yet** — `package.json` says 0.5.2 and the code is on `main`, but npm `latest` is still 0.5.1. That gap is intentional: the README's CI examples pin `@v0.5.1`, *the last version a stranger can actually install*, because a pin only means something once the tag and the tarball both exist. The order is not interchangeable:
  1. `npm publish` — never with `--ignore-scripts`; `prepublishOnly` is what rebuilds `dist/`, and the committed `dist/` is stale.
  2. `git push && git tag v0.5.2 && git push origin v0.5.2` — the tag comes **after** the publish. Tagging first is exactly how `v0.5.0` became an orphan above.
  3. Bump the advertised version — `README.md` (three refs), `action.yml`, and `.github/workflows/aztrx-pr.yml` (two refs) — commit, and push that commit **in the same push as the tag**. `tests/version-pins.test.ts` and `tests/action.test.ts` enforce that the five agree and that none leads `package.json`; they are what makes step 3 mechanical rather than remembered.

  A tag pushed before its publish is a broken pin for everyone who copies the README out of the repo; a README bump before its publish is the same breakage one step earlier. Both are why `main` advertises 0.5.1 today.

---

*This doc is a snapshot to help you hold the whole thing in your head. If anything here
disagrees with what you remember, tell me and I'll correct it — I reconstructed the
history from my notes, which are point-in-time.*
