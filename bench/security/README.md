# AztrxBench security v0

`bench/` and `bench/frameworks/` score runtime-crash recall. This corpus
scores the swarm's other job: proving a business-logic/security hypothesis
end to end, with an executable repro as the receipt. It's intentionally
small — five cases, each with exactly one seeded bug (or, for the negative
control, deliberately zero) and an unambiguous oracle, rather than a large,
half-finished corpus.

## What it measures

**Detection rate** — of the seeded bugs, how many the swarm surfaces as a
finding. `false positives` (findings matching no seeded bug) are reported
separately, and so is the **episode verdict** (from F11 telemetry) for the
one role each case was designed for — a cheap cross-check that the mission
actually ran the intended hypothesis, not just that a finding happened to
appear.

## Method

Each case in `cases/` is a self-contained static app (one or two HTML files)
with one seeded business-logic/security bug and a `manifest.json` recording
the ground truth: `category`, `expected_invariant`, `known_exploit_path`,
and the `expected_role` (which catalog role, if any, is designed to catch
it). The runner:

1. serves `cases/` over a local HTTP server,
2. drives the real `run()` with the **full role catalog** (`--roles` = every
   id in `ROLE_CATALOG`, not `--swarm` synthesis — deterministic and
   reproducible run over run) against each case, with `--telemetry` on,
3. matches findings to the manifest by `rawMessage` substring,
4. scores recall + false positives, cross-checks the expected role's
   episode verdict, and writes `bench/security/.out/results.json`.

aztrx is given nothing but the case's URL. `known_exploit_path` is scoring
ground truth, read by the runner, never passed to the run.

## Run

```bash
npm run build
npx tsx bench/security/run.ts                 # detection only
npx tsx bench/security/run.ts -- --seed 7      # different seed
```

## Latest result

See [RESULTS.md](RESULTS.md).

## Why these five cases

A hard limit, on purpose: a handful of finished cases beats a large
half-built corpus, and a benchmark only tells you something if its oracle
is unambiguous.

- **Auth bypass** (`paywall-bypass`) and **role escalation**
  (`token-tamper`) exercise detection primitives that already existed —
  the sanity check that the harness itself is sound.
- **IDOR** (`03-idor`) is the case that mattered: the first v0 run of this
  bench found that nothing in the engine swapped an object id and checked
  the response for an ownership mismatch. That gap got a general primitive
  — `objectRefAudit` (role `object-ref-auditor`) in `src/core/security.ts` —
  not a fixture-specific patch. See [RESULTS.md](RESULTS.md) for what it
  does and doesn't cover (numeric ids only, ±1 siblings, v1).
- **`04-idor-safe`** is a negative control, same shape as `03` but with a
  real ownership check enforced. Without this, it's impossible to tell a
  genuine IDOR detector from "flags any endpoint with a number in its URL."
  It must stay silent, and does.
- **`05-idor-path`** is the same bug class with the id in a path segment
  instead of a query param, to check the primitive generalizes across
  shapes rather than being written against one. Building it also exposed a
  real, unrelated memory-exhaustion bug in two existing crawl primitives —
  see RESULTS.md.

Reusable-coupon abuse and race/double-redemption cases are still left out
of v0: no business-invariant checker (price deltas, redemption counts)
exists yet to serve as their oracle, so they'd be confirmatory misses, not
new information. Worth adding once the engine grows that primitive — not
before.
