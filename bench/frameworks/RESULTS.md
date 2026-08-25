# Framework benchmark results — 13 real Next.js App Router targets

**13 / 13 seeded bugs detected · 100% recall**

**12 / 12 interaction bugs repro deterministically · 100% repro rate**

**1 / 1 hydration mismatch triaged as noise (0 leaks) · 1 / 1 Server Action failure escalated to `error`**

This corpus runs the real `run()` against thirteen self-contained **Next.js 16 App
Router** apps — not the vanilla fixtures of the earlier stage. Each target is a
`next dev` server (Turbopack, client components) with one seeded runtime bug and
a `manifest.json` declaring what the scorer expects to find — including, since
Stage 2 hardening, signals the scorer expects to be **triaged away**.

## Metrics

| metric | value |
| --- | --- |
| targets | 13 · Next.js App Router · `next@16.3.2` · Turbopack |
| seeded bugs | 13 |
| found | 13 |
| detection recall | **100%** |
| unseeded findings | 5 — two root causes (`/api/cart` → 500, Server Action → 500) |
| hydration triage | 1 suppressed signal · 0 leaks |
| Server Action severity | `error` (escalated from `warning`) ✓ |
| deterministic repro | **12 / 12 (100%)** |
| repro not attempted | 1 (mount-time bug, empty action history) |
| fuzz | seed 42 · maxActions 80 · `repro: true` |

## Per case

| # | target | archetype | found | repro |
| --- | --- | --- | --- | --- |
| 01 | Shop — null cart deref | null-deref | ✓ 1/1 | deterministic |
| 02 | Dashboard — hydration mismatch triaged, null deref found | hydration-triage | ✓ 1/1 | deterministic |
| 03 | Shop — unhandled cart fetch rejection | async-race | ✓ 1/1 | — (mount-time) |
| 04 | Pricing — toFixed on a string | type-coercion | ✓ 1/1 | deterministic |
| 05 | Feed — off-by-one pagination | array-bounds | ✓ 1/1 | deterministic |
| 06 | Account — null deref after navigation | route-transition | ✓ 1/1 | deterministic |
| 07 | Settings — unvalidated JSON.parse | json-parse | ✓ 1/1 | deterministic |
| 08 | Tabs — unbounded recursion | stack-overflow | ✓ 1/1 | deterministic |
| 09 | List — double-remove | detached-dom | ✓ 1/1 | deterministic |
| 10 | Form — select change deref | select-change | ✓ 1/1 | deterministic |
| 11 | Tooltip — hover deref | hover | ✓ 1/1 | deterministic |
| 12 | Search — keydown deref | keypress | ✓ 1/1 | deterministic |
| 13 | Checkout — Server Action failure | server-action | ✓ 1/1 | deterministic |

## Stage 2 hardening, now scored

The corpus grew two targets that pin down the Stage 2 hardening work:

1. **Hydration triage (02).** The page renders a `Math.random()` value — a
   guaranteed client/server divergence. Aztrx must *not* surface it as a finding:
   the manifest declares the message `suppressed`, and the scorer fails the
   target if it leaks through (`triage-leak`). A real null-deref in the same page
   is still found and repros deterministically, proving the boundary handling is
   resilient — hydration noise is filtered *without* masking real bugs.

2. **Server Action escalation (13).** A `"use server"` action throws on submit.
   The rejection surfaces through two capture paths — `pageerror`
   (`uncaught_exception`) and the console `unhandledrejection` hook
   (`unhandled_rejection`) — and is classified `error`, not `warning`. The scorer
   now asserts severity per seeded bug, so a regression back to `warning` fails
   the target.

## The "extras" are one bug per app, seen across capture paths

Two apps surface more findings than the single seeded bug, and in each case the
extras point at the **same root cause**:

- **03** — the app's `/api/cart` route returns HTTP 500:
  - `HTTP 500 …/api/cart` — the `response` capture path (`network_5xx`)
  - `Failed to load resource: … 500` — the browser's console error (`console_error`)
  - `Request failed: …/api/cart (net::ERR_ABORTED)` — the `requestfailed` path (`network_timeout`)
  - *plus* a `crash` (`uncaught_exception`) **and** an `error`
    (`unhandled_rejection`) for the same thrown `Cart fetch failed (500)` — the
    rejection reaches aztrx through both `pageerror` and the console hook.

