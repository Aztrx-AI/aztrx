# Invariant-discovery benchmark results

**13 / 13 cases pass · numeric threshold 5/5 · state transition 8/8 (1 of them an
honest `unknown`) · every rule read from the right source, at the right
`file:line` · 0 unexpected findings · empty diff → 0 candidates**

History: 2 / 2 (numeric threshold, served JS only) → 8 / 8 (git diff, repo
source, a second rule family) → 10 / 10 (successor-list tables, driven through a
`<select>`) → 13 / 13 (list pages of many entities, scoped to one). Cases 01–10 are
unchanged and still pass with the same verdicts.

| case | family | evidence (source @ location) | plan | verdict | time-to-proof |
| --- | --- | --- | --- | --- | --- |
| `01-free-shipping-boundary` | numeric | served_js @ `checkout.js:8` | numeric-boundary | **violated**, reproduced, at `boundary` only | ~2.4s |
| `02-free-shipping-safe` | numeric | served_js @ `checkout.js:8` | numeric-boundary | preserved | — |
| `03-diff-threshold-boundary` | numeric | **git_diff** @ `src/shipping.js:7` (changed via the constant on line 2) | numeric-boundary | **violated**, reproduced, at `boundary` only | ~2.5s |
| `04-diff-threshold-safe` | numeric | git_diff @ `src/shipping.js:7` | numeric-boundary | preserved | — |
| `05-diff-empty` | numeric | git_diff, **empty** | — | no candidate, no finding | — |
| `06-transition-diff-broken` | transition | **git_diff** @ `src/orderMachine.js:5` | state-transition | **violated**, reproduced, in `forbidden` only | ~8.5s |
| `07-transition-repo-safe` | transition | **repo_source** @ `src/orderMachine.js:5` | state-transition | preserved | — |
| `08-transition-diff-safe` | transition | git_diff @ `src/orderMachine.js:5` | state-transition | preserved | — |
| `09-successor-select-broken` | transition (successor list) | git_diff @ `src/jobs.js:6` | state-transition, intent *go to `done`* | **violated**, reproduced, in `forbidden` only | ~9.6s |
| `10-successor-select-safe` | transition (successor list) | git_diff @ `src/jobs.js:6` | state-transition | preserved | — |
| `11-entities-select-broken` | transition, 5 entities | git_diff @ `src/jobs.js:6` | state-transition, scoped | **violated**, reproduced, on `J-104` only | ~10s |
| `12-entities-select-safe` | transition, 5 entities | git_diff @ `src/jobs.js:6` | state-transition, scoped | preserved | — |
| `13-entities-no-identity` | transition, 5 entities | git_diff @ `src/jobs.js:6` | rule planned, **not bound** | **unknown** — `nothing inside them tells one from another` | — |

Per family: numeric — discovered 4, right source 4, planned 4, executed 4,
proven 2, cleared 2. Transition — discovered 8, right source 8, planned 8,
executed 7, proven 3, cleared 4, honest-unknown 1. (Case 05 is scored on
inferring *nothing*; case 13 on reading the rule and then *not* judging.)

What the list cases (11, 12) exercise: five rows in different states, three of
them `running`; each row has its own select; every successful move re-sorts the
list, so the row that was acted on changes position. The forbidden attempt goes
to the row already in the rule's state (`J-104`); the control moves a *different*
row (`J-102`/`J-101`). Before and after are read from the same entity (`flags.entity`
in the trace), and no other row is touched.

What the transition traces show (06): three rules come from the one changed
row (`cancelled` + `pay` / `cancel` / `fulfill`). Only `fulfill` is violated:
from `cancelled` the page goes to `fulfilled`, and the violation reproduces on
replay (a fresh session routes `pending → cancel → cancelled`, then `fulfill`
again). `pay` and `cancel` are refused. Each rule's *control* — the same action
in a state where the evidence says it is allowed — moved the page as declared
(`pending —pay→ paid`, `pending —cancel→ cancelled`, `paid —fulfill→ fulfilled`),
which is what lets "refused" be told apart from "button does nothing". A rule is
only called preserved when its control moved.

Ambient noise: 1 per case (the existing `/sitemap.xml` 404 probe), the same
class documented in the other corpora.

## Honest limits

- Fixtures are authored by us, and the repo source in a diff case is a
  *declaration of intent* kept beside a separate fixture server that plays the
  running app. A real project's source *is* the running app; we have not
  measured that.
- Eight cases, two rule shapes. Recall across shapes is unmeasured.
- Threshold rules are `if (x OP n) { y = k }` or the ternary form, with
  same-file constants. State rules are a literal table whose rows are either
  `action → state` or a list of states, and whose every target is itself a row.
  Enum members as keys or values (`[Status.New]: [Status.Queued]`), xstate-style
  configs, `switch` guards, `if (status === "cancelled") throw …`, and tables
  built at runtime are not read.
- "Forbidden" is read from *absence*: a move the table does not list from this
  state. That is a statement about the table, not a statement the author wrote
  about this transition. A successor list also yields many such rules (every
  unlisted pair); only the rows a diff touched are used, and the per-role cap
  is 6.
- Binding is by the evidence's own vocabulary and stops rather than guesses:
  a threshold rule needs one input and one readout named like its variables; a
  state rule needs exactly one element (or one `<select>`) showing one of the
  machine's states (optionally after `Label:`), and the page must expose at
  least two of the machine's moves — a control named like each action, or
  select options / controls named like the target states. An option that maps
  to two states, several selects, or a list of orders each with its own select
  stops at binding. A select that does not *offer* the forbidden move from the
  rule's state (a "smart" dropdown) leaves the rule `unknown`, not preserved:
  the UI never lets a user attempt it.
- Entity scoping is structural: the children of the lowest element that holds
  every state-bearing element, when they are the same tag holding mostly the
  same kinds of things (Jaccard ≥ 0.75 on the tags they contain, so an optional
  image does not make two cards different). The identity is the first value at
  the same place in every repetition that is unique across them: an `id`/`data-*`
  attribute, a link target, or a short leaf text, in that order. Values that merely
  number the repetitions (0,1,2… / 1,2,3…) are refused — they name a position, and
  a re-sort moves it. After an action the entity is re-found by identity and must
  still agree with at least one of its other identifying values; zero, several, or
  a disagreeing match is `unknown`, never "the row that is there now".
- A list page is scoped, not understood: which entity to act on is chosen for
  convenience (the one needing the least setup), and the experiment mutates it.
  On a real admin page that is a real order.
- An attempted move that raises a `confirm()` dialog has the dialog accepted;
  dismissing it would make a refused move and a declined confirmation look
  identical.
- Reaching a state uses only edges the evidence declares. A terminal state is
  left by starting a fresh session (clear cookies/storage, reload) — a
  fixture-friendly assumption; auth'd apps would lose their login.
- A state-transition run costs ~8s per rule (reach state, probe, control,
  replay), and the per-role cap is 6 candidates. A big table is truncated;
  rules read from changed code are ordered first so the change is never the
  part that is dropped.
- A diff chunk is the *whole current file* plus changed line numbers, so a
  rule counts as changed if its statement, a constant it resolves through, or
  its table row was touched. A change that alters behaviour through a
  different file is not seen.
- Untracked non-code files, deleted files, and renames-without-edits are not
  evidence. Only code files (`.js .jsx .ts .tsx .mjs .cjs`).
