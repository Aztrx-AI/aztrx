# Pilot task selection (pre-registered before any model run)

Selected 2026-10-25, after implementation commit `1638443` and before any run
of either arm. The rule is `PROTOCOL.md` § Task selection rule.

| | |
|---|---|
| Application | `goniszewski/grimoire`, a SvelteKit bookmark manager (MIT, ~2.9k stars) |
| Buggy revision (given to both arms) | `b39fda259de166f73bce909c71d03dcc11148607` (v0.4.3) |
| Reference-fix revision (evaluator only) | `5e31e77aa5289d7a94cc95db5ff390d162ceb5e2` (merge of PR #157) |
| Why runnable | embedded SQLite (drizzle), Dockerfile + compose, signup on by default; no hosted DB, OAuth, payments or email |
| Independence | not written by us; not in `bench/` or `fixtures/` |

Bug description, diff and verifier steps are sealed outside the repo and
outside both arms' working directories.

## How it was picked, and what was rejected

Candidates came from `gh search repos` over MIT-licensed JS/TS apps in five
categories (bookmark manager, kanban, expense tracker, recipe manager, wiki
notes); I looked at the first only because it matched the rule, so this is a
convenience pick, not a sample. Merged PRs titled "fix" with at most 5 files were
listed, and the most recent one passing the filter was taken:

- #231, #216, #172, #166, #173, #193: release / Homebrew / CI / Docker, not browser-observable
- #220: dependency advisories
- #214, #215: AI-enrichment retry, needs an external LLM service
- #132: "Latest fixes", no single behavior
- **#157: taken**

## Disclosures

- The selector (this assistant) read the PR **title** while choosing. It did not
  read the body or diff, and the sealed files were written by redirection.
- The selector will know which PR was chosen while running the arms. Both arms'
  code, prompts and budgets were frozen in `1638443` and must not change.
- One task is an anecdote. See `PROTOCOL.md` § Claims we will not make.
