import type { Finding, RecordedAction, ReproVerdict, TelemetryErrorPayload } from "./types.js";

export type RunPhase = "launch" | "walk" | "fuzz" | "repro" | "done";

export interface PhaseEvent {
  phase: RunPhase;
  detail?: string;
  ts: number;
}

export interface RouteEvent {
  url: string;
  ts: number;
}

export interface ReproEvent {
  finding: Finding;
  verdict: ReproVerdict;
  runs: number;
  reproductions: number;
  steps: number;
  totalSteps: number;
  /** Repo-relative path to the compiled Playwright spec. */
  specPath: string;
}

export interface AztrxEvents {
  telemetry: TelemetryErrorPayload;
  action: RecordedAction;
  finding: Finding;
  repro: ReproEvent;
  phase: PhaseEvent;
  route: RouteEvent;
  noise: { ts: number };
}

type Handler<T> = (payload: T) => void;

/**
 * Minimal typed event bus — the single backbone the modules communicate over,
 * so the Orchestrator can be swapped for a cloud sink later without touching
 * any module (hexagonal, per PRD §2.2).
 */
export class EventBus {
  private handlers = new Map<keyof AztrxEvents, Set<Function>>();

  on<K extends keyof AztrxEvents>(event: K, handler: Handler<AztrxEvents[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  emit<K extends keyof AztrxEvents>(event: K, payload: AztrxEvents[K]): void {
    this.handlers.get(event)?.forEach((h) => (h as Handler<unknown>)(payload));
  }
}
