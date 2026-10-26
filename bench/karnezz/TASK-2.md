# Mission 002 / Phase 4 — independent task 2: frozen protocol and selection record

Written and committed **before either arm has run**. It follows `PROTOCOL.md`
(Mission 001) except where this file says otherwise. Grimoire is not reused: its
answer was opened and it is calibration only.

## Frozen engine and model

- Implementation under test: commit `64d7b3a` (accepted as the baseline by the
  operator). Nothing under `src/core/hypothesis/`, `src/core/llm.ts` or the
  prompts changes between this commit and the end of the evaluation. A change
  after seeing a result voids the run; a later run would be labelled a second
  attempt on a task already seen.
- Model, both arms: `qwen3.5:9b` via Ollama 0.40.6, local only. `AZTRX_API_BASE=http://localhost:11434/v1`,
  native transport (thinking off, schema-constrained hypotheses, native tool calls), temperature 0.
- No paid API, no cloud.

## Application (given to both arms)

| | |
|---|---|
| Application | `pawelmalak/flame`, a self-hosted start page / bookmark & app launcher (Node + React, embedded SQLite; MIT) |
| Buggy revision | `188c5bc04b6a7bade12cded24259003dcc247999` (the mainline commit directly before the reference fix) |
| Run as | Docker image built from that revision's own `.docker/Dockerfile`, default configuration as shipped (`PASSWORD=flame_password` from the Dockerfile `ENV`) |
| Source tree handed to the arms | `git archive` of that revision: no `.git`, no history |

## Selection procedure (objective; applied before looking at anything but titles)

1. Candidate pool: `gh search repos --topic self-hosted --language TypeScript|JavaScript --license mit --stars 300..8000 --archived=false --sort stars`, 2026-10-27.
2. Walk the pool in star order; reject an app that needs an external service (hosted DB, LLM, OAuth, payments), is not a browser application, or is Grimoire / in `bench/` / in `fixtures/`. Rejected before reaching Flame: evidence (BI over external databases), open-multi-agent, TaxHacker (LLM + Postgres), mission-control (AI-agent control plane). Flame is the first that remains: embedded SQLite, Dockerfile, no external dependency.
3. Within the chosen repository, list merged pull requests newest-merged first and take the **first whose title says fix/bugfix, touches ≤ 5 files, and concerns behavior a user can observe in the browser**. Rejected before it: #488 "fix: sqlite amd64 crash" (native binary crash, not browser behavior) and #314 "fix: Update Permissions on Startup" (filesystem permissions, not browser behavior). The next qualifying PR is the sealed one.

## Sealed material

Held in `karnezz-lab/sealed2/` (outside the repo and outside both arms' working
directories): the PR record, the fix diff, and an answer file naming the PR and
fixed revision. SHA-256 commitments, so the answer cannot change after the runs:

```
8eae077841b2e9c8a21cc025ca18cfb5413bcec49bf38647b3c46ed67ccbb69b  answer.json
827880d09098d838613476b41d38e8d1bdbb44c7a22ed05124ce50b341c2422b  fix.diff
f93c74cfc3f75095446e6fca95f86225ba71c4b6232dfe9fe89537ef58f38868  pr.json
```

The
implementer does not open the sealed files until both arms' reports are written.

## What each arm receives (identical)

- the buggy source tree (above) as `--repo`; inventory text built from README/docs, test names, and a one-hop UI observation of the running app
- a running instance of the app at that revision, in **its own freshly started container** per arm
- the same model, transport, prompts, browser primitives (Playwright, headless Chromium 1280×800)

Not provided: PR, issue, commit messages, history, the fixed revision, diffs, any product-area hint, verifier steps.

## Budgets (identical, as Mission 001)

- wall clock 10 min per arm; model-call and token usage recorded (local, so $0)
- Karnezz arm: ≤ 12 experiments; baseline arm: ≤ 40 turns, ≤ 700 output tokens/turn, ≥ 3 consecutive invalid calls ends it
- Karnezz: container restarted to a fresh state before every experiment run (`--reset`); baseline: one fresh container, one continuous session. This is a real procedural difference — the pipeline replays violations in fresh sessions by design; the baseline has no such stage — and is recorded rather than hidden.

## Rules for interpreting results (stated in advance)

- A reading that is not what the hypothesis needs (e.g. a heading read as a number) is an **observation/binding failure**, `unknown`, never a finding.
- A hypothesis whose only anchor is a loose universal convention is **not a verified requirement**. A `supported_violation` from one is a *lead*; it counts as a finding only if the sealed description or the fixed revision independently shows the behavior is a defect.
- No success is claimed without replaying the arm's own steps against both the buggy and the fixed revision.
- Leak check: sealed fragments that are not part of the application source (title/description phrases) must not appear in anything an arm saw or produced.

## Disclosures

- The selector (this assistant) read: the candidate repo list; the merged-PR list with titles, file counts and line counts; the sealed PR's merge commit SHA; and, by an unfiltered `git log --oneline` in the parent, the first characters of the mainline parent's subject (`Fixe…`), a commit that is not the fix. The PR body and diff were written to sealed files by redirection and not displayed.
- The selection trail names the two PRs rejected before the sealed one (#488, #314); the sealed PR's number, title and size are not recorded here. The selector also saw the sealed PR's title and size while applying step 3, as in Mission 001.
- One task is an anecdote. No rate, no superiority claim.

## Addendum A — attempt 1 void, attempt 2 (recorded before attempt 2 ran)

Attempt 1, Arm A (pipeline, commit `a567849` on engine `64d7b3a`), produced **no
experiments**: generation ended `format_error` / `finishReason: length` after 1,126
output tokens with a 2,970-token prompt. The Ollama server log shows
`n_ctx_slot = 4096 … task.n_tokens = 2970 … n_tokens = 4095, truncated = 1`: the
native transport never set `num_ctx`, so the 4,096-token default window cut the
reply. This is an interface defect (my smoke fixture's inventory was too small to
expose it), not a statement about the model or the task. The baseline arm had not
run. Attempt 1 is void and is kept as a record; its output stays in `runs2/armA`.

The only change: `src/core/llm.ts` passes `num_ctx` (default 16384, `AZTRX_NUM_CTX`)
to Ollama, for both arms. No prompt, schema, validator, budget or protocol rule
changes. Attempt 2 is a second attempt on a task whose first attempt was seen, and
runs both arms from fresh containers under the unchanged budgets.
