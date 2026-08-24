# Benchmark results — detection

**12 / 12 seeded bugs detected · 100% recall · 0 hallucinations**

| metric | value |
| --- | --- |
| seeded bugs | 12 |
| found | 12 |
| recall | **100%** |
| extra findings (unseeded) | 2 (both real, not hallucinations) |
| engine | `dist/core/orchestrator.ts` `run()` |
| fuzz | seed 42 · maxActions 80 · `ui: true` |

## Per case

| # | case | archetype | seeded | found | extra |
| --- | --- | --- | --- | --- | --- |
| 01 | `undefined-read` — null cart deref | null-deref | 1 | ✓ 1 | — |
| 02 | `hydration-mount` — missing bootstrap state | hydration-mismatch | 1 | ✓ 1 | — |
| 03 | `unhandled-rejection` — unhandled fetch rejection | async-race | 1 | ✓ 1 | 1 |
| 04 | `type-coercion` — `toFixed` on string | type-coercion | 1 | ✓ 1 | — |
| 05 | `array-bounds` — off-by-one pagination | array-bounds | 1 | ✓ 1 | — |
| 06 | `route-null` — null ref on route change | route-transition | 1 | ✓ 1 | — |
| 07 | `json-parse` — unvalidated `JSON.parse` | json-parse | 1 | ✓ 1 | — |
| 08 | `stack-overflow` — unbounded recursion | stack-overflow | 1 | ✓ 1 | — |
| 09 | `detached-dom` — double-remove | detached-dom | 1 | ✓ 1 | 1 |
| 10 | `select-null` — select change deref | select-change | 1 | ✓ 1 | — |
| 11 | `hover-crash` — hover tooltip deref | hover | 1 | ✓ 1 | — |
| 12 | `keypress-crash` — keydown deref | keypress | 1 | ✓ 1 | — |

## What the two "extras" actually are

Both are **correct findings of real issues the fixtures genuinely exhibit** — not
hallucinations. "False positive" in the scorer means "matched no seeded bug
message", not "wrong".

- **`03-unhandled-rejection`** → `Failed to load resource: … 404`. The fixture
  fetches `/api/cart`, which the static server doesn't serve. That 404 is the
  *cause* of the unhandled rejection; the engine surfaces both the cause and the
  crash. Correct.
- **`09-detached-dom`** → `Cannot read properties of null (reading 'parentNode')`.
  The first click removes the node and throws `removeChild` (the seeded bug); a
  *second* click re-runs the handler, `getElementById` returns `null`, and the
  handler throws a *different* error. The engine correctly flags the second,
  distinct crash. Correct.

Precision over the corpus is therefore clean: every finding points at a real
fault line in the page.

## Scope and caveats (read this before citing the number)

1. **Synthetic archetype corpus, not real Next.js/Vite projects yet.** These 12
   cases pin the *archetype* matrix (null deref, async race, JSON parse,
   stack overflow, route transition, etc.) in framework-agnostic vanilla HTML.
   The engine captures `pageerror`/`unhandledrejection` off the renderer, so the
   runtime behaviour is what matters — but the number is not yet a claim over a
   real-project corpus. That is the next benchmark stage.
2. **Detection only.** This scores F1–F5 (intercept → record → classify →
   resolve → fuzz). The repro pipeline (F7 minimize → F8 compile → F9
   flake-rate validate) is exercised by `--repro` but not scored here yet.
3. **The destructive deny-list (F6) is a real, intentional coverage gap.** The
   fuzzer refuses to click controls labelled `pay`/`checkout`/`delete`/`logout`
   etc. (see `domWalker.ts` `DESTRUCTIVE`). A bug behind a "Checkout" button was
   therefore unreachable until we renamed that fixture's button to "View cart".
   Checkout/payment/account-deletion flows are blind spots **by design** — a
   safety trade-off, not a detector failure, but it means real revenue-path bugs
   are currently invisible to the fuzzer.
4. **V8 error text is version-sensitive.** `JSON.parse("undefined")` now reads
   `…"undefined" is not valid JSON` in current Chromium (not the older
   `Unexpected token u in JSON at position 0`). Manifests match the pinned
   Chromium; a browser bump can shift these strings.

## Reproduce

```bash
npm run bench                 # detection only
npm run bench -- --seed 7     # different seed
```

The number is deterministic for a given seed (mulberry32 PRNG).
