# Aztrx — runtime stress-tester for web apps

Finds the bug, then **proves it with an executable repro**.

Aztrx drives your app like a hostile user — clicking, typing garbage, racing the
UI — catches runtime errors (including the ones a React Error Boundary
swallows), maps each crash to the exact source line, and compiles a minimal
Playwright repro you can run to watch the bug happen again.

No framework hooks: works on React (17/18/19), Next.js, Vite, Svelte, Remix,
and Vue alike.

## Install

```bash
npm install
npx playwright install chromium
npm run build
```

## Run

```bash
# detector — deterministic walk, catch + map errors
node dist/cli.js http://localhost:3000 --repo ..

# chaos fuzz — seeded random walk with garbage inputs
node dist/cli.js http://localhost:3000 --repo .. --fuzz

# repro — minimize → compile → validate each crash (the differentiated half)
node dist/cli.js http://localhost:3000 --repo .. --repro

# everything at once
node dist/cli.js http://localhost:3000 --repo .. --fuzz --repro
```

## Smoke test (no dev server)

```bash
node fixtures/serve.mjs &
node dist/cli.js http://localhost:8901/crash.html --repo fixtures --repro
```

Expected: one `● crash` mapped to `crash.html:13:15`, minimized to 1 step, and a
deterministic `.aztrx/repro/*.spec.ts` written out.

## Flags

| Flag | Purpose |
|---|---|
| `--repo <path>` | repo root for sourcemap → source resolution |
| `--max-actions <n>` | max actions per pass (default 100) |
| `--fuzz` | chaos fuzzing instead of the deterministic walk (F5) |
| `--seed <n>` | RNG seed for fuzz (default 42) |
| `--repro` | minimize + compile + validate each finding (F7–F9) |
| `--repro-runs <n>` | replay iterations for the flake-rate gate (default 3) |
| `--allow-host <host>` | add a host to the network allow-list (repeatable) |
| `--dry-run` | report what would be clicked, click nothing |
| `--crash-test` | throw a deliberate error to verify capture |
| `--fail-on` | exit 1 if any crash/error finding |

## How it works

`src/core/` — modules talk only through the `EventBus`; the `Orchestrator` wires
them (hexagonal, so a cloud sink can replace the CLI later):

- `interceptor.ts` (F1) — CDP capture → typed `telemetry` events. Pulls real
  stacks off Error objects via `console.error`, so Error-Boundary-swallowed
  errors are caught.
- `recorder.ts` (F2) — 25-action ring buffer + selector cascade
  (`data-testid` → text → CSS path).
- `classifier.ts` (F3) — fingerprint dedup, severity, baseline.
- `resolver.ts` (F4) — sourcemap → source line + snippet.
- `domWalker.ts` (F5-lite) — deterministic walk + destructive deny-list.
- `fuzzer.ts` (F5) — seeded chaos: random clicks, garbage input, double-clicks.
- `networkGuard.ts` (F6) — deny-by-default network allow-list.
- `minimizer.ts` (F7) — ddmin shrinks the failing sequence to a minimal repro.
- `specCompiler.ts` (F8) — emits an executable Playwright `.spec.ts`.
- `validator.ts` (F9) — flake-rate gate (deterministic / flaky / unreliable).

## Output

Repros land in `.aztrx/repro/<id>.spec.ts`; the baseline of already-known
fingerprints lives in `.aztrx/baseline.json`. Both are gitignored.
