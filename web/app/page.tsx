import { CopyButton } from "./components/CopyButton";

const INSTALL = "npx aztrx run http://localhost:3000";

const CONFIG_SNIPPET = `// aztrx.config.ts
export default {
  url: "http://localhost:3000",
  maxActions: 100,
  allowHosts: ["api.yourapp.com"],
};`;

const TERMINAL = {
  banner: "⚡ Aztrx v0.1.0 — Runtime Detector",
  target: "Target: http://localhost:3000",
  mode: "Mode:   fuzz (seed 42)",
  crash: "Cannot read properties of undefined (reading 'items')",
  loc: "src/checkout.ts:41:9",
  spec: ".aztrx/repro/56f401d85ab4.spec.ts",
} as const;

const FRAMEWORKS = [
  "Next.js",
  "Vite",
  "React",
  "Svelte",
  "SvelteKit",
  "Vue",
  "Remix",
  "Astro",
];

const INVARIANTS = [
  {
    title: "Git worktree sandbox",
    body: "Healing patches apply to an isolated copy of your repo. Your dirty working tree is never touched — not now, not ever.",
  },
  {
    title: "Client-side redaction",
    body: "Secrets, tokens, emails and .env values are stripped before anything leaves your machine. Nothing ships that you didn't send.",
  },
  {
    title: "AST patch gates",
    body: "Generated fixes are rejected if they add dependencies, eval, child_process, or swallow errors into an empty catch.",
  },
  {
    title: "Deny-by-default network",
    body: "Fuzz runs block every host you haven't explicitly allow-listed. The hostile user stays inside your sandbox.",
  },
];

const STEPS = [
  {
    n: "01",
    tag: "detect",
    title: "Catch what the error boundary hides",
    body: "A CDP interceptor listens for uncaught exceptions, unhandled rejections, console errors and 5xx — including the ones a React Error Boundary swallows — then sourcemaps each to the exact line.",
  },
  {
    n: "02",
    tag: "reproduce",
    title: "Shrink it to the smallest failing step",
    body: "A seeded fuzzer walks your app clicking, typing garbage and racing the UI. When a crash is caught, delta debugging (ddmin) reduces the action sequence to a minimal repro.",
  },
  {
    n: "03",
    tag: "prove",
    title: "Prove it with an executable repro",
    body: "The repro compiles to a Playwright spec and re-runs against a flake-rate gate. You get 'deterministic' — a test you can run, not a log line you have to believe.",
  },
];

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-[12px] uppercase tracking-[0.22em] text-azure">
      {children}
    </p>
  );
}

