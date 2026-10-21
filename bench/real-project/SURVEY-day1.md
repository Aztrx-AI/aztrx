# External failure survey — sprint day 1 (2026-10-21)

Engine unchanged (HEAD `2be80e0`). Five projects we did not write, each run as
`aztrx run <url> --repo <repo> --diff HEAD~1 --telemetry --no-boot` on a real
upstream commit. No engine patch between runs.

| project | change under test | evidence | invariant | runtime bound | planned | executed | observed | verdict | stopped at | exact reason |
|---|---|---|---|---|---|---|---|---|---|---|
| kanban_ (Vite/React) `f2628a7` | `countCompleted` reads `newTask.subtasks`, not `ModalDetail.subtasks` | yes (1 diff + 3 served) | **no** | - | - | - | - | none | invariant_inferred | a derived value, not a threshold or a transition table |
| kanbanboard-app-react (CRA) `7023d25` | localStorage write moved into a `useEffect` | yes | **1, unrelated** (`basic < 0` in `vendors~main.chunk.js`) | **no** | yes | no | no | unknown | runtime_bound | the one rule came from library code, not the change; no input named `basic` |
| MealMart client (Vite/React + remote API) `0a69d23` | `cartSlice` `addToCart` gains `restaurantId`; 15 files | yes (15 diff + 3 served) | **no** | - | - | - | - | none | invariant_inferred | types/props/UI edits, no stated rule |
| TaskyHub (Next 15, Mongo, Google auth) `aeeebd7` | inline retry state instead of a toast | yes (1 diff + 8 served) | **no** | - | - | - | - | none | invariant_inferred | UI state change; also needs Mongo + OAuth, not detected or reported |
| EasyBuy (Next 16, Prisma) `b8610cf` (earlier run, since fixed by generalization v1) | successor-list order table | yes | no at the time | - | - | - | - | none | invariant_inferred | successor-list shape |

Wall time per run: 7-32 s. All exits 0, 0 findings of substance (one
`NotSameOrigin` image-load warning on MealMart).

## Offline yield: how often does the grammar read a rule from a real commit?

`npx tsx bench/real-project/yield.ts <repo>...` replays the last 40 non-merge
commits of each clone through the same inference code (no server needed).

| repo | code-changing commits | commits yielding any rule |
|---|---|---|
| kanban_ | 19 | 0 |
| kanbanboard-app-react | 22 | 0 |
| MealMart client | 27 | 0 |
| TaskyHub | 20 | 0 |
| tickpath | 18 | 0 |
| inventory-app | 14 | 0 |
| **total** | **120** | **0** |

## Blockers, ranked

1. **No rule is stated in the form the engine can read.** 0 of 120 real
   commits, 0 of 4 live runs. Frequency 100%, impact total: the pipeline never
   starts, and the user gets "0 findings" that reads like "all good". The
   engine accepts two literal statement forms (numeric threshold, action-map /
   successor-list table); real changes are derived values, persistence,
   props, UI state, request shapes.
2. **Served-JS evidence yields rules from library code** (1 of 4 runs): a
   `basic < 0` clamp in a vendor chunk became the only candidate, unrelated to
   the change. Impact: wastes the run, can emit a misleading `unknown`.
3. **Runtime binding of an inferred rule** (1 of 1 that got that far): no
   control matched the variable name. Small sample, not yet generic.
4. **Environment is invisible** (3 of 6 projects need a DB/OAuth/remote API;
   TaskyHub, tickpath, inventory-app; MealMart works only against a hosted
   API). Aztrx neither detects it nor says ENVIRONMENT; it reports a clean run.
5. **A zero-rule run is silent.** No "I could not infer anything about this
   change" outcome; indistinguishable from a pass.

Single highest-value generic blocker: **#1**. #5 is its user-facing twin and is
cheap to fix alongside it.
