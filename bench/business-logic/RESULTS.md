# Business-logic benchmark results — AztrxBench business-logic v0

**3 / 4 addressable cases found, 1 deliberate permanent miss, 0 false
positives from either detector**

Stable across seeds (`--seed 42` and `--seed 7` both score the same way).

| # | case | result | role |
| --- | --- | --- | --- |
| 01 | `coupon-reuse` | **found** | `repeat-use-auditor` |
| 02 | `payment-bypass` (no evidence anywhere) | miss — permanent, by design | — |
| 03 | `flow-skip-page` (same bug as 02, WITH evidence) | **found** | `flow-skip-auditor` |
| 04 | `flow-skip-page-safe` (negative control) | **silent**, correctly | `flow-skip-auditor` |
| 05 | `flow-skip-resource` (resource shape) | **found** | `flow-skip-auditor` |

Every case produces exactly one `"Failed to load resource: ... 404"`
warning — `flow-skip-auditor`'s self-limiting `/sitemap.xml` probe 404ing
on fixtures that don't have one. Harmless ambient noise (the same
classifier behavior already documented in `bench/security/RESULTS.md`),
not a misfire of either detector — neither one's own oracle ever fires
incorrectly.

## Two gaps, two different fixes, on purpose

Both `01` and the `02`/`03` pair started as 0% baselines with zero new
code. Tracing actual engine behavior — not guessing — showed they were
different kinds of gap:

- **`01` (oracle gap)**: the repeated click already happens, for free, as
  a side effect of normal fuzz/chaos operation. Fixed generally:
  `repeatUseAudit` — marker-scoped discovery (apply/redeem/claim-labeled
  controls only, so ordinary repeatable actions are never candidates) +
  a click-twice, diff-the-dollar-figure oracle.
- **`02`/`03` (hypothesis gap)**: nothing ever requested the gated
  resource. The lazy fix (guess common filenames) was explicitly rejected
  — see `README.md` — in favor of **evidence-bounded discovery**:
  `flowSkipAudit` only tries a URL that's actually evidenced (a link found
  while crawling past the entry page, a quoted path string in a script,
  a sitemap entry), never a guess.

`02` keeps existing, unchanged, specifically as the boundary case: its
resource has zero evidence anywhere, and it must keep missing forever,
or `flowSkipAudit` has quietly become a filename guesser.

## The generalization check (`05`)

`03` and `05` are the same invariant — "a resource needs a prerequisite
step that it doesn't actually check for" — in two different shapes: a
multi-page checkout chain vs. a single evidenced resource link. One
primitive catches both, which is the signal this round was explicitly
checking for before treating `flowSkipAudit` as more than a one-off.

## What's still a known gap (by design)

- Evidence sources are runtime-only: links, script strings, sitemap. No
  source-code/router-config reading (`security.ts` primitives are
  black-box by design, same as everything else in this file).
- `02`'s shape (truly zero evidence, anywhere) is permanently out of
  scope for this primitive — intentionally.
- The crawl in `flowSkipAudit` actually navigates, unlike every other
  primitive in `security.ts` — bounded (`maxPages`), but worth watching
  if it's ever pointed at a much larger real app.

## Rerun

```bash
npm run build && npx tsx bench/business-logic/run.ts
```
