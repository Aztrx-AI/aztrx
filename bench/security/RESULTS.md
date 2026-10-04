# Security benchmark results — AztrxBench security v0

**2 / 3 seeded bugs found · 66.7% recall · 0 false positives**

Stable across seeds (`--seed 42` and `--seed 7` both score 2/3, 0 fp).

| metric | value |
| --- | --- |
| seeded bugs | 3 |
| found | 2 |
| recall | **66.7%** |
| false positives | 0 |
| median mission time | ~28-30s |
| roles run | full catalog (13 roles), seed 42/7, `maxActions` 80 |

## Per case

| # | case | category | found | expected role | episode verdict |
| --- | --- | --- | --- | --- | --- |
| 01 | `auth-bypass` — premium route has no auth gate | auth_bypass | ✓ 1/1 | `paywall-bypass` | `verified_bug` |
| 02 | `role-escalation` — client-trusted JWT role claim | role_escalation | ✓ 1/1 | `token-tamper` | `verified_bug` |
| 03 | `idor` — object access has no ownership check | idor | ✗ 0/1 | — (none) | — |

## Reading the miss

`03-idor` is not a fixture bug — it's the benchmark doing its job. The
fixture has one clean seeded bug (`invoice.html?id=<N>` has no ownership
check against the logged-in session) and one clean exploit path (change
`?id=1` to `?id=2`). No role in the current catalog attempts that: the
walker only clicks links actually rendered in the DOM (no link to another
user's object exists to click), and `httpFuzzer.ts`'s id mutations
(`-1`, `0`, overflow) are tuned to provoke a 5xx, not to try a neighboring
*valid* id and inspect the 200 response for someone else's data. **IDOR
has no oracle in the engine today.** That is the one finding from this
whole v0 run worth acting on first.

## What this is not

This is detection recall only — no `--repro`/cost numbers, because no
`--heal` runs here (there's nothing to fix in a detect-only pass, and the
security findings in `01`/`02` are proof-or-silence already — they don't
go through the crash repro/heal pipeline at all). Time-to-proof and
cost-per-verified-bug, as originally scoped, need `--repro` wired through
`security.ts` findings first; not done in this v0.

## Rerun

```bash
npm run build && npx tsx bench/security/run.ts
```
