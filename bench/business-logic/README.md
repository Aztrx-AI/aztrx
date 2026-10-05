# AztrxBench business-logic v0

`bench/security/` scores access-control bugs (auth bypass, role escalation,
IDOR). This corpus scores a different, harder class: business-logic
invariants — "this action should only ever have an effect once," "this
state must be reached in order." Two cases, run with **zero new detection
code** on the first pass, specifically to diagnose *why* each one would
miss before writing anything.

## Method

Same shape as `bench/security/`: each case is a self-contained static app
with one seeded bug and a `manifest.json` recording ground truth
(`category`, `expected_invariant`, `known_exploit_path`, `expected_role`).
The runner serves `cases/`, drives the real `run()` with the full role
catalog, and matches findings to the manifest by substring. aztrx gets
nothing but the URL.

```bash
npm run build
npx tsx bench/business-logic/run.ts
npx tsx bench/business-logic/run.ts -- --seed 7
```

## The diagnosis pass (before any new code)

Both cases were run against the engine exactly as it stood after
`bench/security/` v0 — no new role, no new primitive. Both missed, 0/2,
zero findings of any kind. Tracing the actual action log for each (not
guessing) showed they miss for two *different* reasons:

- **`01-coupon-reuse`**: the repeat click already happens, for free, as a
  side effect of the swarm's normal operation — a fuzz/chaos-style role
  clicked "Apply coupon" **dozens of times** in one mission alone, well
  past what's needed to prove the bug. This is **not** a hypothesis gap;
  the exploit executes constantly. It's a pure **oracle gap**: nothing in
  the engine was ever watching a dollar figure on the page for a repeated
  delta. Crashes get caught; a benign, non-crashing state change doesn't
  exist as a signal anywhere.
- **`02-payment-bypass`**: traced the same way — across all 14 roles, only
  `index.html` and `pay.html` were ever requested. `confirmation.html`
  (deliberately unlinked from the DOM, reachable only by guessing a sibling
  filename) was never once requested. This **is** a hypothesis gap: no
  role attempts an unlinked-but-guessable next step in a flow.

This matters because it changes what "the fix" means. `01`'s gap is cheap
and general to close — add an oracle, the exploit is already happening.
`02`'s gap means inventing a wordlist-guessing behavior, which risks
becoming exactly the "flag anything vaguely plausible" scanner this
project is explicitly trying not to be. Fixed `01` this round; `02` stays
a documented, deferred gap (see RESULTS.md) rather than a rushed guess.

## Latest result

See [RESULTS.md](RESULTS.md).
