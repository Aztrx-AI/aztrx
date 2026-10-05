# AztrxBench business-logic v0

`bench/security/` scores access-control bugs (auth bypass, role escalation,
IDOR). This corpus scores a different, harder class: business-logic
invariants — "this action should only ever have an effect once," "this
state must be reached in order." Every case here was run against the
engine with **zero new detection code first**, specifically to diagnose
*why* it would miss before writing anything.

## Method

Same shape as `bench/security/`: each case is a self-contained static app
with one seeded bug (or deliberately zero) and a `manifest.json` recording
ground truth (`category`, `expected_invariant`, `known_exploit_path`,
`expected_role`). The runner serves `cases/`, drives the real `run()` with
the full role catalog, and matches findings to the manifest by substring.
A `lock.json` next to a file (`{cookie, value, locked}`) lets a case
enforce a real server-side prerequisite check for its negative control —
this lives only in the bench harness, never in `security.ts`.

```bash
npm run build
npx tsx bench/business-logic/run.ts
npx tsx bench/business-logic/run.ts -- --seed 7
```

## Round 1: coupon reuse — an oracle gap

`01-coupon-reuse` missed with zero new code, but tracing the actual action
log showed the repeat click already happens constantly as a side effect of
normal swarm operation — not a hypothesis gap, a pure **oracle gap**.
Closed with `repeatUseAudit` (role `repeat-use-auditor`): click an
apply/redeem/claim-labeled control twice, require a `$` figure to change
on the first click and change again, differently, on the second.

## Round 2: payment bypass — a hypothesis gap, closed with evidence, not guessing

`02-payment-bypass` also missed with zero new code — tracing the url-visit
log showed its (deliberately unlinked) confirmation page was never once
requested across the full catalog. Closing this honestly does **not**
mean trying `confirmation.html`, `success.html`, `done.html`, ... against
every app — that degrades into exactly the "flag anything plausible"
pattern-matching this project is built to avoid.

Instead: **evidence generates the hypothesis, runtime generates the
proof.** `flowSkipAudit` (role `flow-skip-auditor`) builds a small
reachability graph by actually crawling (not just scanning the entry
page, like `paywallBypass` does) — links found while navigating, quoted
path-like string literals in inline and same-origin external `<script>`
text (`var confirmUrl = "/confirmation.html"`, `navigate("/next")`), and
`/sitemap.xml` if present. A candidate only counts if its evidence is
something other than a link on the entry page itself (content linked from
page one was never gated by anything). The oracle stays strict: fetch the
candidate under a session that never submitted anything, require the
protected-looking content to render with no gate/denial text.

Three cases prove this generalizes rather than being written against one
shape:

- **`02-payment-bypass`** stays a permanent, deliberate miss — no evidence
  exists for its confirmation page anywhere, which is the whole point:
  it marks the boundary this primitive refuses to cross.
- **`03-flow-skip-page`** — the same bug, WITH evidence (a script string
  in `pay.html`). Found.
- **`04-flow-skip-page-safe`** — identical evidence, but the confirmation
  page is actually gated (enforced via `lock.json`, since a client-side
  check alone can't be seen by a raw `fetch()`). Silent, as it must be.
- **`05-flow-skip-resource`** — the same bug, one hop instead of a
  multi-page checkout chain (`store.html` → evidenced `report-482.html`
  directly), to check the primitive isn't tuned to one flow shape. Found.

## Round 3: one shared invariant evaluator for all three bug classes

Five bug classes now exist across the two benches (auth bypass, role
escalation, IDOR, repeat-use, flow-prerequisite), and the surface area
looked different enough to risk becoming "fifty hand-written heuristics"
instead of one coherent capability. Checked whether they're actually the
same question in disguise: `src/core/invariant.ts` adds `ObservedState`
(only ever what a primitive directly observed — a cookie, a response
body, a rendered `$` figure, never guessed), `ExecutedAction`, and
`evaluateInvariant(spec, before, actions, after)` — one function that
turns a before/after pair into `preserved | violated | unknown`.

`objectRefAudit`, `repeatUseAudit`, and `flowSkipAudit` were retrofitted
to build an `ObservedState` before and after their own (unchanged)
exploit logic and call the shared evaluator instead of three separate
ad-hoc if-chains:

```
IDOR:        before={contentSignals: ownIds}         after={contentSignals: siblingIds}        → object-ownership
coupon reuse: before={money, flags:{used:true}}       after={money}                             → single-use
flow-skip:    before={flags:{prerequisiteCompleted:false}} after={http, flags:{gateHeld,...}}   → flow-prerequisite
```

**Milestone, stated plainly, and checked honestly rather than assumed:**
represent these three through one evaluator with no benchmark regression.
Confirmed — `bench/security` still 4/4, `bench/business-logic` still 3/4,
identical false-positive/ambient-noise profile on both, after the retrofit.

**What's actually shared vs. still specific, honestly:** discovery
(finding a sibling id, a single-use-labeled button, a flow's evidenced
urls) and the exploit action itself (swap the id, click twice, fetch
cold) remain — and should remain — entirely primitive-specific; that's
real, different work per bug class, not something to force into one
function. What's now shared is the **decision**: three different
scattered comparisons collapsed into one declarative `InvariantSpec` per
bug class plus one evaluator, instead of three separate verdict
computations. That's a real, if narrow, abstraction — not yet "Aztrx
infers invariants on its own," which stays future work (see
`src/core/invariant.ts`'s header for where this is meant to go next:
action-kind unification, then invariant *discovery* from code patterns/UI
language/API schema, is explicitly NOT done here).

## Latest result

See [RESULTS.md](RESULTS.md). Metrics now split `engineFindings` /
`benchmarkFalsePositives` / `ambientNoise` instead of one flat
"false positives" count — ambient infrastructure noise (a self-limiting
probe's own 403/404) no longer dilutes the signal that actually matters.
