# Invariant-discovery benchmark results — v0

**2 / 2 cases pass · rule discovered 2/2 · experiment executed 2/2 · violation
proven 1/1 · negative control silent · 0 unexpected findings**

| case | discovered | executed | verdict | violating state | time-to-proof |
| --- | --- | --- | --- | --- | --- |
| `01-free-shipping-boundary` | yes (conf 0.7, source `code`, `checkout.js:8`) | yes (4 states + 1 replay) | **violated**, reproduced | `boundary` (total=50 → shipping 5.99) | ~2.5s |
| `02-free-shipping-safe` | yes (conf 0.7) | yes (4 states) | **preserved** | — | — |

Per-state observations, case 01: `below` 49 → 5.99 (control, rule doesn't
apply) · `boundary` 50 → 5.99 **violated** · `just-above` 51 → 0 · `clearly-above`
100 → 0. Only the boundary state contradicts the rule, which is the point: a
single "large total" probe would have passed this app.

Ambient noise: 1 per case (the existing `/sitemap.xml` 404 probe), the same
class documented in the other corpora.

## Honest limits

- Two cases, one rule shape (numeric threshold ⇒ constant). It proves the chain
  end to end; it says nothing about recall across rule shapes.
- Evidence comes from served JS only. Repo source files and live `git diff`
  are not wired in (the diff extractor exists and is unit-tested).
- Binding is by identifier name to one numeric input and one numeric readout.
  A rule whose variable isn't a control on the page stops at `binding`.
- Both fixtures are authored by us; the evidence/runtime split (client code
  states the rule, server drifts) is a constructed scenario.
