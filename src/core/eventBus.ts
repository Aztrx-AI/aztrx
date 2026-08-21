import type { Finding, RecordedAction, TelemetryErrorPayload } from "./types.js";

export interface SeismEvents {
  telemetry: TelemetryErrorPayload;
  action: RecordedAction;
  finding: Finding;
}

type Handler<T> = (payload: T) => void;

/**
 * Minimal typed event bus — the single backbone the modules communicate over,
 * so the Orchestrator can be swapped for a cloud sink later without touching
 * any module (hexagonal, per PRD §2.2).
 */
export class EventBus {
  private handlers = new Map<keyof SeismEvents, Set<Function>>();

  on<K extends keyof SeismEvents>(event: K, handler: Handler<SeismEvents[K]>): () => void {
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

  emit<K extends keyof SeismEvents>(event: K, payload: SeismEvents[K]): void {
    this.handlers.get(event)?.forEach((h) => (h as Handler<unknown>)(payload));
  }
}
