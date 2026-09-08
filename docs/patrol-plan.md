# Aztrx — Autonomous Bug Patrol (PRD)

**Thesis:** Aztrx already has the hard 70% — a full `detect → repro → heal → apply → PR`
pipeline. The leap from "dev tool you run" to "product that feels magic" is a
*supervisor loop + memory + PR dedup* wrapped around that pipeline, plus a visible
proof artifact. This document fixes the vision, the phases, and the demo.

---

## 1. Why the current product reads as incremental

Today Aztrx is correct but **pull-based**, **manual**, and **textual**:

| Axis | Today | The leap |
|---|---|---|
| Trigger | you run `aztrx run` | `aztrx patrol` runs itself |
| Review | you read findings, pick fixes | PRs land without you |
| Output | terminal findings + code diffs | a shareable "before/after" proof |

The engine already detects → diagnoses → fixes (rule-based + LLM) → verifies →
opens PRs. What's missing is the loop, the memory, and the artifact — not the
intelligence.

## 2. Where the "wow" actually lives

Furor is a *shareable moment*, not a feature count. For Aztrx it is one sentence:

> **"Your app is broken right now — Aztrx found and fixed it while you weren't looking."**

Three beats make it land:

1. **You didn't know** — the product tells you a crash is live in production.
2. **You see it** — a recorded repro, not a wall of text.
3. **It already worked** — a verified fix is waiting as a PR.

Phase 0/1 give you beat 3. Phase 2 keeps beat 3 from becoming "it opened the same
PR three times and burned the budget." Phase 3 delivers beats 1 and 2 — the
public, tweetable part.

## 3. Architecture

`run()` in `src/core/orchestrator.ts` is the single-pass engine and is reused
unchanged. Patrol is a thin supervisor around it:

```
loop:
  liveness-check the URL            # dead target → skip the cycle
  findings = run({ repro, heal })   # full closed loop, silent (ui: true)
  mark unfixable                    # reproducible-but-not-healed → never retry
  for each new healed finding:
    apply patch (scoped files)
    open PR (dedup by fingerprint)  # skip if a PR already exists
    mark in memory
  save memory
  sleep(interval)
```

New pieces:

- `src/core/patrol/state.ts` — `.aztrx/patrol.json`, fingerprint → `pr-opened |
  unfixed`. The memory that makes the loop idempotent.
- `src/core/patrol/pr.ts` — `openPatrolPr`: fingerprint-stable branch
  (`aztrx/fix-<fp8>`), `gh pr list --head` dedup, and `git add -- <files>` (never
  `git add -A`, so an autonomous run can't sweep up the user's unrelated work).
- `src/core/patrol/loop.ts` — the supervisor loop + guardrails.
- `src/cli.ts` — the `patrol` command.

## 4. Phased plan

### Phase 0 — engine (done)
`detect → repro → heal → apply → PR` in `run()` / `--fix`.

### Phase 1 — autonomous patrol (done)
The core "automatic" story. Delivered:

- `patrol` command (`--interval`, `--max-fixes`, `--once`, auth/heal passthrough).
- Cross-run memory (`PatrolState`), PR dedup, scoped staging, liveness check,
  per-session fix cap.

**Re-heal avoidance (shipped in Phase 1.5):** `run()` used to heal internally, so
an already-handled bug got *re-healed* before patrol skipped the PR — wasted LLM
spend per cycle. Fixed by `RunOptions.skipHealFingerprints`: `PatrolState.handled()`
feeds the skip-set into `run()`, and the heal pass filters it out before any
generation. A re-scan still re-detects (to confirm the bug stays gone) without
re-paying to re-fix it.

### Phase 2 — reliability (done)
Makes the autonomy trustworthy before it's shown off:

- ~~**Unfixable backoff**~~ — shipped: `--retry-after <s>` (default 30 min) makes
  `PatrolState.isHandled()` expire an `unfixed` mark once the cooldown lapses, so
  a retried bug is healed afresh instead of skipped forever.
- ~~**Batch PRs**~~ — shipped: `--batch` groups a cycle's fixes into one PR;
  `openPatrolBatchPr` branches from a SHA1 of the sorted fingerprint set.
- ~~**Live status**~~ — shipped: a rolling `found N · fixed M · PRs K` tally per cycle.
- ~~**Skip-set threading**~~ — shipped (see Phase 1.5).
- ~~**Spend cap**~~ — shipped: `--max-spend <n>` threads one `SpendBudget` through
  every `run()`/`heal()` of the session; `generatePatch` charges it per paid
  completion, throws `budget-exhausted` at 0, and patrol ends the session. Free
  rule fixes are never charged, and budget-exhausted/no-llm findings are not
  marked unfixable.

### Phase 3 — the proof artifact (in progress)
The public "wow":

- **Recorded repro** — Playwright `page.video()` / trace → GIF in the PR body.
  *(parked: recording/encoding approach undecided)*
- ~~**Plain-language report**~~ — shipped: the PR body renders each finding as a
  before/after narrative — crash headline, location, a one-line `diagnoseFinding`
  "why", and the healed fix explanation.
- ~~**"Live in prod" flag**~~ — shipped: `isLocalUrl()` detects loopback/localhost;
  a non-local target gets a "this crash is live in production" banner in the PR.

## 5. Guardrails

| Guardrail | Status |
|---|---|
| Always a PR, never a push to `main` | ✅ in `openPatrolPr` |
| Verify before PR (gate → compile → test → replay) | ✅ in `heal` |
| Scoped `git add` (no unrelated changes) | ✅ |
| Per-session fix cap | ✅ (`--max-fixes`, default 5) |
| Idempotent (memory + PR dedup) | ✅ |
| Unfixable backoff / spend cap | ✅ |

## 6. The 30-second demo

- **0–5 s** — terminal, one command: `aztrx-cli patrol https://app.example.com --repo .`
- **5–15 s** — live panel: crawls → fuzzes → `crash: Cannot read properties of
  undefined (reading 'address')` on `/checkout`.
- **15–25 s** — it works alone: repro → heal → verify → PR. Counter ticks `fixed 3`.
- **25–30 s** — GitHub opens: a PR with the before/after, green tests, plain words.

**CTA:** *"Your prod is broken right now. Aztrx found and fixed it while you weren't looking."*

## 7. Open questions

1. **Patrol against production or staging?** Production is the emotionally strong
   demo but risky for an autonomous *fixer*; staging is safe but less urgent. Likely:
   patrol staging by default, prod in a "scan-only, no PR" mode.
2. **One PR per bug vs batched?** Phase 2. Batching reads better in a demo (one PR
   with "fixed 3 bugs") but dedup is simpler one-per-bug.
3. **How much autonomy is too much?** The merge stays human. Everything up to the
   PR is fair game to automate; the PR is the hand-off line.
