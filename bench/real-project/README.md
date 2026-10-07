# Real Project Validation

The invariant-discovery bench (`bench/invariant-discovery`) is authored end to
end by us: the rule file, the page and the fake server that plays the running
app all come from one hand. This directory asks the harder question:

> Does aztrx still work when the software was not designed around aztrx?

```
real repo + real running app + live git diff
   → evidence → invariant → experiment → observation → verdict
```

Aztrx is given **a URL, a repo and `--diff`**. No rule, no invariant name, no
hint about what the change did.

## 1. A real framework app — `fixtures/orders-app`

A small Next.js 16 / React 19 app (App Router, server actions, per-session
cookies, in-memory store) whose source files *are* the running app: the
workflow table in `lib/workflow.ts` is the same table `lib/orders.ts` enforces
when a server action fires. `run.ts` makes a standalone git repository of it
(own `node_modules`, the shape a real checkout has), applies a patch as an
**uncommitted edit**, boots the real `next dev`, and runs aztrx.

| scenario | change | must produce |
| --- | --- | --- |
| `orders-clean` | none | no candidate, no finding |
| `orders-correct` | "customers can reopen a cancelled order" — adds a `reopen` action and a button | candidates from the changed row, **all preserved**, no finding |
| `orders-regressed` | the same feature, plus a "hot path" in `applyAction` that skips the table lookup for `complete` | exactly one **violated** rule (`cancelled` + `complete`), reproduced, no other finding |

The patches (`scenarios/*.patch`) are real `git diff` output. The regression is
a plausible performance shortcut, not a seeded string.

Run: `npm run bench:real` (or `tsx bench/real-project/run.ts orders-regressed`).
It needs `npm install` in `fixtures/orders-app` once.

**What this does and does not prove.** It proves the pipeline works against a
real framework runtime: a git repo, `next dev`, server actions, RSC updates,
cookies, a fresh-session reset. It does **not** prove the rule syntax
generalizes — the app was written after the engine's table format existed, in a
style the parser reads. That is what section 2 is for.

## 2. A repository we did not write

Any app, by hand — the CLI is the product:

```
node dist/cli.js run <url> --repo <path> --diff <base-ref> --telemetry
npx tsx bench/real-project/report.ts <path>      # where the pipeline stopped
```

`--diff <base-ref>` picks a *real upstream change*: check out a commit and
diff against its parent. `report.ts` prints, per run, the evidence found, the
number of rules inferred, and for every candidate the outcome of each stage:

```
evidence_extracted → invariant_inferred → runtime_bound →
experiment_planned → experiment_executed → observation_captured → verdict
```

The first stage that did not happen is `failed`; everything after it is
`skipped`. A run that infers nothing says so (`stopped at invariant_inferred`).
See `RESULTS.md` for the first external run, honestly.
