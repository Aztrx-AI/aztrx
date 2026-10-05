# Business-logic benchmark results — AztrxBench business-logic v0

**1 / 2 found, 0 false positives — one capability shipped, one gap documented**

Stable across seeds (`--seed 42` and `--seed 7` both score 1/2, 0 fp).

| # | case | before (no new code) | after (`repeat-use-auditor` added) |
| --- | --- | --- | --- |
| 01 | `coupon-reuse` | miss (0 findings, oracle gap) | **found** — `Repeatable single-use action: "Apply coupon" has no single-use guard` |
| 02 | `payment-bypass` | miss (0 findings, hypothesis gap) | miss — deferred, see below |

## What shipped: `repeatUseAudit`

A general primitive (role `repeat-use-auditor`, `src/core/security.ts`),
same shape as the access-control primitives:

1. **Discovery**: a clickable control whose own label matches
   apply/redeem/activate/claim/promo/coupon/voucher/discount-code/gift-card
   — narrows *what* to test, same reasoning `paywallBypass` uses for
   premium-marker links. A correctly-repeatable control (add-to-cart, like)
   is never a candidate in the first place.
2. **Action**: click it, snapshot every `$` figure on the page, click it
   again (same session), snapshot again.
3. **Oracle**: the first click must visibly change a dollar figure, AND
   the second click must change it again, differently. A properly-guarded
   action shows a change once, then nothing — that's silence, not a
   finding. Both-or-neither isn't enough; it has to be "changed, then
   changed again."

New `FindingType`: `business_logic_violation` — `secret_leak` was being
reused by three unrelated primitives already (paywall bypass, role
escalation, IDOR) as the de facto "proven exploit, not a crash" bucket;
gave this class its own name instead of adding a fourth squatter.

## Why `01` was fixable in one general step and `02` wasn't (yet)

Tracing actual engine behavior — not guessing — before writing any code
showed the two misses have different root causes:

- **`01`**: the repeated click already happens constantly as a side effect
  of normal swarm operation (a chaos/fuzz-style role clicked "Apply
  coupon" dozens of times in a single mission, confirmed via the action
  log). The gap was purely that nothing watched for the effect — an
  **oracle gap**, cheap to close generally.
- **`02`**: across the full 14-role catalog, `confirmation.html` (reachable
  only by guessing a sibling filename of `pay.html`, deliberately unlinked
  from the DOM) was **never once requested** — confirmed via the actual
  url-visit log, not inferred. This is a **hypothesis gap**: no behavior
  in the catalog attempts an unlinked-but-guessable next step in a flow.

Closing `02` properly means a wordlist/sibling-guessing behavior for
"flow steps," which is a fundamentally riskier kind of primitive than
anything built so far — every other primitive in this project only acts on
evidence the app already handed it (a link, a stored token, an id it used).
Guessing filenames (`confirm`, `success`, `done`, `thank-you`, ...) without
that discipline is exactly the "flag anything plausible" pattern this
project is built to avoid. Left as a documented, deliberately deferred gap
rather than rushed.

## Rerun

```bash
npm run build && npx tsx bench/business-logic/run.ts
```
