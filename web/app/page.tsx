"use client";

import { useRef, type ReactNode } from "react";
import { motion, useScroll, useTransform } from "framer-motion";
import { CopyButton } from "./components/CopyButton";

/* Cinematic spring — the one physics constant every reveal shares. */
const spring = { type: "spring" as const, stiffness: 70, damping: 20 };

const INSTALL = "npx aztrx-cli run http://localhost:3000";
const GITHUB = "https://github.com/DanisChaparov/aztrx";

/* ────────────────────────── primitives ────────────────────────── */

function Reveal({
  children,
  className = "",
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 40 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-100px" }}
      transition={{ ...spring, delay }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="font-mono text-xs uppercase tracking-[0.3em] text-zinc-300">{children}</p>
  );
}

/* ────────────────────────── icons (monochrome) ────────────────────────── */

type IconProps = { className?: string };

function Icon({ className = "h-5 w-5", children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

const Bolt = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="M13 2 4.5 13.5H11L9.5 22 19 10.5h-6.5L13 2Z" />
  </Icon>
);
const Minimize = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="M4 9h6V3" />
    <path d="M20 15h-6v6" />
    <path d="M14 4h4a2 2 0 0 1 2 2v4" />
    <path d="M10 20H6a2 2 0 0 1-2-2v-4" />
  </Icon>
);
const FileCode = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <path d="M14 2v6h6" />
    <path d="m9 13-2 2 2 2" />
    <path d="m15 13 2 2-2 2" />
  </Icon>
);
const Sparkles = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />
    <path d="M19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2Z" />
  </Icon>
);
const Shield = ({ className }: IconProps) => (
  <Icon className={className}>
    <path d="M12 3 5 6v6c0 4.2 3 6.9 7 9 4-2.1 7-4.8 7-9V6l-7-3Z" />
    <path d="m9 12 2 2 4-4" />
  </Icon>
);
const Cpu = ({ className }: IconProps) => (
  <Icon className={className}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <rect x="10" y="10" width="4" height="4" />
    <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
  </Icon>
);
const GitBranch = ({ className }: IconProps) => (
  <Icon className={className}>
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="9" r="2" />
    <path d="M6 7v10" />
    <path d="M18 9a9 9 0 0 1-9 9" />
  </Icon>
);
const GitHub = ({ className }: IconProps) => (
  <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
    <path d="M12 2C6.48 2 2 6.58 2 12.25c0 4.53 2.87 8.37 6.84 9.73.5.1.68-.22.68-.49v-1.7c-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.62.07-.62 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.36 1.12 2.94.86.09-.67.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.7 0 0 .84-.28 2.75 1.05a9.4 9.4 0 0 1 5 0c1.9-1.33 2.74-1.05 2.74-1.05.55 1.4.2 2.44.1 2.7.64.72 1.03 1.63 1.03 2.75 0 3.93-2.35 4.8-4.58 5.05.36.32.68.94.68 1.9v2.82c0 .27.18.6.69.49A10.04 10.04 0 0 0 22 12.25C22 6.58 17.52 2 12 2Z" />
  </svg>
);

/* ────────────────────────── header ────────────────────────── */

function Mark({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      {/* call stack — frames recede to silver; the slipped line carries the signal */}
      <path d="M8 12 H32" fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" opacity="0.6" />
      <path d="M14 22 H38" fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" opacity="0.6" />
      {/* the slipped line */}
      <path d="M30 32 H54" fill="none" stroke="currentColor" strokeWidth="5.5" strokeLinecap="round" />
      {/* the pinpoint */}
      <circle cx="57" cy="32" r="3.2" fill="currentColor" />
      <path d="M26 42 H50" fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" opacity="0.6" />
      <path d="M32 52 H56" fill="none" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" opacity="0.6" />
    </svg>
  );
}

function Header() {
  return (
    <header className="absolute inset-x-0 top-0 z-20 flex items-center justify-between px-8 py-6">
      <div className="flex items-center gap-2.5">
        <Mark />
        <span className="text-[15px] font-semibold tracking-tight text-white">
          Aztrx <span className="font-medium text-zinc-500">AI</span>
        </span>
      </div>
      <a
        href={GITHUB}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 font-mono text-xs text-zinc-300 transition-colors hover:border-white/25 hover:text-white"
      >
        <GitHub className="h-3.5 w-3.5" />
        GitHub
      </a>
    </header>
  );
}

/* ────────────────────────── 1 · hero ────────────────────────── */

