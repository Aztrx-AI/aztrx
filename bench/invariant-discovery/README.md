# AztrxBench invariant-discovery v0

One capability, scored by stage: **infer one behavioral rule from the code an
app serves, without being told what to test, design a boundary experiment for
it, and prove or clear the rule at runtime.**

```
served code ──► InvariantCandidate ──► ExperimentPlan ──► runtime observations
 (evidence)       (infer.ts)            (plan.ts)          (runtime.ts)
                                                               │
                              compileCandidate ──► evaluateInvariant ──► verdict
                              (compile.ts)          (invariant.ts, unchanged)
```

aztrx gets only the URL. `expected_candidate` in each manifest is ground truth
for scoring the inferred rule and is never fed to the run.

## Cases

| # | case | expected |
| --- | --- | --- |
| 01 | `free-shipping-boundary` — the client code says `cart.total >= 50 ⇒ shipping 0`; the server's quote uses `>`, so exactly 50 is charged | rule discovered, **violated** at `boundary` only |
| 02 | `free-shipping-safe` — identical code, server honours `>=` | rule discovered, **preserved**, no finding |

Both pages also contain a second stated rule (`order.quantity >= 10 ⇒ handling
0`) that nothing on the page can drive. It must stop at **binding** and say so;
it is the standing check that an unbindable rule neither crashes nor guesses.

## What is reported (separately, per case)

`rule discovered` · `experiment executed` · `violation proven` (violated *and*
reproduced on replay) · `unexpected findings` (everything else the full role
catalog said) · `time-to-proof`. On a miss the runner names the weakest stage:
evidence extraction / inference / binding / planning / execution /
observation-evaluation, taken from the trace the episode logged.

Run: `npm run bench:invariant` (`--seed`, `--max-actions` as in the other corpora).
