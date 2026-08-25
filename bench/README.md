# Aztrx benchmark

> **The real-project corpus is the primary benchmark now.** See
> [`bench/frameworks/`](frameworks/) — 12 Next.js App Router targets scored by
> `bench/frameworks/run.ts`, with results in
> [`bench/frameworks/RESULTS.md`](frameworks/RESULTS.md). The vanilla corpus
> described below (`bench/cases/`) remains as the framework-agnostic archetype
> baseline.

A reproducibility harness that scores the runtime detector against a corpus of
self-contained apps, each with one seeded runtime crash.

## What it measures

**Detection rate** — of the seeded bugs, how many the engine surfaces as a
`crash`/`error` finding. The headline number is recall over the corpus;
`false positives` (findings matching no seeded bug) are reported separately.

## Method

Each case in `cases/` is a small app (`index.html` + `manifest.json`). The
manifest declares every seeded bug as a `message` substring (the exact runtime
error text) plus its trigger. The runner:

1. serves `cases/` over a local HTTP server,
2. drives the real `run()` (fuzz, seed 42) against each case,
3. matches findings to the manifest by `rawMessage` substring,
4. scores recall + false positives and writes `bench/.out/results.json`.

Bugs are seeded as *runtime* crashes (uncaught exceptions and unhandled
rejections) because that is what the detector targets — the category is
framework-agnostic by design: the engine captures `pageerror` /
`unhandledrejection` off the renderer, not framework internals. A real
Next.js/Vite corpus is the natural next step; these cases cover the *archetype*
matrix first.

## Run

```bash
npm run bench                 # detection only (fast)
npm run bench -- --repro      # also minimize → compile → validate each finding
npm run bench -- --seed 7     # different seed
```

## Latest result

See [RESULTS.md](RESULTS.md) — or run it yourself; the number is reproducible.