function TerminalPill() {
  return (
    <div className="glass flex items-center gap-2 rounded-full py-3 pl-5 pr-3 shadow-[0_0_40px_-14px_rgba(255,255,255,0.32)]">
      <span className="select-none font-mono text-sm text-zinc-500">$</span>
      <span className="whitespace-nowrap font-mono text-sm text-zinc-200">{INSTALL}</span>
      <CopyButton command={INSTALL} />
    </div>
  );
}

function HeroDemo() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "center 0.7"],
  });
  const scale = useTransform(scrollYProgress, [0, 1], [0.95, 1]);
  const brightness = useTransform(scrollYProgress, [0, 1], ["brightness(0.55)", "brightness(1)"]);

  return (
    <motion.div
      ref={ref}
      style={{ scale, filter: brightness }}
      className="glass relative mt-24 aspect-[16/9] w-full max-w-5xl overflow-hidden rounded-2xl"
    >
      <video
        src="/hero-ad.mp4"
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        className="h-full w-full object-cover"
      />
    </motion.div>
  );
}

function Hero() {
  return (
    <section className="relative flex min-h-[100svh] flex-col items-center justify-center overflow-hidden px-6 pb-20 pt-36">
      <div className="hero-radial absolute inset-0 -z-10" />
      <div className="grid-lines absolute inset-0 -z-10" />

      <motion.p
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={spring}
        className="text-center font-mono text-xs uppercase tracking-[0.3em] text-zinc-500"
      >
        Autonomous runtime stress-testing
      </motion.p>

      <motion.h1
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...spring, delay: 0.08 }}
        className="hero-shimmer mt-8 text-center text-[clamp(3rem,9vw,7.5rem)] font-semibold leading-[0.95] tracking-[-0.04em]"
      >
        E2E tests are dead.
      </motion.h1>

      <motion.p
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...spring, delay: 0.16 }}
        className="mt-8 text-center text-xl text-zinc-400 sm:text-2xl"
      >
        Let AI break your app instead.
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 40 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...spring, delay: 0.24 }}
        className="mt-12"
      >
        <TerminalPill />
      </motion.div>

      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5, duration: 0.8 }}
        className="mt-6 font-mono text-xs text-zinc-600"
      >
        No config. No API key. Just point it at your dev server.
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 60 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...spring, delay: 0.32 }}
        className="w-full max-w-5xl"
      >
        <HeroDemo />
      </motion.div>
    </section>
  );
}

/* ────────────────────────── 2 · magic (bento) ────────────────────────── */

function BentoCard({
  children,
  className = "",
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 40 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ ...spring, delay }}
      className={`glass group relative overflow-hidden rounded-2xl p-8 transition-colors hover:border-white/20 ${className}`}
    >
      {children}
    </motion.div>
  );
}

function Magic() {
  return (
    <section className="px-6 py-32">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <Eyebrow>The magic</Eyebrow>
          <h2 className="mt-4 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
            One command. Four stages.
          </h2>
          <p className="mt-5 max-w-2xl text-lg text-zinc-400">
            Aztrx AI doesn&apos;t read logs — it drives your app like a hostile user, catches what
            your error boundary swallows, and hands you a proof, not a stack trace.
          </p>
        </Reveal>

        <div className="mt-16 grid grid-cols-1 gap-4 md:grid-cols-3">
          <BentoCard className="md:col-span-2" delay={0}>
            <div className="flex items-start justify-between gap-6">
              <div>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-zinc-300">
                  <Bolt />
                </div>
                <h3 className="mt-6 text-xl font-semibold text-white">Chaos Fuzzing</h3>
                <p className="mt-3 max-w-md text-zinc-400">
                  Drives your app over the Chrome DevTools Protocol — clicking, typing garbage, and
                  racing async UI faster than a human ever could.
                </p>
              </div>
              <div className="hidden shrink-0 flex-col items-end gap-2 sm:flex">
                <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 font-mono text-xs text-zinc-200">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-zinc-200" />
                  100 actions/s
                </div>
                <div className="flex items-end gap-1 pt-4">
                  {[38, 62, 44, 78, 55, 90, 70, 100, 84].map((h, i) => (
                    <span
                      key={i}
                      className="w-1.5 rounded-sm bg-gradient-to-t from-white/25 to-white/65"
                      style={{ height: `${h}%` }}
                    />
                  ))}
                </div>
              </div>
            </div>
          </BentoCard>

          <BentoCard delay={0.1}>
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-zinc-300">
              <Minimize />
            </div>
            <h3 className="mt-6 text-xl font-semibold text-white">ddmin algorithm</h3>
            <p className="mt-3 text-zinc-400">
              Shrinks a 50-step chaos trace down to the single step that actually breaks.
            </p>
          </BentoCard>

          <BentoCard delay={0.05}>
            <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-zinc-300">
              <FileCode />
            </div>
            <h3 className="mt-6 text-xl font-semibold text-white">Auto-Repro</h3>
            <p className="mt-3 text-zinc-400">
              Compiles every finding into a deterministic <span className="font-mono text-sm">.spec.ts</span>{" "}
              you can run to watch it break again.
            </p>
          </BentoCard>

          <BentoCard className="md:col-span-2" delay={0.1}>
            <div className="flex items-start justify-between gap-6">
              <div>
                <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-zinc-300">
                  <Sparkles />
                </div>
                <h3 className="mt-6 text-xl font-semibold text-white">Self-Healing</h3>
                <p className="mt-3 max-w-md text-zinc-400">
                  AI-verified patches via your own LLM — generated, redacted, and replayed in a
                  sandbox before you ever see a line of it.
                </p>
              </div>
              <div className="hidden shrink-0 flex-col gap-1 font-mono text-xs text-zinc-500 sm:flex">
                <span className="text-zinc-200">✓ gated</span>
                <span>✓ sandboxed</span>
                <span>✓ replayed</span>
              </div>
            </div>
          </BentoCard>
        </div>
      </div>
    </section>
  );
}

