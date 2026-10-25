# Existing-suite baseline (before any Karnezz change)

Measured at HEAD `50d33d1`, 2026-10-25, before `src/` was touched.

| Check | Before | After the Karnezz change |
|---|---|---|
| `npm run typecheck` (root + server) | clean | clean |
| `npm test` | 342/342 | 355/355 (+13 new in `tests/hypothesis.test.ts`) |
| `bench:invariant` | 13/13 (numeric 5/5, transition 8/8, 0 unexpected) | 13/13, same breakdown |
| `bench` (crash detection) | 13/13, 2 false positives | not rerun: no code it exercises changed |
| `bench:security` | 4/4, 6 ambient noise | not rerun: same |
| `bench:business-logic` | 3/4; case 02 is the benchmark's own "deliberate miss" | not rerun: same |
| `bench:real` | 3/3 | not rerun: same |

The only edit to existing code is `src/core/llm.ts`: an optional token-usage
sink, and `max_completion_tokens` instead of `max_tokens`/`temperature` when the
base URL is `api.openai.com`. Behavior against every other endpoint is unchanged.
No benchmark baseline was altered.
