# AztrxBench invariant-discovery

One capability, scored by stage and by rule family: **read a rule from code —
the code the app serves, the code in the repo, or the code a change just
touched — without being told what to test, choose the experiment that rule's
*form* calls for, and prove or clear the rule at runtime.**

```
evidence ──► InvariantCandidate ──► ExperimentPlan ──► runtime observations
 served_js     (infer.ts)           (plan.ts)           (drivers.ts)
 repo_source        │                    │                    │
 git_diff           │                    ▼                    ▼
 (evidence.ts)      └────────► compileCandidate ──► evaluateInvariant ──► verdict
                               (compile.ts)          (invariant.ts, unchanged)
```

`infer.ts` reads one `EvidenceChunk` shape and does not know which source made
it. aztrx gets only the URL (and, for diff / repo cases, the project directory
it runs in). `expected_*` in each manifest is ground truth for scoring and is
never fed to the run.

## Families

| family | rule shape | plan | judged by |
| --- | --- | --- | --- |
| numeric threshold | `cart.total >= 50 ⇒ shipping == 0` | `numeric-boundary`: below / boundary / just-above / clearly-above | `evaluateInvariant` |
| state transition | `orderMachine`: in `cancelled`, `fulfill` has no edge ⇒ must not change the state | `state-transition`: reach the state along declared edges, take the action, expect the state to hold; plus a control where the action *is* allowed | `evaluateInvariant` |

Neither family has a feature-specific checker. A test fails the build if the
discovery code names a product feature.

## Cases

| # | family | case | evidence | expected |
| --- | --- | --- | --- | --- |
| 01 | numeric | free-shipping boundary — client code says `>=`, server uses `>` | served_js | **violated** at `boundary` only |
| 02 | numeric | same code, server honours `>=` | served_js | preserved |
| 03 | numeric | the latest *change* moves the threshold in `src/shipping.js`; the running server still breaks the boundary | git_diff | **violated** at `boundary`; trace → `src/shipping.js:7` |
| 04 | numeric | same change, server honours it | git_diff | preserved |
| 05 | numeric | nothing changed since the last commit | git_diff (empty) | **no candidate, no finding** — nothing may be invented |
| 06 | transition | the latest change makes `cancelled` terminal in `src/orderMachine.js`; the running server still lets a cancelled order be fulfilled | git_diff | **violated** in `forbidden`; trace → `src/orderMachine.js:5` |
| 07 | transition | the repo says `cancelled` is terminal, server enforces it | repo_source | preserved |
| 08 | transition | same change as 06, server enforces it | git_diff | preserved |

Diff cases ship `repo/commit/` (committed) and `repo/working/` (layered on top,
uncommitted); the harness makes a real git repository out of them, so `--diff`
reads a real `git diff`. Cases 01/02 also carry a second stated rule
(`order.quantity >= 10 ⇒ handling 0`) that nothing on the page can drive; it
must stop at **binding** and say so.

## What is reported (per case, per family)

`rule discovered` · `correct evidence source` (and, where pinned, the exact
`file:line`) · `plan generated` · `experiment executed` · `violation proven`
(violated *and* reproduced on replay) or `rule cleared` · `unexpected findings`
(everything else the full role catalog said) · `time-to-proof`. On a miss the
runner names the weakest stage: evidence / inference / binding / planning /
execution / observation-evaluation, taken from the trace the episode logged.

Run: `npm run bench:invariant` (`--seed`, `--max-actions` as in the other corpora).
