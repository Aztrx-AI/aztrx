# Mission 002 — fix the agent interface (Phases 1–3)

Mission 001 ended with neither arm reaching an experiment. This mission checks
the model/runtime interface *before* blaming the model. Model: the same local
`qwen3.5:9b` (Ollama 0.40.6). No paid API, no other model. Mission 001's
protocol, task-selection and baseline files are unchanged.

## What was wrong (measured, not assumed)

`llm.ts` sent every Ollama request to the OpenAI-compatible `/v1/chat/completions`.
Probe, same prompt, same model:

| Transport | Result | Time |
|---|---|---|
| `/v1/chat/completions` (what we sent) | answer correct, but a `reasoning` field of ~90 tokens came with it; `completion_tokens` counts thinking | 22 s |
| native `/api/chat`, `think:false`, JSON-Schema `format` | answer only, schema-constrained | 1 s |

1. **Thinking shares the output budget.** The baseline allows 700 tokens a turn
   and the generator 6000; a thinking model on `/v1` spends them on reasoning
   first, and nothing in the adapter can switch thinking off. Hypothesis and
   action JSON then arrives cut off or not at all.
2. **No output constraint.** The prompt *asked* for a bare JSON array; nothing
   enforced it, and the parser answered every failure with `[]` — so a malformed
   reply and "nothing worth testing" were the same result (`jsonArray` returned
   `[]` on parse failure).
3. **Baseline tool contract was informal.** Actions were free-text JSON
   (`{"act":…}`) described in a prompt paragraph. The description promised
   `look` returns "controls", the implementation returned none; an unknown
   action got the observation `unknown action` with no list of valid ones and no
   retry limit (40 invalid requests in Mission 001).

I did not attribute Mission 001's 40 invalid requests to a specific reply: I had
no Mission 001 transcripts to examine in this session. The three causes above
are what the code and the probe show; (1) is measured, (2) and (3) are read from
the source. They are sufficient to explain the symptoms, not proven to be the
only cause.

## What changed

- `src/core/llm.ts` — Ollama endpoints (port 11434, or `AZTRX_TRANSPORT=ollama`)
  are spoken to natively: `think:false` by default, optional JSON-Schema `format`,
  native tool calls, `done_reason` surfaced, real token counts for the ledger.
  `completeWithTools` also covers OpenAI-compatible endpoints. Anthropic and
  every non-Ollama OpenAI-compatible path are untouched.
- `generate.ts` — hypotheses are requested as `{"hypotheses":[…]}` under
  `HYPOTHESES_SCHEMA`. The status is now one of `ok`, `format_error`
  (unparseable / truncated / wrong shape, with the reason), `no_hypotheses`
  (valid, empty), `all_rejected` (valid, every candidate failed validation).
  Nothing is invented from bad data. New validation: a meaningful behavior
  statement, an action step, at least one snapshot, no reading compared with
  itself. The expectation-source rule (a quote the model never saw demotes to
  `universal`) is unchanged.
- `baseline.ts` — one tool registry (`look goto click fill press reload report
  done`) generates the model-facing definitions, validates arguments and
  executes, so a described tool is executable and vice versa. Unknown tool, bad
  arguments or no tool call → `invalid_tool_call` / `no_tool_call`, recorded,
  with the available actions shown; three in a row end the session. `look` now
  returns the controls it always claimed to.
- `index.ts`, `run.ts` — the report carries `generation.status` and an
  `observations` count; the baseline report carries per-turn status and metrics.
  `run.ts` accepts a local Ollama endpoint with no key, priced at $0.

## Smoke tests (development fixture `bench/karnezz/dev`, ours; not held-out data)

`npx tsx bench/karnezz/smoke.ts [--bug]` with `AZTRX_API_BASE=http://localhost:11434/v1
AZTRX_MODEL=qwen3.5:9b`. Stages are independent.

| Stage | Result (healthy fixture, last run) |
|---|---|
| 1 hypothesis | `ok`: 4/4 accepted, 0 rejected, 785 output tokens, ~25 s |
| 2 experiment | 5/5 steps executed, 2 real readings, **outcome `unknown`** (not decisive) |
| 3 baseline | 8/8 valid tool calls, 6 observations, 4 actions, 0 invalid, ~10 s |

`--bug` fixture: stages 1–2 identical; baseline 7/8 valid (one `fill` without
`value` recorded as `invalid_tool_call`, then recovered), 6 observations.
Neither arm detected the fixture's planted counter bug; that is not what smoke tests test.

Honest limits seen:
- Stage 2's `unknown`: the model chose the `<h1>` as the count's target, which
  holds "My notes", not a number. The executor correctly refused to call that a
  violation. This is a model target-selection weakness the interface cannot fix.
  Stage 2 therefore passes on "ran and observed", and reports `decisive` separately.
- All four expectation sources were `universal`; the model quoted nothing from the
  README. Not a format problem, but it limits how anchored these hypotheses are.
- `think:false` is the default on Ollama. It makes calls fast and fits the budgets;
  whether thinking would improve hypothesis quality is untested.

## Phase 4 status

Not run in this commit. The Grimoire task is a calibration case only. A new
independent task must be selected and the protocol frozen *before* either arm
runs; that is a separate step with its own commit.
