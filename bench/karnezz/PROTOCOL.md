# Karnezz Lab — Mission 001: no-hint discovery pilot protocol (frozen before task selection)

This is a **local pilot**, not an official SWEeper-Bench result. The official
harness needs Modal (paid), `HF_TOKEN` and GHCR tokens, and scores find-and-fix;
Karnezz only finds. Nothing here may be reported as a SWEeper-Bench score.

## Order of operations (the order is part of the protocol)

1. Implementation is finished, tested on a fixture app *we* wrote, and committed.
2. Only then is the task chosen, by the rule below. The commit hash of step 1 is
   recorded in the sealed answer file, proving the implementation predates it.
3. After step 2 nothing under `src/core/hypothesis/` or the prompts may change
   until the evaluation is complete. A change after seeing a result voids the run
   (a *new* run may follow, labeled as a second attempt on a task already seen).

## Task selection rule

One merged, user-facing bug-fix pull request in an independently developed web
application, chosen by this filter, first match wins, in this order:

- public repository, permissive license, written in a language we do not control
- the parent commit builds and serves with **no external dependency**: no hosted
  DB, OAuth provider, payment/email service or secret (embedded SQLite or
  in-memory is fine) — survey blocker #4
- starts locally in a Docker container or a plain process within 10 minutes
- the bug is observable through the browser, not only through logs
- the fix PR touches at most 5 files (so a reference verification is simple)
- the repository is **not** one that appears in `bench/` or `fixtures/`

Selection is recorded with the date, the search used, and every candidate
rejected and why.

## Sealed material

`sealed/answer.json` (outside the discovery working directory) holds: PR URL and
title, buggy and fixed commit SHAs, the diff, a plain description of the bug, and
the verifier steps. The discovery and baseline processes run with a working
directory and environment that do not contain it. The implementer (this
assistant) does not read it until both arms have finished and their reports are
written.

## What each arm receives (exact)

- the application's source tree **at the buggy commit, with `.git` removed**
- the base URL of the app running at that commit
- the inventory text built from: README/docs files, test *names*, and a
  one-hop observation of the running UI
- the same model, same provider settings, same browser primitives
- the same budgets: spend cap, wall-clock cap, step/turn cap

Not provided to either arm: the PR, the issue, commit messages or history, the
fixed commit, any diff, any product-area hint (unlike SWEeper-Bench "scoped"
prompts, we give none — this is stricter), the verifier steps.

## Budgets

- Spend: $5 total for the pilot across both arms and any second attempt;
  each arm stops *before* a call whose worst case would cross its share.
  Prices are operator-supplied (`AZTRX_PRICE_IN/OUT`); with no prices there is no
  run.
- Wall clock: 10 min per arm. Steps: 12 experiments (pipeline) / 40 turns (baseline).

## Scoring (applied identically to both arms)

A *claim* is a hypothesis with outcome `supported_violation` (pipeline) or a
`report` action (baseline). The evaluator, which holds the sealed answer:

1. **Leak check:** none of the sealed fragments appears in anything an arm was
   shown or produced. Any hit voids that arm's run.
2. For each claim, replays its steps against the buggy app and the fixed app.
   - **Verified finding**: reproduces on buggy, does not on fixed, and the
     difference is the behavior the fix addresses (judged on the sealed
     description, recorded with reasoning).
   - **Other real defect**: reproduces on buggy *and* fixed — a real, unrelated
     defect or intended behavior; not credited as a hit, listed separately.
   - **False positive**: does not reproduce on buggy, or is intended behavior.
   - **Environment**: caused by the sandbox, not the product.
3. **Target hit** = a verified finding that is the sealed bug.

Reported per arm: target hit (yes/no), verified findings, other real defects,
false positives, unknown outcomes, experiments/turns, model calls, tokens,
dollars, minutes, dollars per verified finding.

## Claims we will not make

One task is an anecdote. No superiority claim from it; no rate; no
"outperforms". A hit supports "the pipeline can work on at least one task"; a
miss is analysed by stage and reported as such.