- **13** — the Server Action throws, so Next responds 500:
  - `HTTP 500 …/` — the `response` capture path (`network_5xx`)
  - `Failed to load resource: … 500` — the browser's console error (`console_error`)
  - *plus* an `uncaught_exception` **and** an `unhandled_rejection` for the
    thrown `Order submit failed: quota exceeded`.

"False positive" in the scorer means "matched no seeded bug message", not
"wrong". These are correct findings of a real fault — just not collapsed across
signal paths. Deduplicating distinct capture paths that share a root cause into
a single finding is the next Stage-2 hardening item.

## What this corpus forced us to fix

The vanilla archetype corpus never exercised real framework timing, so it missed
four real detector defects that surfaced immediately once the target was a live
Next.js app:

1. **Hydration race in replay.** Replay clicked before React attached its
   handlers (`domcontentloaded` + no settle), producing false "unreliable"
   verdicts. Replay now waits for `load` plus a settle window, mirroring
   detection.
2. **Renderer-crash retry.** One crashed renderer took down the whole repro
   pipeline. `ReplayEngine` now relaunches the browser once and retries.
3. **`__name` serialization in selector capture.** Nested *named* functions
   inside a Playwright `evaluate` callback are serialized with a `__name` helper
   that is undefined in the page, silently collapsing selector cascades to `[]`
   — which is why `<select>`/`<input>` targets had empty selectors. Fixed by
   inlining the CSS-path builder.
4. **Next.js dev-overlay noise.** The overlay's `__nextjs_launch-editor` request
   was classified as a real `network_timeout` finding and dragged into the repro
   pipeline. Dev-tooling noise is now suppressed at the classifier.

Stage 2 hardening then added two more, each pinned by a benchmark target:

5. **React 19 hydration text.** The first hydration-triage pass matched only
   React 18's "initial UI does not match" phrasing; React 19.2 emits "the server
   rendered text didn't match the client". The classifier now keys on the
   `Hydration failed` prefix, which covers both. (02)
6. **Unhandled-rejection severity.** The console `unhandledrejection` hook is now
   typed `unhandled_rejection` → `error` rather than `console_error` → `warning`,
   so Server Action failures escalate correctly. The scorer asserts severity, so
   a regression fails the target. (13)

## Scope and caveats (read before citing)

1. **Real framework, synthetic bug.** The harness is real — Next.js 16 App
   Router, Turbopack, client components, actual `next dev` servers — but each bug
   is a deliberate one-line fault, not an organic defect in a production app. A
   step up from the vanilla archetype corpus, not yet a claim over a specific
   open-source project.
2. **Repro is scored via `--repro`** (F7 ddmin → F8 spec compile → F9 flake-rate).
   All 12 interaction findings replay deterministically at 3/3. The one
   mount-time bug (03, unhandled rejection) has no action history, so no repro is
   attempted for it.
3. **The destructive deny-list (F6) is a real coverage gap.** The fuzzer refuses
   `pay`/`checkout`/`delete`/`logout` controls by design, so bugs behind those
   flows are invisible to it.
4. **V8 error text is version-sensitive.** `JSON.parse("oops")` reads `"oops" is
   not valid JSON` in current Chromium. Manifests match the pinned Chromium; a
   browser bump can shift these strings.
5. **Own-code attribution for Server Actions.** The Server Action's throw site is
   served as `about://React/Server/…`, which the sourcemap resolver does not yet
   map to own code, so a Server Action failure is `error` rather than `crash`.
   Cross-signal dedup and Server-Action sourcemapping are the next hardening
   items.

## Reproduce

```bash
cd bench/frameworks
npm install            # once — installs next/react for the target apps
npm run bench          # detection only
npm run bench:repro    # detection + repro scoring
```

The number is deterministic for a given seed (mulberry32 PRNG).

> **Runner note.** `run.ts` boots each app's `next dev` server, drives the real
> `run()` against it, tears the server down, and scores findings against
> `manifest.json`. A manifest can declare `suppressed` signals that must be
> triaged away — a `triage-leak` or `severity-mismatch` fails the target. Pass
> `--only <id>` to run a single target, e.g.
> `npm run bench -- --only 13-server-action`.
