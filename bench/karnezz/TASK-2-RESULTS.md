# Task 2 results — `pawelmalak/flame`, buggy revision `188c5bc04b6a7bade12cded24259003dcc247999`

Protocol: `TASK-2.md` (frozen in `a567849`, addenda A and B recorded before the
attempt they describe). Local only: Ollama, `qwen3.5:9b`, $0, Docker for the app.
Traces: `results/task2/`. This is **one task and one attempt that reached
experiments** — an anecdote, not a rate, and no comparison between the arms is claimed.

## Attempts

| # | Engine | Arm A (Karnezz) | Arm B (baseline) | Why void |
|---|---|---|---|---|
| 1 | `64d7b3a` | no experiments: reply cut by Ollama's default 4,096-token window | not run | `num_ctx` never set |
| 2 | `57fa0c6` | no experiments: 12/12 hypotheses rejected, relations named readings bare | 4 turns, 1 valid call; sent `target` as a string 3× | schema could not require `snapshot.reading`; error had no example |
| 3 | `37ffa38` | **ran** | **ran** | — |

Each earlier attempt failed on an interface defect, was disclosed, fixed
(generically, against the dev fixture and unit tests) and re-run from fresh containers.
The task was therefore seen three times; the sealed answer was opened only after
attempt 3. The fixes were not informed by the bug.

## Attempt 3

### Arm A — Karnezz pipeline (2m49s, 3,027 in / 2,409 out tokens, 1 model call)

| | |
|---|---|
| Hypotheses generated | 12 returned, 10 accepted, 2 rejected ("steps missing, too many, or malformed") |
| Independent expectation sources | **0.** All 10 are `universal`; none quotes the README, a test name or UI text |
| Near-duplicates collapsed | 6, leaving 4 prioritised |
| Experiments executed | 4 |
| Valid observations | 2 (both in one experiment) |
| `supported_violation` | 1 |
| `unknown` | 3 — all "step could not run": `fill`/`click` on a control found by visible text timed out (8 s) |
| `disproven` / `environment` | 0 / 0 |

The one violation (h3): "count of applications equals the number of items in the
list", expected `app_list_count == 10`, read `0` on `/settings/app` while logged
out. The constant `10` appears nowhere in the app, README or UI; it is the model's
guess. **Independent replay: identical result on the buggy and the fixed build**
(`bench/karnezz/replay.ts`), so it is not the sealed bug, and with an invented
expectation it is not a defect at all. **Verdict: false positive**, correctly a
lead under the pre-stated rule (universal-only expectation), but the engine still
reported it as `supported_violation`.

### Arm B — matched baseline agent (3m43s, 172,309 in / 1,054 out tokens, 40 model calls)

| | |
|---|---|
| Valid tool calls | 40 / 40 (valid-call rate 1.0); 0 invalid, 0 with no tool call |
| Runtime tool errors | 17 (all `click` timeouts) |
| Observations | 20 |
| State-changing actions executed | 9 |
| Claims / discoveries | 0 |

Turns 2–29: it repeatedly clicked a "Go to Settings" control that was not there
(by text, then by `a[href='/settings']`), alternating with `look`, ~28 turns spent.
At turn 30 it went to `/settings`, then `/settings/app`, tried to log in with the
password `test` (a guess; it did not use `flame_password`, which the README shows),
and the turn cap arrived at 40. One guessed password is a login attempt, which the
system prompt tells it not to make; recorded as a conduct finding.

## Independent verification (sealed answer opened after both reports were written)

- Hashes of the three sealed files matched the commitments in `TASK-2.md`.
- **The sealed bug:** the search bar's query parser did not apply the user's
  "open search results in the same tab" setting when the query starts with the
  local-search prefix; the reference fix is a 2-line change in one client file.
- **Leak check:** no title/description fragment of the sealed material appeared in
  anything either arm saw or produced (the two hits for "prefix" are the README's own
  sentence about search prefixes).
- **Verified discoveries: 0 for both arms.** Target hit: no / no.
- **False positives:** Arm A 1 (above); Arm B 0 (it made no claims).
- **Reached the relevant functionality?** No, neither. Reaching it needs (1) a login
  — the app is read-only to a logged-out user, (2) turning the same-tab setting on
  in settings, (3) typing a `/l …` query in the search bar and opening a result.
  Arm A never logged in (its tests of `fill`/`click` on edit forms timed out
  because they are not available logged out) and its search hypothesis did not use a
  prefix. Arm B reached the login form at turn 31 and failed to authenticate.

## Milestones

- **Minimum engineering milestone** (both agents perform meaningful real actions and obtain observations on an independent application): **met, weakly.** Arm B: 9 real actions and 20 observations. Arm A: 4 experiments executed but only 1 produced readings (2 values); 3 failed at the first interaction.
- **Research milestone** (an arm independently identifies and reproduces a genuine defect): **not met.**

## Failure modes, measured

1. **Authentication wall (both arms).** The app serves a read-only view until the
   operator password is entered. The README shows the docker `PASSWORD` example; neither
   arm used it. Nothing in the engine models "an app that needs credentials the docs
   mention".
2. **Target binding by visible text (Arm A).** 3 of 4 experiments died on the first
   `fill`/`click` because the hypothesis named a control by guessed label text
   ("Name", "Sort by Name", "Search") that does not exist on the page; the inventory
   lists controls by type but the hypothesis generator is not shown the real controls
   of each page it will drive. Arm B shows the same weakness (17 timeouts).
3. **No independent expectations.** 10/10 hypotheses are loose universal
   conventions. The README's actual feature statements ("local filtering … prefix",
   "searching") produced none.
4. **Invented constants.** The one reported violation compares to a literal the
   model made up. The engine labels this `supported_violation`; the replay-in-fresh-
   session check confirms stability, not correctness.
5. **No recovery loop (Arm B).** 28 turns of the same failing click; no strategy
   change on repeated tool errors.

## Next specific intelligence bottleneck

**Grounding hypotheses in the live page.** Generation is a single call before any
interaction, so it guesses control names, assumes state (items already exist, logged
in), and invents constants. The next engine change worth testing is a generation
step that is shown (a) the real interactive elements of each page it targets and
(b) the README's concrete credentials/prerequisites, and that must anchor every
expectation in an inventory quote or compare two readings — plus demoting a
`supported_violation` whose expectation is `universal` with a literal constant to
`lead`. Not done here: it would be tuning after seeing this task's result.

## Resource limits

Local 9B model with 16,384-token context; 10-minute caps were never reached
(Arm A 2m49s, Arm B 3m43s). Docker Desktop on Windows; images built from the
revision's own Dockerfile (Node 16). Nothing paid, nothing outside `karnezz-lab`.

## Regressions

`npm run typecheck` clean; `npm test` 366/366 (364 before + 2 new); `bench:invariant`
13/13, identical breakdown. Other benches not rerun: nothing they exercise changed
(the diff is `llm.ts`, `src/core/hypothesis/`, `bench/karnezz/`, one test file).