/* ────────────────────────── 3 · showcase (before/after) ────────────────────────── */

const lineContainer = {
  hidden: {},
  show: { transition: { staggerChildren: 0.07, delayChildren: 0.25 } },
};
const lineItem = {
  hidden: { opacity: 0, x: -12 },
  show: { opacity: 1, x: 0, transition: { duration: 0.4, ease: "easeOut" as const } },
};

const crashLines: { text: string; tone: "plain" | "red" | "dim" }[] = [
  { text: "TypeError: Cannot read properties of undefined (reading 'items')", tone: "red" },
  { text: "    at Checkout.renderTotal (checkout.ts:41:9)", tone: "dim" },
  { text: "    at Checkout.render (checkout.ts:28:12)", tone: "dim" },
  { text: "", tone: "plain" },
  { text: "  39 │  items.forEach(it => addToCart(it))", tone: "plain" },
  { text: "  40 │  renderTotal()", tone: "plain" },
  { text: "> 41 │  throw new TypeError('Cannot read properties of undefined')", tone: "red" },
  { text: "", tone: "plain" },
  { text: "1 crash · shrunk 50 → 1 step · repro: checkout.spec.ts", tone: "dim" },
];

const fixLines: { text: string; tone: "add" | "del" | "meta" | "pass" | "plain" }[] = [
  { text: "checkout.ts — self-healing patch", tone: "meta" },
  { text: "@@ -38,6 +38,7 @@", tone: "meta" },
  { text: "   renderTotal()", tone: "plain" },
  { text: "", tone: "plain" },
  { text: "-  items.forEach(it => addToCart(it))", tone: "del" },
  { text: "+  const items = this.props.items ?? [];", tone: "add" },
  { text: "+  items.forEach(it => addToCart(it))", tone: "add" },
  { text: "   renderTotal()", tone: "plain" },
  { text: "", tone: "plain" },
  { text: "✓ tsc: PASS", tone: "pass" },
  { text: "✓ replay: deterministic (3/3 reproductions)", tone: "pass" },
  { text: "✓ patch → .aztrx/patches/checkout.ts.patch", tone: "pass" },
];

function CodeLine({ text, tone, className }: { text: string; tone: string; className: string }) {
  return (
    <motion.div variants={lineItem} className={`${className} whitespace-pre font-mono text-[13px] leading-relaxed`}>
      {text || " "}
    </motion.div>
  );
}

function CodeShowcase() {
  return (
    <div className="glass-strong mt-16 overflow-hidden rounded-2xl">
      {/* chrome */}
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        <div className="ml-3 flex gap-1">
          <span className="rounded-md bg-white/5 px-3 py-1 font-mono text-xs text-red-300/90">
            crash — captured
          </span>
          <span className="rounded-md bg-white/5 px-3 py-1 font-mono text-xs text-emerald-300/90">
            patch — [tsc: PASS]
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2">
        <motion.div
          variants={lineContainer}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-140px" }}
          className="min-h-[320px] space-y-0.5 overflow-x-auto border-b border-white/10 bg-black/30 p-6 lg:border-b-0 lg:border-r"
        >
          {crashLines.map((l, i) => (
            <CodeLine
              key={i}
              text={l.text}
              tone={l.tone}
              className={
                l.tone === "red"
                  ? "text-red-400"
                  : l.tone === "dim"
                    ? "text-zinc-600"
                    : "text-zinc-400"
              }
            />
          ))}
        </motion.div>

        <motion.div
          variants={lineContainer}
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, margin: "-140px" }}
          className="min-h-[320px] space-y-0.5 overflow-x-auto bg-black/30 p-6"
        >
          {fixLines.map((l, i) => (
            <CodeLine
              key={i}
              text={l.text}
              tone={l.tone}
              className={
                l.tone === "add"
                  ? "text-emerald-400"
                  : l.tone === "del"
                    ? "text-red-400/70 line-through"
                    : l.tone === "pass"
                      ? "text-emerald-300"
                      : l.tone === "meta"
                        ? "text-zinc-600"
                        : "text-zinc-400"
              }
            />
          ))}
        </motion.div>
      </div>
    </div>
  );
}

