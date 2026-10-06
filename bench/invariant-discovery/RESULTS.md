# Invariant-discovery benchmark results

**8 / 8 cases pass · numeric threshold 5/5 · state transition 3/3 · every rule
read from the right source, at the right `file:line` · 0 unexpected findings ·
empty diff → 0 candidates**

Before this milestone: 2 / 2 (numeric threshold, served JS only). Those two
cases (01, 02) are unchanged and still pass with the same verdicts.

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

Per family: numeric — discovered 4, right source 4, planned 4, executed 4,
proven 2, cleared 2. Transition — discovered 3, right source 3, planned 3,
executed 3, proven 1, cleared 2. (Case 05 is scored on inferring *nothing*.)

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
  same-file constants. State rules are a literal `{ state: { event: "next" } }`
  table whose targets are rows of the table. xstate-style configs, `switch`
  guards, `if (status === "cancelled") throw …`, and tables built at runtime
  are not read.
- "Forbidden" is read from *absence*: an event that exists elsewhere in the
  table but has no edge out of this state. That is a statement about the
  table, not a statement the author wrote about this transition.
- Binding is by the evidence's own vocabulary and stops rather than guesses:
  a threshold rule needs one input and one readout named like its variables; a
  state rule needs exactly one element showing one of the machine's states
  (optionally after `Label:`) and one control per event, named like the event.
  A page showing a list of orders, or icon-only buttons, stops at binding.
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
