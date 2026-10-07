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

---

# Generalization v1 — EasyBuy, rerun

Same checkout (`b8610cf`), same inputs (URL, repo, `--diff HEAD~1`), same
machine state (no Postgres, no `easybuy-server`). What changed is the engine:
it now reads successor-list tables, plans a control-agnostic *intent*, binds an
intent to a `<select>`, and classifies unreachable dependencies as environment.

| stage | v0 (before) | v1 (after) |
| --- | --- | --- |
| evidence_extracted | ✓ both changed files, 36 changed lines | ✓ same (7 served-JS chunks, ranked application-first, + 2 diff) |
| invariant_inferred | **✗ 0 rules — stopped here** | ✓ **8 rules** from the changed table (6 attempted, 2 over the per-mission budget). Rows `DELIVERED: []` and `CANCELLED: []` give the strongest ones (confidence 0.7) |
| experiment_planned | — | ✓ 6/6: "attempt a move to state X" with a control that vouches for it |
| runtime_bound | — | **✗ 6/6 — stopped here:** `nothing on the page shows one of the machine's states` |
| experiment_executed / observation_captured / verdict | — | not reached; every candidate is `unknown`, none is a finding |

The pipeline advanced two stages and then stopped at the next real thing: the
URL it was pointed at is not a page that shows an order. Two URLs were tried:
the storefront (`/`) and the admin orders page (`/dashboard/admin/orders`);
both stop identically. The admin page is where `OrderStatusSelect` lives, but
it needs a session and gets its orders from the `easybuy-server` API, which was
not running — so it renders no orders, and there is no state to read.

### Environment vs behavior

| | v0 | v1 |
| --- | --- | --- |
| findings reported | 5: four `ERR_CONNECTION_REFUSED` to `localhost:5000`, worded as a "hostile request takes the server down" | **0 of those.** The missing backend is recorded as `environment_failures` / `discovery_run.environment`: `http://localhost:5000 (net::ERR_CONNECTION_REFUSED) ×4`, one example URL, "not a finding" |
| still a finding | — | `HTTP 500 /api/auth/get-session` on the app's *own* origin. The dev log blames `Prisma schema mismatch` — an unmigrated database, which is this machine's setup, not the product. A browser cannot tell that from a product bug, so it stays a finding and is the limit of the environment classifier |

The rule: a connection-level failure (refused, unresolved, unreachable,
disconnected) to an origin *other than the app under test* is environment. The
app's own origin refusing connections is still the app being down, and a
dependency that answered badly or hung is still behavior.

### What the rerun says about the next bottleneck

`runtime_bound` is the new first failure. Three things stand between this repo
and a verdict, and the first two are about the *page*, not the rule:

1. **A page that shows one entity.** The admin dashboard is a list of orders,
   each with its own status select. A test confirms what aztrx does on that
   shape: with different states in the rows it refuses (`the page shows several
   of the machine's states at once`); with the same state in every row it still
   refuses (two selects are two entities). It never guesses which order a rule
   is about. Entity scoping — "this row" — does not exist yet.
2. **An authenticated session and a backend.** The page needs an admin login and
   `easybuy-server`; aztrx has `--login`/`--storage-state`, untried here.
3. **The UI may not be where the rule is enforced.** This upstream commit made
   the dropdown offer only valid next statuses. Aztrx's own select test shows the
   consequence: asked to attempt a move the select does not offer, it reports
   `not offered: the select offers no option for "X"` and the candidate is
   `unknown` — it can neither prove nor clear a rule the UI never lets a user
   attempt. The rule the table names is enforced by the API; testing it means
   sending the request, which is a different driver.

None of these were added or worked around for EasyBuy.

## Sanity check: what is not special-cased

- No identifier from EasyBuy (`order`, `status`, `PENDING`, …) appears in the
  engine. A test fails the build if discovery code names a product feature, and
  another asserts the planner never mentions a kind of control.
- Renamed-state tests (`q1…q4`) show successor-list inference and planning are
  structural.

---

# Entity Scoping v0 — EasyBuy, second rerun

Same checkout (`b8610cf`), same diff (`--diff HEAD~1`), same two URLs. What
changed in the engine: a page that repeats a structure is now scoped to one
repetition — its state, its controls, and the before/after reads all come from
the same entity, found again by identity after every action, or the result is
`unknown`.

## Stage by stage