function Showcase() {
  return (
    <section className="px-6 py-32">
      <div className="mx-auto max-w-6xl">
        <Reveal className="text-center">
          <Eyebrow>The proof</Eyebrow>
          <h2 className="mx-auto mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-white sm:text-5xl">
            From crash to fix, in one run.
          </h2>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-zinc-400">
            On the left, the crash your error boundary swallowed. On the right, the gated patch —
            replayed and type-checked before it reaches you.
          </p>
        </Reveal>
        <CodeShowcase />
      </div>
    </section>
  );
}

/* ────────────────────────── 4 · enterprise & trust ────────────────────────── */

const trustItems = [
  {
    icon: Shield,
    title: "100% Local Execution",
    body: "Runs inside your repo, against your code. Nothing leaves your machine unless you explicitly opt in.",
  },
  {
    icon: Cpu,
    title: "Bring Your Own Model",
    body: "Point healing at any Anthropic model — or keep it fully offline and never call an LLM at all.",
  },
  {
    icon: GitBranch,
    title: "CI/CD Native",
    body: "A GitHub Action gates every PR. Fail the build when a crash is proven, not guessed at.",
  },
];

function Trust() {
  return (
    <section className="px-6 py-32">
      <div className="mx-auto max-w-6xl">
        <Reveal>
          <Eyebrow>Enterprise &amp; trust</Eyebrow>
          <h2 className="mt-4 text-4xl font-semibold tracking-tight text-white sm:text-5xl">
            Built for teams that can&apos;t leak code.
          </h2>
        </Reveal>

        <div className="mt-16 grid grid-cols-1 gap-4 md:grid-cols-3">
          {trustItems.map((item, i) => (
            <motion.div
              key={item.title}
              initial={{ opacity: 0, y: 40 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, margin: "-80px" }}
              transition={{ ...spring, delay: i * 0.08 }}
              className="glass rounded-2xl p-8 transition-colors hover:border-white/20"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-zinc-300">
                <item.icon />
              </div>
              <h3 className="mt-6 text-lg font-semibold text-white">{item.title}</h3>
              <p className="mt-3 text-zinc-400">{item.body}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ────────────────────────── 5 · footer ────────────────────────── */

function Footer() {
  return (
    <footer className="px-6 pb-12 pt-32">
      <div className="mx-auto max-w-4xl text-center">
        <Reveal>
          <h2 className="text-[clamp(2.5rem,7vw,5rem)] font-semibold leading-none tracking-tight text-white">
            Ship fearlessly.
          </h2>
        </Reveal>

        <Reveal delay={0.1}>
          <a
            href={GITHUB}
            target="_blank"
            rel="noreferrer"
            className="cta-glow mt-12 inline-flex items-center gap-3 rounded-full border border-white/10 bg-white/5 px-8 py-4 font-mono text-sm text-white transition-all hover:scale-[1.03] hover:border-white/40"
          >
            <GitHub className="h-4 w-4" />
            View on GitHub
          </a>
        </Reveal>

        <Reveal delay={0.15}>
          <div className="mt-24 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm text-zinc-500">
            <a href={GITHUB} target="_blank" rel="noreferrer" className="transition-colors hover:text-white">
              GitHub
            </a>
            <a href="#" className="transition-colors hover:text-white">
              Documentation
            </a>
            <a href="#" className="transition-colors hover:text-white">
              Security
            </a>
            <a href="#" className="transition-colors hover:text-white">
              Changelog
            </a>
          </div>
        </Reveal>

        <Reveal delay={0.2}>
          <p className="mt-10 font-mono text-xs text-zinc-600">
            © 2026 Aztrx AI. Prove it found the bug.
          </p>
        </Reveal>
      </div>
    </footer>
  );
}

/* ────────────────────────── page ────────────────────────── */

export default function Home() {
  return (
    <main className="relative flex-1">
      <Header />
      <Hero />
      <Magic />
      <Showcase />
      <Trust />
      <Footer />
    </main>
  );
}
