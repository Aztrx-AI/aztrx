# AztrxBench security v0

`bench/` and `bench/frameworks/` score runtime-crash recall. This corpus
scores the swarm's other job: proving a business-logic/security hypothesis
end to end, with an executable repro as the receipt. It's intentionally
small — three cases, each with exactly one seeded bug and an unambiguous
oracle, rather than a large, half-finished corpus.

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

## Why only three cases, and why these three

A hard limit, on purpose: three finished cases beat ten half-built ones, and
a benchmark only tells you something if its oracle is unambiguous. These
three were picked to be maximally informative about where the swarm's
security/business-logic coverage actually stands today, not to flatter it:

- **Auth bypass** (`paywall-bypass` role) and **role escalation**
  (`token-tamper` role) exercise real, working detection primitives
  (`src/core/security.ts`) — these are the sanity check.
- **IDOR** has no working detection primitive at all right now: nothing in
  the engine swaps an object id (path or query) to another valid record and
  checks the response for an ownership mismatch — `httpFuzzer.ts`'s query
  mutations target 5xx responses, not a 200 with someone else's data. This
  case is *expected* to miss, and that miss is the single most useful
  number in this corpus — it names a real, currently-unaddressed detection
  class rather than a fixture bug.

Reusable-coupon abuse and race/double-redemption cases were left out of v0
for the same reason IDOR currently misses: no business-invariant checker
(price deltas, redemption counts) exists yet to serve as their oracle
either, so they'd add confirmatory misses rather than new information. Worth
adding once the engine grows that primitive — not before.
