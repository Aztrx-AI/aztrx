# Real Project Validation — results (v0)

**Real framework app: 3 / 3. External repository: the pipeline stopped at
`invariant_inferred` — evidence found, no rule read.** The first number says the
integration works against real runtimes; the second says the rule-reading layer
does not yet generalize. Both are the point of this milestone.

## 1. Real framework app (`fixtures/orders-app`, Next.js 16, `next dev`)

Aztrx got a URL, the repo and `--diff`. Nothing else.

| scenario | evidence | rules inferred | result |
| --- | --- | --- | --- |
| `orders-clean` | git diff: empty | 0 | no candidate, no finding |
| `orders-correct` | git_diff `lib/workflow.ts:12` (changed row) | 3 (`cancelled` + `confirm` / `cancel` / `complete`) | all 3 **preserved**, no finding |
| `orders-regressed` | git_diff `lib/workflow.ts:12` | 3 | `cancelled` + `complete` **violated**, reproduced; the other two preserved; one finding |

The regression is a "hot path" in `lib/orders.ts` that skips the transition
table for `complete`. Aztrx reports the rule that was broken and where it was
stated (`lib/workflow.ts:12`); it does **not** point at the regressing line in
`lib/orders.ts` — it has no way to localize the cause, only the contradiction.

Every candidate passed every stage (`evidence_extracted ✓ invariant_inferred ✓
runtime_bound ✓ experiment_planned ✓ experiment_executed ✓ observation_captured
✓ verdict ✓`). The violated candidate's trace, as stored in the episode and in
the finding message:

```
git_diff lib/workflow.ts:12 (changed): cancelled: { reopen: "pending" }
rule: lib/workflow.ts declares TRANSITIONS: in "cancelled" the action "complete" has no transition, so it must not change the state
runtime: state_readout TRANSITIONS → strong "cancelled"; control confirm → button "Confirm" (exact name); control cancel → …; control complete → button "Complete" (exact name); control reopen → button "Reopen" (exact name)
experiment (state-transition): forbidden [complete], allowed-control [complete]
observed forbidden: {"state":"cancelled"} → {"state":"completed"} via complete = violated (reproduced)
observed allowed-control: {"state":"confirmed"} → {"state":"completed"} via confirm > complete = unknown   (a control: it moved, as declared)
verdict: violated
```

Runtime ~18–23s per scenario with a cold `next dev`; 6s for the empty diff.

Caveats, stated plainly:

- The app is **ours**, written after the table format the parser reads existed.
  It is a real framework runtime, not independent evidence of rule-syntax
  generalization.
- Its UI is the shape the driver handles: one element showing the state, one
  enabled button per action. A real admin UI usually isn't (see section 2).
- Served-JS evidence on a real bundled app is mostly framework chunks: 8 files
  (React DOM, Next client, devtools), up to 200 KB each, yielded 0 rules. The
  per-page cap of 8 scripts means an app's own client chunk can be crowded out
  by framework chunks.

## 2. External repository — `OmitHasanAdor/EasyBuy` (not authored by us)

A 2026 fashion marketplace: Next.js 16, Prisma/Postgres, better-auth, a
separate `easybuy-server` API. Chosen because it has a real order lifecycle and
a real upstream commit about exactly that: `b8610cf` (2026-09-17) *"fix(admin):
only offer valid next statuses in the order status dropdown"*. The commit was
checked out and diffed against its parent (`--diff HEAD~1`), so the change under
test is the upstream author's, not ours.

```
node dist/cli.js run http://localhost:3100/ --repo EasyBuy --diff HEAD~1 --telemetry
```

| stage | outcome |
| --- | --- |
| evidence_extracted | ✓ — found both changed files, `src/lib/orders.ts` (17 lines, the new table) and `OrderStatusSelect.tsx` (19 lines); 10 chunks in all (8 served JS, 2 diff) |
| invariant_inferred | **✗ — 0 rules.** Stopped here |
| runtime_bound … verdict | never reached |

Why it stopped, found by reading the table and the parser:

```ts
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ["SHIPPED", "CANCELLED"],   // state → list of allowed next STATES
  ...
```

The engine reads `state → { action: next }`. This table maps a state to a list
of *states*. The literal is parsed, the rows are lists, and the table is
correctly rejected — no rule, no guess. No parser was added for it.

That is the first failure. Reading the repo shows two more that would have
stopped it next, without any code being added to find them:

1. **The control is not a button per action.** The change is to
   `<select>` whose `<option>`s are *states* (`[status, ...nextStatuses(status)]`).
   The driver binds a state readout and one control per action; a dropdown of
   target states is a different control.
2. **The rule is enforced in another repository.** `orders.ts` says "Keep in
   sync with easybuy-server/src/lib/orders.ts"; the client only restricts what
   it offers. The admin page is behind login and reads orders from that API.

Also: the commit's behavior (the dropdown hides invalid moves) is a *UI
affordance* rule — "in state X only these options exist" — not the API
transition rule the table's name suggests. Aztrx would have had to decide which
of the two to test.

The app was run as far as it would go on this machine: `next dev` served the
storefront (HTTP 200) with a generated Prisma client and no database (Docker
was not running) and no `easybuy-server`. Because no rule was inferred, no
experiment ran and the admin pages were never reached; the runtime stages were
**not measured** on this repo. Aztrx's other roles' generic network check did
report five `ERR_CONNECTION_REFUSED` errors to `localhost:5000` — the missing
backend, correctly noticed, wrongly worded as a "hostile request" finding.

### How representative is this? A survey, not a measurement

To check that EasyBuy's shape is not an accident, 246 files matching common
transition-table names (`VALID_TRANSITIONS`, `ORDER_TRANSITIONS`, …) were fetched
from public repos and the first table-like declaration in each was classified
by the shape of its rows. Of the 107 classifiable:

| row shape | tables |
| --- | --- |
| `state → [next states]` | 100 (93%) |
| `state → { action: next }` (what the engine reads) | 7 (7%) |

The sample is biased by the search terms, the classifier is a regex, and 139
files were not classifiable. Treat it as direction, not a rate.

## What remains hardcoded

- Rule syntax: `if (x OP n) { y = k }`, the ternary form, and a literal
  `{ state: { action: "state" } }` table. Everything else — successor lists,
  enums as keys (`[Status.New]: …`), `switch` guards, `throw` guards,
  xstate configs — is rejected, not approximated.
- Binding vocabulary: elements whose text is a state name, controls named like
  the action, and (new) at least two of the machine's actions present as
  controls before a page is accepted as that machine.
- Controls: buttons and links. Not `<select>`, not menus, not drag-and-drop.
- Reaching a state uses only edges declared in the evidence; leaving a terminal
  state needs a fresh session (cookies/storage cleared).
- The finding names the broken rule and where it was stated, not the line that
  broke it.

## Biggest limitation

The engine can only reach as far as the first rule it can read, and on the one
independent repo it read none. The generalization gap is at inference — one
stage before anything about runtime binding could be tested on real UIs.
