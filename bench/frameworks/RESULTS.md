# Framework benchmark results — 12 real Next.js App Router targets

**12 / 12 seeded bugs detected · 100% recall**

**10 / 10 interaction bugs repro deterministically · 100% repro rate**

This corpus runs the real `run()` against twelve self-contained **Next.js 16 App
Router** apps — not the vanilla fixtures of the earlier stage. Each target is a
`next dev` server (Turbopack, client components) with one seeded runtime bug and
a `manifest.json` declaring what the scorer expects to find.

## Metrics

| metric | value |
| --- | --- |
| targets | 12 · Next.js App Router · `next@16.3.2` · Turbopack |
| seeded bugs | 12 |
| found | 12 |
| detection recall | **100%** |
| unseeded findings | 3 — one root cause (`/api/cart` → 500) seen through 3 signal paths |
| deterministic repro | **10 / 10 (100%)** |
| repro not attempted | 2 (mount-time bugs, empty action history) |
| fuzz | seed 42 · maxActions 80 · `repro: true` |

## Per case

| # | target | archetype | found | repro |
| --- | --- | --- | --- | --- |
| 01 | Shop — null cart deref | null-deref | ✓ 1/1 | deterministic |
| 02 | Dashboard — hydration text mismatch | hydration-mismatch | ✓ 1/1 | — (mount-time) |
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

## The three "extras" are one bug, seen three ways

`03-unhandled-rejection` surfaces three findings beyond the seeded unhandled
rejection, and all three point at the **same root cause** — the app's
`/api/cart` route returns HTTP 500:

- `HTTP 500 …/api/cart` — the `response` capture path (`network_5xx`)
- `Failed to load resource: … 500` — the browser's console error (`console_error`)
- `Request failed: …/api/cart (net::ERR_ABORTED)` — the `requestfailed` path (`network_timeout`)

"False positive" in the scorer means "matched no seeded bug message", not
"wrong". These three are correct findings of a real fault — just not collapsed
across signal paths. Deduplicating distinct capture paths that share a root
cause into a single finding is a Stage-2 hardening item.

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

## Scope and caveats (read before citing)

1. **Real framework, synthetic bug.** The harness is real — Next.js 16 App
   Router, Turbopack, client components, actual `next dev` servers — but each bug
   is a deliberate one-line fault, not an organic defect in a production app. A
   step up from the vanilla archetype corpus, not yet a claim over a specific
   open-source project.
2. **Repro is scored via `--repro`** (F7 ddmin → F8 spec compile → F9 flake-rate).
   All 10 interaction findings replay deterministically at 3/3. The two
   mount-time bugs (hydration mismatch, unhandled rejection) have no action
   history, so no repro is attempted for them.
3. **The destructive deny-list (F6) is a real coverage gap.** The fuzzer refuses
   `pay`/`checkout`/`delete`/`logout` controls by design, so bugs behind those
   flows are invisible to it.
4. **V8 error text is version-sensitive.** `JSON.parse("oops")` reads `"oops" is
   not valid JSON` in current Chromium. Manifests match the pinned Chromium; a
   browser bump can shift these strings.

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
> `manifest.json`. Pass `--only <id>` to run a single target, e.g.
> `npm run bench -- --only 07-json-parse`.
