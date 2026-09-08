import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { render, Box, Text, useApp } from "ink";
import type { EventBus, HealEvent, ReproEvent, RunPhase } from "../core/eventBus.js";
import type { Finding, RecordedAction } from "../core/types.js";
import type { PatchHunk } from "../core/heal/types.js";
import { VERSION } from "../core/version.js";
import { diagnoseFinding } from "../core/diagnose.js";
import { diffHunks } from "../core/diff.js";

// Palette — mirrors web/app/globals.css "crash seismograph" tokens, mapped to
// the nearest ANSI colors so the terminal panel reads as the same instrument.
const C = {
  azure: "cyan",
  azureBright: "cyanBright",
  red: "red",
  green: "green",
  amber: "yellow",
  dim: "gray",
  muted: "white",
  fg: "white",
} as const;

const PHASE_LABEL: Record<RunPhase, { text: string; color: string }> = {
  launch: { text: "◉ launching browser…", color: C.azure },
  swarm: { text: "◉ swarm (parallel workers)…", color: C.azure },
  walk: { text: "◉ walking the DOM…", color: C.azure },
  fuzz: { text: "◉ fuzzing (chaos)…", color: C.azure },
  "http-fuzz": { text: "◉ fuzzing (HTTP mutations)…", color: C.azure },
  repro: { text: "◉ minimize → compile → validate…", color: C.azure },
  heal: { text: "◉ healing (redact → generate → gate → sandbox → verify)…", color: C.azure },
  done: { text: "✓ done", color: C.green },
};

// Actions that mutate app state — the ones that "count" toward ops/sec.
const EFFECTIVE = new Set<RecordedAction["type"]>(["click", "input", "select", "keypress", "request"]);

interface UiState {
  phase: RunPhase;
  actions: number;
  clicks: number;
  findings: Finding[];
  repros: Record<string, ReproEvent>;
  noise: number;
  routes: string[];
  navigations: number;
  done: boolean;
}

type Msg =
  | { type: "phase"; phase: RunPhase }
  | { type: "action"; action: RecordedAction }
  | { type: "finding"; finding: Finding }
  | { type: "noise" }
  | { type: "route"; url: string }
  | { type: "repro"; repro: ReproEvent }
  | { type: "heal"; heal: HealEvent };

function reducer(state: UiState, msg: Msg): UiState {
  switch (msg.type) {
    case "phase":
      return { ...state, phase: msg.phase, done: msg.phase === "done" };
    case "action":
      return {
        ...state,
        actions: state.actions + 1,
        clicks: state.clicks + (msg.action.type === "click" ? 1 : 0),
      };
    case "finding":
      return { ...state, findings: [...state.findings, msg.finding] };
    case "noise":
      return { ...state, noise: state.noise + 1 };
    case "route": {
      const last = state.routes[state.routes.length - 1];
      const next = last === msg.url ? state.routes : [...state.routes, msg.url];
      return { ...state, routes: next.slice(-7), navigations: state.navigations + 1 };
    }
    case "repro":
      return { ...state, repros: { ...state.repros, [msg.repro.finding.fingerprint]: msg.repro } };
    case "heal":
      return {
        ...state,
        findings: state.findings.map((f) =>
          f.fingerprint === msg.heal.finding.fingerprint ? msg.heal.finding : f
        ),
      };
    default:
      return state;
  }
}

const initialState: UiState = {
  phase: "launch",
  actions: 0,
  clicks: 0,
  findings: [],
  repros: {},
  noise: 0,
  routes: [],
  navigations: 0,
  done: false,
};

function useAztrx(bus: EventBus) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const effectiveTs = useRef<number[]>([]);
  const [now, setNow] = useState(0);

  useEffect(() => {
    const offs = [
      bus.on("phase", (p) => dispatch({ type: "phase", phase: p.phase })),
      bus.on("action", (a) => {
        dispatch({ type: "action", action: a });
        if (EFFECTIVE.has(a.type)) effectiveTs.current.push(a.timestamp);
      }),
      bus.on("finding", (f) => dispatch({ type: "finding", finding: f })),
      bus.on("noise", () => dispatch({ type: "noise" })),
      bus.on("route", (r) => dispatch({ type: "route", url: r.url })),
      bus.on("repro", (r) => dispatch({ type: "repro", repro: r })),
      bus.on("heal", (h) => dispatch({ type: "heal", heal: h })),
    ];
    return () => offs.forEach((off) => off());
  }, [bus]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  const rate = useMemo(() => {
    if (now === 0) return 0;
    const cutoff = now - 5000;
    effectiveTs.current = effectiveTs.current.filter((t) => t >= cutoff);
    return effectiveTs.current.length / 5;
  }, [now]);

  return { state, rate };
}

function firstLine(s: string): string {
  return s.split("\n")[0].slice(0, 68);
}

function SeverityMark({ severity }: { severity: Finding["severity"] }) {
  const color = severity === "warning" ? C.amber : C.red;
  const glyph = severity === "warning" ? "○" : "●";
  return (
    <Text color={color}>
      {glyph} {severity}
    </Text>
  );
}

function ReproBadge({ repro }: { repro: ReproEvent }) {
  const color = repro.verdict === "deterministic" ? C.green : repro.verdict === "flaky" ? C.amber : C.red;
  return (
    <Text color={color}>
      [{repro.verdict} {repro.reproductions}/{repro.runs}]
    </Text>
  );
}