function Terminal() {
  return (
    <div className="term-glow overflow-hidden rounded-xl border border-border bg-[#0d1016] text-left">
      <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-3">
        <span className="h-3 w-3 rounded-full bg-red/80" />
        <span className="h-3 w-3 rounded-full bg-amber/80" />
        <span className="h-3 w-3 rounded-full bg-green/80" />
        <span className="ml-3 font-mono text-xs text-dim">aztrx run</span>
      </div>
      <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-[1.7] text-fg">
        <span className="font-semibold text-azure">{TERMINAL.banner}</span>{"\n"}
        <span className="text-dim">{TERMINAL.target}</span>{"\n"}
        <span className="text-dim">{TERMINAL.mode}</span>{"\n\n"}
        <span className="text-red">● crash</span>
        <span className="font-semibold">  {TERMINAL.crash}</span>{"\n"}
        <span className="text-dim">   {TERMINAL.loc}</span>{"\n"}
        <span className="text-dim">     38 │   items.forEach((it) =&gt; addToCart(it))</span>{"\n"}
        <span className="text-dim">     39 │   renderTotal()</span>{"\n"}
        <span className="text-red">   &gt; 41 │   throw new Error(&quot;Cannot read properties of undefined (reading &#39;items&#39;)&quot;)</span>{"\n"}
        <span className="text-dim">     42 │ ){"}"}</span>{"\n\n"}
        <span className="text-azure">— Repro pipeline (minimize → compile → validate) —</span>{"\n"}
        <span className="text-green">  ✓ deterministic</span>
        <span className="text-fg">  {TERMINAL.crash}</span>
        <span className="text-dim">  (1/3 steps, 3/3 runs)</span>{"\n"}
        <span className="text-dim">        spec: {TERMINAL.spec}</span>{"\n\n"}
        <span className="text-dim">────────────────────────────────────────────</span>{"\n"}
        <span className="text-azure">1 unique finding(s)</span>{"\n"}
        <span className="text-dim">crash: 1   error: 0   warning: 0</span>{"\n\n"}
        <span className="text-azure">$ </span>
        <span className="cursor text-fg">▊</span>
      </pre>
    </div>
  );
}

export default function Home() {
  return (
    <div className="flex flex-1 flex-col bg-bg text-fg">
      {/* ── Nav ─────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b border-border/70 bg-bg/80 backdrop-blur">
        <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <a href="#" className="flex items-center gap-2 font-mono text-[15px] font-semibold tracking-tight text-fg">
            <span className="text-azure">⚡</span> aztrx
          </a>
          <div className="hidden items-center gap-8 font-mono text-[13px] text-muted md:flex">
            <a href="#how" className="transition-colors hover:text-fg">How it works</a>
            <a href="#security" className="transition-colors hover:text-fg">Security</a>
            <a href="#quickstart" className="transition-colors hover:text-fg">Quickstart</a>
            <a href="#pricing" className="transition-colors hover:text-fg">Pricing</a>
          </div>
          <a
            href="#install"
            className="rounded-md border border-azure/40 bg-azure/10 px-3.5 py-1.5 font-mono text-[13px] text-azure transition-colors hover:bg-azure/20"
          >
            npx aztrx
          </a>
        </nav>
      </header>

      {/* ── Hero ────────────────────────────────────────────── */}
      <section className="hero-grid relative overflow-hidden">
        <div className="mx-auto grid max-w-6xl gap-14 px-6 py-20 md:grid-cols-[1.05fr_1fr] md:items-center md:py-28">
          <div>
            <Eyebrow>runtime stress-tester · open core</Eyebrow>
            <h1 className="mt-5 text-balance text-[42px] font-semibold leading-[1.05] tracking-tight text-fg sm:text-6xl">
              Find the crash.
              <br />
              Prove it.{" "}
              <span className="text-azure">Ship the fix.</span>
            </h1>
            <p className="mt-6 max-w-lg text-lg leading-8 text-muted">
              Aztrx drives your web app like a hostile user — clicking, typing
              garbage, racing the UI — catches the errors your error boundary
              swallows, and compiles a minimal Playwright repro you can run to
              watch it break again. Deterministically.
            </p>

            <div id="install" className="mt-8 scroll-mt-24">
              <div className="flex max-w-lg items-center gap-2 rounded-lg border border-border bg-surface p-2 pl-4">
                <code className="flex-1 truncate font-mono text-[13.5px] text-fg">
                  <span className="text-dim">$ </span>
                  {INSTALL}
                </code>
                <CopyButton command={INSTALL} />
              </div>
              <p className="mt-3 font-mono text-xs text-dim">
                No framework hooks · React 17/18/19, Next.js, Vite, Svelte, Vue
              </p>
            </div>
          </div>

          <Terminal />
        </div>
      </section>

      {/* ── How it works ────────────────────────────────────── */}
      <section id="how" className="border-t border-border/70">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <Eyebrow>how it works</Eyebrow>
          <h2 className="mt-4 max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Three steps from <span className="text-azure">“it broke”</span> to{" "}
            <span className="text-green">“here's the proof”</span>
          </h2>
          <div className="mt-14 grid gap-6 md:grid-cols-3">
            {STEPS.map((s) => (
              <div
                key={s.n}
                className="rounded-xl border border-border bg-surface p-6 transition-colors hover:border-azure/40"
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-sm text-dim">{s.n}</span>
                  <span className="rounded-full border border-azure/30 bg-azure/10 px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-wider text-azure">
                    {s.tag}
                  </span>
                </div>
                <h3 className="mt-5 text-lg font-semibold text-fg">{s.title}</h3>
                <p className="mt-3 text-[15px] leading-7 text-muted">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Security invariants ─────────────────────────────── */}
      <section id="security" className="border-t border-border/70 bg-surface/40">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <Eyebrow>security invariants</Eyebrow>
          <h2 className="mt-4 max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Built so you can run it inside your repo without flinching
          </h2>
          <p className="mt-4 max-w-2xl text-muted">
            You're running an autonomous agent against private code. These are
            non-negotiables, not features.
          </p>
          <div className="mt-12 grid gap-6 sm:grid-cols-2">
            {INVARIANTS.map((i) => (
              <div
                key={i.title}
                className="flex gap-4 rounded-xl border border-border bg-bg p-6"
              >
                <span className="mt-0.5 font-mono text-azure">✓</span>
                <div>
                  <h3 className="font-semibold text-fg">{i.title}</h3>
                  <p className="mt-2 text-[15px] leading-7 text-muted">{i.body}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-8 font-mono text-sm text-dim">
            Human commits only. Aztrx never writes to your repo without confirmation.
          </p>
        </div>
      </section>

      {/* ── Quickstart ──────────────────────────────────────── */}
      <section id="quickstart" className="border-t border-border/70">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <Eyebrow>quickstart</Eyebrow>
          <h2 className="mt-4 max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Running in thirty seconds
          </h2>
          <div className="mt-12 grid gap-10 lg:grid-cols-[1.1fr_1fr]">
            <div className="overflow-hidden rounded-xl border border-border bg-surface-2">
              <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                <span className="h-3 w-3 rounded-full bg-red/80" />
                <span className="h-3 w-3 rounded-full bg-amber/80" />
                <span className="h-3 w-3 rounded-full bg-green/80" />
                <span className="ml-3 font-mono text-xs text-dim">shell</span>
              </div>
              <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-[1.8] text-fg">
                <span className="text-dim"># scaffold config + detect framework</span>{"\n"}
                <span className="text-azure">$</span> npx aztrx init{"\n"}
                <span className="text-dim"># detect + map errors (deterministic walk)</span>{"\n"}
                <span className="text-azure">$</span> npx aztrx run http://localhost:3000{"\n"}
                <span className="text-dim"># chaos fuzz + minimal deterministic repro</span>{"\n"}
                <span className="text-azure">$</span> npx aztrx run http://localhost:3000 --fuzz --repro{"\n"}
                <span className="text-dim"># live dashboard streaming findings</span>{"\n"}
                <span className="text-azure">$</span> npx aztrx studio{"\n\n"}
                <span className="text-green">→</span> <span className="text-dim">report: .aztrx/report.html</span>
              </pre>
            </div>
            <div className="space-y-8">
              <div>
                <h3 className="font-mono text-[13px] uppercase tracking-[0.18em] text-muted">
                  config
                </h3>
                <pre className="mt-3 overflow-x-auto rounded-xl border border-border bg-surface-2 p-5 font-mono text-[13px] leading-[1.8] text-fg">
                  {CONFIG_SNIPPET}
                </pre>
              </div>
              <div>
                <h3 className="font-mono text-[13px] uppercase tracking-[0.18em] text-muted">
                  works on
                </h3>
                <div className="mt-4 flex flex-wrap gap-2">
                  {FRAMEWORKS.map((f) => (
                    <span
                      key={f}
                      className="rounded-md border border-border bg-surface px-3 py-1.5 font-mono text-[12px] text-muted"
                    >
                      {f}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Pricing ─────────────────────────────────────────── */}
      <section id="pricing" className="border-t border-border/70 bg-surface/40">
        <div className="mx-auto max-w-6xl px-6 py-24">
          <Eyebrow>open core</Eyebrow>
          <h2 className="mt-4 max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Free to find bugs. Pay when it fixes them for you.
          </h2>
          <div className="mt-12 grid gap-6 md:grid-cols-2">
            <div className="rounded-xl border border-border bg-bg p-8">
              <div className="flex items-baseline justify-between">
                <h3 className="text-lg font-semibold">Core</h3>
                <span className="font-mono text-sm text-dim">Apache-2.0</span>
              </div>
              <p className="mt-4 text-4xl font-semibold tracking-tight">
                $0<span className="text-lg font-normal text-muted"> / forever</span>
              </p>
              <ul className="mt-6 space-y-3 text-[15px] text-muted">
                {[
                  "Detect, reproduce & prove crashes",
                  "Offline HTML report (.aztrx/report.html)",
                  "Local Studio live dashboard",
                  "Unlimited local runs",
                ].map((f) => (
                  <li key={f} className="flex gap-3">
                    <span className="text-green">✓</span> {f}
                  </li>
                ))}
              </ul>
              <a
                href="#install"
                className="mt-8 block rounded-md border border-border py-2.5 text-center font-semibold text-fg transition-colors hover:border-azure/50 hover:text-azure"
              >
                Start free
              </a>
            </div>

            <div className="relative rounded-xl border border-azure/40 bg-bg p-8">
              <span className="absolute -top-3 right-6 rounded-full bg-azure px-3 py-0.5 font-mono text-[11px] uppercase tracking-wider text-bg">
                coming soon
              </span>
              <div className="flex items-baseline justify-between">
                <h3 className="text-lg font-semibold">Pro</h3>
                <span className="font-mono text-sm text-dim">per developer</span>
              </div>
              <p className="mt-4 text-4xl font-semibold tracking-tight">
                $29<span className="text-lg font-normal text-muted"> / mo</span>
              </p>
              <ul className="mt-6 space-y-3 text-[15px] text-muted">
                {[
                  "Everything in Core",
                  "Closed-loop healing (AST-gated, sandboxed)",
                  "Cloud dashboard & team runs",
                  "CI orchestration",
                ].map((f) => (
                  <li key={f} className="flex gap-3">
                    <span className="text-azure">✓</span> {f}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                disabled
                className="mt-8 block w-full cursor-not-allowed rounded-md border border-azure/40 bg-azure/10 py-2.5 text-center font-semibold text-azure"
              >
                Join the waitlist
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────── */}
      <footer className="border-t border-border/70">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 px-6 py-10 sm:flex-row">
          <a href="#" className="font-mono text-[15px] font-semibold text-fg">
            <span className="text-azure">⚡</span> aztrx
          </a>
          <div className="flex gap-6 font-mono text-[13px] text-muted">
            <a href="#how" className="transition-colors hover:text-fg">Docs</a>
            <a href="#security" className="transition-colors hover:text-fg">Security</a>
            <a href="#pricing" className="transition-colors hover:text-fg">Pricing</a>
            <a href="#" className="transition-colors hover:text-fg">GitHub</a>
          </div>
          <p className="font-mono text-[13px] text-dim">© 2026 Aztrx</p>
        </div>
      </footer>
    </div>
  );
}
