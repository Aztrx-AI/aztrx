# <img src="media/logo.svg" width="28" height="32" alt="Aztrx logo" align="absmiddle" /> Aztrx AI

> **Catch the runtime crash your Error Boundary hid — and prove it with a test, not a log line.**

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg?style=flat-square)](https://nodejs.org)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg?style=flat-square)](LICENSE)

Aztrx AI finds **runtime** bugs, not security holes. It drives your web app like a hostile
user and catches the crashes that ship to real users — *including ones a React Error Boundary
swallows* (the errors `window.onerror` never sees). Each crash comes back as an exact source
line plus an executable **Playwright repro** that fails `3/3` times. Then it fixes it.

```bash
npx aztrx-cli                    # find crashes — no key, no config, no URL to look up
npx aztrx-cli --fix              # fix them — free for common bugs
```

Run it in your project and it works out what your app is, starts your dev server if
nothing is listening, scans, and stops the server again on the way out. Already have
one running? It attaches and leaves it alone. Pass a URL (`aztrx-cli run http://…`)
and it goes exactly there instead.

![aztrx demo](media/demo.gif)

---

## Why Aztrx AI

- **Sees swallowed errors.** Error Boundaries and `window.onerror` miss the errors your app *catches*. Aztrx reads the real throw-site stack off the `Error` object — a crash you've never seen in your logs becomes a finding you can't ignore.
- **Explains the crash in one line.** Every crash/error ships with a one-sentence diagnosis — why it happened and what to change (e.g. `the value before `.cart` is undefined — guard with `?.`). Free, no key, right in the terminal and `report.html`.
- **Proves, not reports.** Every crash ships with an executable `.spec.ts` repro and a flake-rate verdict — `[deterministic 3/3]`, `[flaky 3/5]`, or `[unreliable]`.
- **Safe by default.** A deny-by-default network guard blocks off-origin calls, a destructive-action deny-list refuses to click "delete", "pay", or "logout", and nothing leaves your machine unless you opt in.

---

## Quickstart

```bash
npm i -g aztrx-cli            # or use npx — no install needed

aztrx-cli                     # 1. find the crashes (no key, no account)
aztrx-cli --repro             # 2. prove them with an executable test
aztrx-cli --fix               # 3. fix them
```

Run it from your project root — it detects the framework, finds your dev server or
boots it (`npm run dev`), and tears the server down when it exits. To point it at a
server somewhere else, pass the URL: `aztrx-cli run http://localhost:3000`. It drives
Chromium through Playwright (the first run downloads the browser automatically).

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
| `patrol <url>` | autonomous loop — re-scan, fix, open a PR per bug |
| `modernize <file>` | rewrite legacy JS/TS into modern idiomatic syntax |
| `studio` | live dashboard on `localhost:7331` |
| `hook install` | scan every `git push` — block the ones that crash |
| `mcp install` | put aztrx inside your editor's agent (Claude Code, Cursor, VS Code) |

Full list: `aztrx-cli run --help`, or the [CLI reference](#cli-reference).

---

## Scan while you develop

Add a few lines and your dev server reports its own runtime crashes as you work —
no second terminal, no separate command to remember. Same plugin either way; only
the hook differs.

### Vite

```ts
// vite.config.ts
import { aztrx } from "aztrx-cli/vite";

export default defineConfig({
  plugins: [aztrx()],
});
```

```bash
npm run dev
#   VITE v8.3.0  ready in 312 ms
#   ➜  Local:   http://localhost:5173/
#   [aztrx] 1 crash — first: src/Report.tsx:42
#   [aztrx] run `npx aztrx-cli` for the repro and the fix.
```

### Next.js

Next has no config object to hang a plugin off, so it uses `instrumentation.ts` —
the hook Next added for exactly this (Sentry and OpenTelemetry use it too):

```ts
// instrumentation.ts, next to app/ or src/
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerAztrx } = await import("aztrx-cli/next");
    registerAztrx();
  }
}
```

```bash
npm run dev
#   ▲ Next.js 16.3.2 (Turbopack)
#   - Local:        http://localhost:3001
#   [aztrx] 1 crash — first: app/page.tsx:18
#   [aztrx] run `npx aztrx-cli` for the repro and the fix.
```

The `NEXT_RUNTIME` guard is required, not decoration: Next compiles
`instrumentation.ts` for the edge runtime as well, which has no child processes.
The plugin itself does nothing outside `next dev` — a scan during `next build` or
`next start` would point a browser at a real deployment. It finds the port Next
actually bound, so it still works when 3000 was taken and Next moved to 3001.

### Options and behaviour

```ts
// Vite: plugins: [aztrx({ … })]   Next.js: registerAztrx({ … }) — same options.
{
  maxActions: 50,      // shallower, faster walk
  fuzz: true,          // seeded chaos instead of the deterministic walk
  onResult: (r) => {}, // wire findings into your own tooling
}
```

Both plugins are a **sentinel, not a reporter**: silent until the scan finishes,
then one line. Run `aztrx-cli` for the full report, the executable repro, and the
fix. Findings also land in `.aztrx/` as usual.

The scan runs as a **separate process**, killed when the dev server stops. That is
deliberate: a scanner that crashes, hangs, or leaves a browser behind must never be
able to take your dev server down with it — and it dies with the parent even if the
parent is hard-killed. Set `AZTRX_DEV_SCAN=0` to skip a scan without editing the
config.

---

## Scan before you push (git hook)

One command and every `git push` scans your app first:

```bash
aztrx-cli hook install
#   ✓ pre-push hook installed.
#     .git/hooks/pre-push
#     Every `git push` now scans the app and blocks on a crash.
#     Skip one push with `git push --no-verify`, or a run with AZTRX_HOOK_SKIP=1.
```

A push that found something:

```
[aztrx] 1 changed file: src/Cart.tsx. Scanning the app…
[aztrx] 1 crash · 1 warning — first: src/Cart.tsx:42
[aztrx] run `npx aztrx-cli` for the repro and the fix.
[aztrx] push blocked — 1 crash/error finding in your app.
[aztrx] fix them and push again; to push anyway, `git push --no-verify`.
```

It scans **your app, not your diff** — a changed file is the *trigger*, not the scope. A crash
at `Cart.tsx:42` usually comes through a `useCart()` that changed three files away, and a
diff-shaped scan would look straight past it.

### It stays out of the way

Push a README and it says so and gets out of the way in about a second:

```
[aztrx] skipped — only docs, metadata or assets changed (1 file).
```

The skip list is deliberately short and boring: `.github/`, `.vscode/`, `.aztrx/`, `LICENSE`,
`.gitignore`, `.md`, images. Anything arguable — lockfiles, config, `.mdx` — is **not** on it,
because a wrong skip is a missed crash, which is the one thing this hook exists to prevent.
When it cannot tell what changed (a branch the remote has never seen, a shallow clone) it
scans the whole app and says why.

| | |
| --- | --- |
| `git push --no-verify` | skip this push |
| `AZTRX_HOOK_SKIP=1 git push` | same, for scripts |
| `aztrx-cli hook uninstall` | remove it |

### It cannot block you by accident

Aztrx blocks a push because it found a crash — never because it is broken:

- **Not installed, not on PATH** → the push proceeds.
- **The scan fails, or never finishes** → the push proceeds, with the reason printed.
  `AZTRX_HOOK_TIMEOUT` (ms, default `300000`) caps a single scan.
- **A failed scan is never reported as clean.** "I could not look" is a different sentence
  from "nothing there", and it stays that way.

A hook that blocks pushes when it is merely broken gets turned off, and then it catches
nothing.

The installed file is a 15-line shim that calls back into the CLI, so `npm i -g
aztrx-cli@latest` upgrades the hook as well — nothing to reinstall. `hook install` is
idempotent, installs where git actually looks (so `core.hooksPath` — husky, Lefthook — is
respected), and refuses to overwrite a `pre-push` hook it did not write unless you pass
`--force`.

**Not handled:** under Yarn PnP there is no `node_modules/aztrx-cli` to find, so the hook
skips silently. Safe, but useless — use npm, pnpm, or Yarn with `nodeLinker: node-modules`.

---

## Use aztrx from your editor (MCP)

Your editor's agent can write code but cannot run it. It can compile, lint, and typecheck —
none of which open a page and click the button. So it will tell you a change works when all
it knows is that the change *parsed*.

`aztrx mcp` gives the agent the missing step: it drives the app in a real browser and hands
back the runtime crashes it produced, with an executable repro attached.

```bash
npx aztrx-cli mcp install
#   ✓ Claude Code — .mcp.json — added.
#   ✓ Cursor — .cursor/mcp.json — added.
#   • VS Code — no .vscode/ in this project
#
#   Restart your editor — or reload its window — to pick the server up.
```

It writes the config for the editors your project actually uses, and only ever adds one key
to a file it reads first. Your other MCP servers are left alone. If a config will not parse
it **refuses** rather than overwriting — a missing comma should never cost you your setup —
and `--force` is the escape hatch, which saves a `.bak` first. `mcp uninstall` removes only
our entry and keeps the file.

### The three tools

| Tool | What it does | Costs |
| --- | --- | --- |
| `aztrx_scan` | Drives the app, reports crashes/errors with source locations. Boots the dev server itself if none is running. | tens of seconds |
| `aztrx_repro` | The minimized steps and the compiled Playwright spec for one finding. Reads the scan that already ran. | free |
| `aztrx_fix` | Patch → verify in a git worktree by replaying the repro → optionally write it into your tree. | one model call |

The scan returns a compact projection with a `scanId`; the detail — the action sequence, the
spec, the diff — is fetched by handle. A stack trace in the agent's context on every scan is
how a useful tool becomes an expensive one.

`aztrx_fix` needs a key (`ANTHROPIC_API_KEY`, or `AZTRX_API_BASE` + `AZTRX_API_KEY` +
`AZTRX_MODEL` for any other provider). Without one it returns `no-llm` and attempts nothing.
Scanning and proving never need a key. Aztrx never commits: `apply: true` writes working-tree
files, and `git diff` is the review.

### What it will not do

- **No `--allow-destructive`, `--fuzz`, or `--http-fuzz` over MCP.** The tool drives a real
  browser against an app you are working in. An agent should not be able to reach for
  data-mutating controls because a prompt suggested it. If you want the fuzzer, that is a
  deliberate `aztrx-cli run` in a terminal.
- **A scan that could not run is an error, never "no findings."** If the app would not boot
  or the browser could not reach it, the tool returns `isError` with the reason — it does not
  return an empty list. An agent that reads `0 crashes` from a scan that never happened will
  tell you the code is fine.

### Protocol support

MCP changed shape in its `2026-07-28` revision: the `initialize` handshake is gone, replaced
by per-request metadata. Editors are split across that line — Claude Code speaks the new
revision, and Cursor still speaks `2025-11-25`.

`aztrx mcp` speaks **both** and picks per request, which is why it works in both editors
today and will keep working as the others move. It is ~300 lines with zero new dependencies;
neither official SDK covers both revisions, and the legacy one pulls seventeen runtime
dependencies (express, cors, jose, ajv…) for a stdio server that needs none of them.

---

## Autonomous patrol

`aztrx patrol` is the looped version of `run --fix`: point it at a running app and it
re-scans on an interval, fixes anything new, and opens a **PR per bug** — no human in
the middle. Each PR body carries a **recorded repro**: a short animated GIF that replays
the crash step-by-step, so a reviewer sees the bug happen before the fix.

```bash
aztrx-cli patrol http://localhost:3000        # re-scan every 10 min, open a PR per new bug
aztrx-cli patrol http://localhost:3000 --once # one scan, then exit (great for CI/cron)
aztrx-cli patrol http://localhost:3000 --batch # group a cycle's fixes into one PR
```

| Flag | What it does | Default |
| --- | --- | --- |
| `--interval <s>` | Seconds between scans | `600` |
| `--max-fixes <n>` | Max PRs to open per session | `5` |
| `--max-spend <n>` | Hard cap on paid LLM generations per session | unlimited |
| `--retry-after <s>` | Cooldown before an unfixable bug is retried | `1800` |
| `--batch` | Group all of a cycle's fixes into one PR | one PR per bug |
| `--once` | Run a single scan then exit | loop forever |
| `--fuzz` / `--workers <n>` | Detection mode / parallelism (pass-through to `run`) | — |

Guardrails keep the loop from running away: it only stages the files a patch touched
(never `git add -A`), dedups by crash fingerprint (a re-scan won't re-open the same PR),
backs off from unfixable bugs, and respects a session-wide LLM spend cap.

---

## Security

- **Local-first.** Nothing leaves your machine unless you opt in.
- **Never commits.** Fixes land in a detached worktree for your review.
- **Redacted.** Secrets are stripped from the file, error, and stack before any LLM call.
- **Deny-by-default network.** Off-origin calls are blocked; destructive clicks (delete/pay/logout) are refused.
- **`.aztrx/` is gitignored** — repros, reports, and patches stay out of history.

---

## Continuous Integration (GitHub Action)

Runtime gate on every PR — runs `aztrx-cli run --fail-on --repro --heal`, posts a comment with
the repro + patch, and fails on a crash/error.

```yaml
# .github/workflows/ci.yml — composite action, inline
on: pull_request
jobs:
  aztrx:
    runs-on: ubuntu-latest
    timeout-minutes: 30                        # recommended — see below
    permissions: { contents: read, pull-requests: write }
    steps:
      - uses: actions/checkout@v4
      - uses: Aztrx-AI/aztrx@v0.5.0
        with:
          token: ${{ github.token }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}   # optional — enables --heal
```

That is the whole setup: aztrx detects the framework, boots your dev server, scans, and shuts
it down again. Already have a server running, or want to control how it starts? Pass a URL and
the action stays out of the way:

```yaml
        with:
          url: http://localhost:3000
          start-command: npm run dev           # boot the app in the background first
          wait-for: http://localhost:3000      # defaults to `url`
          token: ${{ github.token }}
```

A status badge (`--badge`) and PR comment (`--pr-comment`) work the same way — regenerate in
CI on every push.

### What the check tells you

`uses: Aztrx-AI/aztrx@v0.5.0` runs **aztrx-cli 0.5.0** — the action reads its own version, so
the tag selects the engine, not just the wrapper.

A red check has two different meanings, and the message says which:

| | |
| --- | --- |
| `aztrx detected crash/error findings` | it scanned, and found something. Fix it, or run `npx aztrx-cli` locally for the repro. |
| `aztrx did not run (exit code: N)` | the scan never produced a result — a bad version pin, a registry failure, a broken config. **Not** a verdict about your app. The last lines of the run are printed to explain it. |

Set `timeout-minutes` on the job. The default `args` include `--repro` and `--heal`, which
drive your app repeatedly and can call a model — without a ceiling, one hung browser spends
GitHub's 6-hour job default finding nothing.

On a **fork pull request** the token is read-only, so the comment is skipped with a warning and
the check still reports the scan result. `--heal` needs `ANTHROPIC_API_KEY`, which forks do not
receive; it skips cleanly rather than failing.

Prefer not to wire it inline? The same thing is packaged as a reusable workflow:

```yaml
jobs:
  aztrx:
    uses: Aztrx-AI/aztrx/.github/workflows/aztrx-pr.yml@v0.5.0
    secrets:
      anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

---

## CLI reference

`aztrx-cli run --help` is grouped by intent (Detect / Prove / Fix / Report & ship / Auth);
the table below is the complete reference — including flags hidden from `--help` (aliases and
niche tuning knobs).

The commands that are not `run`:

| Command | What it does |
| --- | --- |
| `mcp` | Serve the [MCP server](#use-aztrx-from-your-editor-mcp) on stdio (this is what an editor's config runs) |
| `mcp install [--force]` | Add aztrx to `.mcp.json` / `.cursor/mcp.json` / `.vscode/mcp.json`, merging one key |
| `mcp uninstall` | Remove only that key |
| `init` | Scaffold `aztrx.config.ts` |
| `hook install \| uninstall \| run` | The [pre-push hook](#scan-before-you-push-git-hook) |
| `patrol [url]` | Autonomous scan → fix → PR loop |
| `modernize <file>` | Rewrite a legacy file with an LLM |
| `studio [--port n]` | Live dashboard (`7331`) |

| Flag | Description | Default |
| --- | --- | --- |
| `--no-boot` | Attach to a running dev server only — never start one yourself | boots when needed |
| `--fuzz` | Seeded chaos fuzzing instead of the deterministic walk | — |
| `--http-fuzz` | Server-side mutation fuzzing — hostile requests against the target origin | — |
| `--http-fuzz-mutations` | With `--http-fuzz`: also send POST/PUT body mutations (default: GET-only) | — |
| `--allow-destructive` | Opt-in: test destructive controls/endpoints (delete/pay/logout/checkout) — can mutate real data | — |
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
| `--json` | One JSON document on stdout, nothing else — for editors, plugins, and CI | — |

---

## Output artifacts

Every run writes self-contained artifacts inside `.aztrx/` (gitignored):

```
.aztrx/
├── report.html                  # interactive triage report
├── repro/<id>.spec.ts           # minimal, executable Playwright repro
├── heal/<id>.patch              # gated, compiler-checked fix (one per finding)
├── events.jsonl                 # run log (streamed by `aztrx-cli studio`)
├── patrol.json                  # patrol cross-run memory (handled fingerprints)
├── pr-comment.md                # GitHub PR markdown (with --pr-comment)
└── badge.svg                    # status badge (with --badge)
```

`aztrx patrol` also writes a `aztrx-media/<fingerprint>.gif` recorded repro next to the
project root — the animated proof inlined in each patrol PR body.

---

## Benchmarks

Aztrx is scored against two corpora — a framework-agnostic archetype baseline and a
corpus of real **Next.js 16 App Router** apps (Turbopack, client components), each with
one seeded runtime bug:

| corpus | detection | deterministic repro |
| --- | --- | --- |
| 13 Next.js 16 apps | **13/13 · 100% recall** | **12/12 · 100%** |
| 13 vanilla archetypes | **13/13 · 100% recall** | **11/12 · 92%** |

One archetype is `13-swallowed-boundary` — a crash caught by an Error Boundary and
logged via `console.error`, never rethrown. A `pageerror`-only detector scores
**0/1** on it. It is the README's headline claim, so it lives in the corpus where a
regression would fail the benchmark.

Reproduce it yourself: `npm run bench` (archetypes) and `cd bench/frameworks && npm run bench`
(Next.js corpus). Per-case results and scope notes live in
[`bench/frameworks/RESULTS.md`](bench/frameworks/RESULTS.md) and
[`bench/RESULTS.md`](bench/RESULTS.md).

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