function FindingRow({ finding, repro }: { finding: Finding; repro?: ReproEvent }) {
  const dx = diagnoseFinding(finding);
  return (
    <Box flexDirection="column">
      <Box>
        <SeverityMark severity={finding.severity} />
        <Text color={C.dim}>  </Text>
        <Text color={C.fg}>{firstLine(finding.rawMessage)}</Text>
      </Box>
      {finding.mappedLocation ? (
        <Text color={C.dim}>
          {"   "}
          {finding.mappedLocation.filePath}:{finding.mappedLocation.line}:{finding.mappedLocation.column}
        </Text>
      ) : null}
      {dx ? (
        <Text color={C.azure}>
          {"   ↳ "}
          {dx}
        </Text>
      ) : null}
      {repro ? (
        <Box>
          <Text color={C.dim}>{"   "}</Text>
          <ReproBadge repro={repro} />
          <Text color={C.dim}>
            {"  "}spec {repro.specPath} · {repro.steps}/{repro.totalSteps} steps
          </Text>
        </Box>
      ) : null}
      {finding.heal ? (
        <Box flexDirection="column">
          <Text color={finding.heal.status === "healed" ? C.green : C.amber}>
            {"   "}{finding.heal.status === "healed" ? "✓" : "◐"} {finding.heal.status}
            {finding.heal.model ? ` · ${finding.heal.model}` : ""}
          </Text>
          {finding.heal.status === "healed" && finding.heal.hunks.length > 0 ? (
            <DiffView hunks={finding.heal.hunks} filePath={finding.heal.filePath} />
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function DiffView({ hunks, filePath }: { hunks: PatchHunk[]; filePath: string }) {
  const groups = diffHunks(hunks);
  return (
    <Box flexDirection="column">
      <Text color={C.dim}>{"   "}{filePath}</Text>
      {groups.map((group, gi) => (
        <Box key={gi} flexDirection="column">
          {group.map((l, i) => (
            <Box key={i}>
              <Text color={l.type === "add" ? C.green : C.red}>{"     "}{l.type === "add" ? "+" : "-"} </Text>
              <Text>
                {l.tokens.map((t, j) => {
                  if (t.kind === "del") return <Text key={j} backgroundColor="red" color="white">{t.text}</Text>;
                  if (t.kind === "add") return <Text key={j} backgroundColor="green" color="black">{t.text}</Text>;
                  return <Text key={j} color={l.type === "add" ? C.green : C.red}>{t.text}</Text>;
                })}
              </Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

export interface AztrxAppProps {
  bus: EventBus;
  done: Promise<Finding[]>;
  targetUrl: string;
  repoRoot: string;
  mode: string;
}

function AztrxApp({ bus, done, targetUrl, repoRoot, mode }: AztrxAppProps) {
  const { exit } = useApp();
  const { state, rate } = useAztrx(bus);
  const [spin, setSpin] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setSpin((s) => (s + 1) % SPINNER.length), 80);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const finish = () => {
      if (!cancelled) setTimeout(() => exit(), 400);
    };
    done.then(finish, finish);
    return () => {
      cancelled = true;
    };
  }, [done, exit]);

  const phase = PHASE_LABEL[state.phase];
  const currentRoute = state.routes[state.routes.length - 1] ?? targetUrl;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={C.azure} bold>
          Aztrx AI
        </Text>
        <Text color={C.dim}> — Runtime Detector</Text>
        <Text color={C.dim}>   v{VERSION}</Text>
      </Box>
      <Text color={C.dim}>  target  {targetUrl}     repo  {repoRoot}</Text>
      <Text color={C.dim}>  mode    {mode}</Text>
      <Text color={C.dim}>──────────────────────────────────────────────</Text>

      <Box marginTop={1}>
        <Text color={phase.color}>
          {state.phase === "done" ? "✓" : SPINNER[spin]}  {phase.text.replace(/^[◉✓]\s*/, "")}
        </Text>
        <Text color={C.dim}>  </Text>
        <Text color={C.azureBright} bold>
          {rate.toFixed(1)}
        </Text>
        <Text color={C.dim}> ops/s · </Text>
        <Text color={C.fg}>{state.actions}</Text>
        <Text color={C.dim}> actions · </Text>
        <Text color={C.fg}>{state.clicks}</Text>
        <Text color={C.dim}> clicks</Text>
      </Box>

      <Box>
        <Text color={C.dim}>  route   </Text>
        <Text color={C.muted}>{currentRoute}</Text>
        <Text color={C.dim}> · {state.routes.length} route(s)</Text>
      </Box>

      {state.findings.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={C.muted} bold>
            findings ({state.findings.length})
          </Text>
          {state.findings.map((f) => (
            <FindingRow key={f.fingerprint} finding={f} repro={state.repros[f.fingerprint]} />
          ))}
        </Box>
      ) : null}

      {state.noise > 0 ? (
        <Text color={C.dim}>  ▸ {state.noise} noise event(s) suppressed</Text>
      ) : null}
    </Box>
  );
}

/** Mount the live terminal panel and resolve once the run (or a failure) ends. */
export function renderTui(props: AztrxAppProps): Promise<void> {
  const { waitUntilExit } = render(<AztrxApp {...props} />);
  return waitUntilExit();
}
