# Security benchmark results — AztrxBench security v0

**4 / 4 seeded bugs found · 100% recall · negative control silent**

Stable across seeds (`--seed 42` and `--seed 7` both score 4/4).

| metric | value |
| --- | --- |
| seeded bugs | 4 |
| found | 4 |
| recall | **100%** |
| false positives | 6 — all unrelated network noise, see below (was 1, before the catalog grew to 16 roles) |
| median mission time | ~27-29s |
| roles run | full catalog (16 roles), seed 42/7, `maxActions` 80 |

**Update:** the false-positive count rose from 1 to 6 as `repeat-use-auditor`
and `flow-skip-auditor` joined the catalog (`bench/business-logic/`). All
six are the same kind of noise as the original one — `flow-skip-auditor`'s
self-limiting `/sitemap.xml` probe 404ing on fixtures that don't have one,
logged as ambient `console_error` noise by the classifier. Neither new
primitive's own oracle has ever misfired on any case in this corpus.

## Per case

| # | case | category | found | expected role |
| --- | --- | --- | --- | --- |
| 01 | `auth-bypass` — premium route has no auth gate | auth_bypass | ✓ 1/1 | `paywall-bypass` |
| 02 | `role-escalation` — client-trusted JWT role claim | role_escalation | ✓ 1/1 | `token-tamper` |
| 03 | `idor` — object access has no ownership check (query id) | idor | ✓ 1/1 | `object-ref-auditor` |
| 04 | `idor-safe` — same shape as 03, ownership *is* checked | negative control | ✓ silent | `object-ref-auditor` |
| 05 | `idor-path` — same bug, path-shaped id (generalization) | idor | ✓ 1/1 | `object-ref-auditor` |

## What changed since the first baseline (2/3 → 4/4)

The first v0 baseline (2/3, see git history) found a real, scoped gap:
nothing in the engine swapped an object id and checked the response for an
ownership mismatch. Added a general primitive for it —
`objectRefAudit` in `src/core/security.ts`, role `object-ref-auditor` — not
tuned to this fixture's path or query shape specifically:

1. **Discovery**: numeric ids in a URL the page already touched (path
   segment or query value — an extension on the segment, like `184.html`,
   is handled).
2. **Sibling acquisition**: ±1 on that id. v1 scope, by design — UUIDs and
   slugs are a real, known gap this leaves open (see README).
3. **Oracle**: same session, sibling returns 200, the response actually
   differs, *and* it carries an identity-shaped signal (a JSON
   `owner`/`user`/`account`/`tenant`/`customer` field, or an email address in
   HTML) that differs from the original. All four, or silence — a bare
   "200 on a modified id" proves nothing by itself (plenty of ids are
   supposed to be publicly interchangeable).

Two things were added specifically to keep this primitive honest rather
than a pattern-matcher in disguise:

- **`04-idor-safe`** — the identical fixture, but the (bench-harness-only)
  test server enforces real ownership via a cookie check. The detector
  must stay silent here, or it's not proving ownership mismatches, it's
  just flagging "an endpoint with a number in it." It does stay silent —
  the one surfaced finding is unrelated network noise, not this detector
  (see below).
- **`05-idor-path`** — same bug class, id in a path segment instead of a
  query param (`/orders/184.html` → `/orders/185.html`), to check the
  primitive generalizes across both shapes rather than being written
  against one.

## A real bug this exposed, not a fixture bug

Building `05-idor-path` (the first fixture in this corpus with a *relative*
link into a subdirectory) surfaced a genuine, pre-existing memory-exhaustion
bug in `ssrKeyScan` and `paywallBypass`: both crawl a page's links without
ever navigating there, but were resolving each newly-discovered relative
href against the *previous queue entry* instead of the page's real,
unchanging URL. A relative link into a subdirectory (`orders/184.html`)
resolved against itself compounds — `orders/orders/184.html`, then
`orders/orders/orders/184.html` — forever, OOMing the process within
~40 seconds once enough crawler-style roles ran concurrently. Fixed by
resolving every href against the page's actual url, captured once, in both
functions (and a smaller instance of the same mistake in this corpus's own
new `objectRefAudit`). No existing fixture before `05` ever had a relative
link into a subdirectory, which is why this sat latent. Any real app with
directory-style routing (`/blog/post-1`, `/docs/intro`, etc.) has exactly
that shape — this was a real risk, not a benchmark artifact.

## What the one false positive actually is

`04-idor-safe`'s single flagged finding is `"Failed to load resource: ...
403 (Forbidden)"` — a different role's probe correctly got denied by the
ownership guard, and the page's own ambient network-error listener logged
it as a generic `warning`-severity finding. That's pre-existing classifier
behavior (any failed resource load becomes a finding) unrelated to
`objectRefAudit`, which never emits anything for this fixture. The claim
this case exists to test — *does the detector stay silent on a correctly
guarded app* — holds.

## What's still a known gap (by design, not oversight)

- UUID/slug-shaped ids (v1 only swaps numeric ones).
- Sibling guessing is ±1 only — no "borrow a real neighboring id seen
  elsewhere in the app's traffic," which the primitive will eventually need.
- Coupon-reuse and race/double-redemption still have no bench case — no
  business-invariant oracle exists for either yet.

## Rerun

```bash
npm run build && npx tsx bench/security/run.ts
```