| stage | previous rerun | this rerun |
| --- | --- | --- |
| evidence_extracted | ✓ 2 changed files, 36 lines | ✓ same |
| invariant_inferred | ✓ 8 rules (6 attempted, 2 over the per-mission cap) | ✓ same |
| experiment_planned | ✓ 6/6 | ✓ 6/6 |
| runtime_bound | ✗ 6/6 — nothing on the page shows one of the machine's states | **✗ 6/6 — unchanged**, on both URLs |
| experiment_executed / observation_captured / verdict | not reached | not reached; all `unknown`, none a finding |

**The external stop did not move, and the reason is now fully accounted for.**
Entity scoping never got a chance to run on the real page, because the real page
does not render orders in this environment:

1. `/dashboard/admin/orders` is a server component that calls `requireRole("admin")`
   — better-auth over Postgres. With no database the page crashes at the auth
   layer (`BetterAuthError: Prisma schema mismatch`, now visible in the run's
   findings) and shows an error boundary, not a list. The storefront (`/`) has
   no orders at all.
2. Even with a database, the list comes from `GET {API_URL}/api/admin/orders`,
   served by the separate `easybuy-server`. That server hard-wires the Neon
   serverless driver (`src/prisma.ts`: `new PrismaNeon({ connectionString })`),
   so it cannot run against a local Postgres without editing its source or
   shimming Neon's HTTP/WebSocket protocol. This was not done: the point is to
   test their software, not a patched copy.
3. I tried to bring up Postgres in Docker so at least sign-in would work.
   Docker Desktop would not start non-interactively on this machine (the process
   exits at launch; only the WSL service runs), so there was no daemon.

Nothing was faked and no verdict is claimed. The previous run's environment
note stands: the missing backend is recorded as `environment_failures`, not as a
finding; the one remaining finding (`HTTP 500 /api/auth/get-session`) is this
machine's missing database, which a browser cannot tell from a product bug.

## What the real markup says, by reading it (inspection, not measurement)

The admin page renders one card per order under a common container: a header
holding `Order #<id>` and the customer, the `OrderStatusSelect`, the total, then
the line items (with a product image only when the product has one). Nothing on
the card prints the status as text; **the select is the only state-bearing
element**, and its options are `[status, ...nextStatuses(status)]`; at a final
status it is `disabled`.

Reading it against the scoping rules found a real weakness, now fixed: "these
repetitions are alike" compared exact tag sets, so one card with a product image
and one without would have looked like different kinds of thing and the page
would have been refused. It now asks for mostly the same tags (Jaccard ≥ 0.75),
while a filter dropdown of states next to the cards is still rejected as
unlike. Both are tests.

Beyond that, scoping should find `Order #<id>` as the identity (a unique leaf
text at the same place in every card). That is a prediction.

## What *is* measured: the shape of that page, generically

A generic page built to the same pattern — cards with an optional image, a
header title as identity, a select offering only valid next states, disabled
at the final state — was run through the whole pipeline (test
`scoped: a list whose dropdowns only offer valid moves cannot be asked`). All
rules bind (`runtime_bound ✓`, `entity_scope: div ×4`), and **every one ends
`unknown` at `experiment_executed`**: `not offered: the select offers no option
for "…"` or `the select is disabled`. None is a finding, none is `preserved`.

## Is API-level verification now justified?

For this class of change — yes, and the evidence is specific:

- The upstream commit under test *is* a UI restriction: "only offer valid next
  statuses", final orders locked. Whatever the UI enforces, a UI-driven
  experiment can never attempt the forbidden move, so it can neither prove nor
  clear the rule. The test above shows aztrx saying exactly that, correctly,
  for every rule.
- The rule that matters is enforced elsewhere (`easybuy-server`), and a stale or
  missing check there is precisely the bug the UI restriction would hide.
- The means to attempt it is *in the diff*: the changed file contains the call
  the UI makes — `PATCH {API_URL}/api/admin/orders/{orderId}` with body
  `{ "status": <next> }` — so an API-level driver would not have to guess an
  endpoint; it could read one from the evidence, the way the rule itself is read.

Caveats: this rests on one external repository, and the UI-only result was
measured on a faithful generic page, not on the real admin page (which could
not be rendered). It justifies building the capability next; it does not
measure it. It would also need what this run lacked — a reachable backend and a
session — and mutates real data, which is a risk to name before it is a feature.

## Next bottleneck, in order

1. **A runnable target.** Here: Postgres for the client's auth, and a backend
   that can run off Neon. No change to aztrx fixes this; it is a precondition
   for any verdict on this repo.
2. **A session.** `--login` / `--storage-state` exist; untried on this app.
3. **An API-level driver**, seeded from the fetch call in the changed file,
   for rules the UI declines to let a user attempt.
