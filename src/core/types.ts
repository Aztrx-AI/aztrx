export type Severity = "crash" | "error" | "warning" | "noise";

export type FindingType =
  | "uncaught_exception"
  | "unhandled_rejection"
  | "console_error"
  | "network_5xx"
  | "network_timeout";

export interface TelemetryErrorPayload {
  type: FindingType;
  rawMessage: string;
  rawStack: string;
  url?: string;
  line?: number;
  column?: number;
}

export type ActionType = "click" | "input" | "navigate";

export interface RecordedAction {
  type: ActionType;
  /** Selector cascade, most-reliable first: data-testid → text → css path. */
  selectors: string[];
  value?: string;
  timestamp: number;
  postState?: { url: string };
}

export interface MappedLocation {
  filePath: string;
  line: number;
  column: number;
  codeContext: string;
  isOwnCode: boolean;
}

export type ReproVerdict = "deterministic" | "flaky" | "unreliable";

export interface ReproReport {
  actions: RecordedAction[];
  specPath: string;
  verdict: ReproVerdict;
  rate: number;
  runs: number;
}

export interface Finding {
  id: string;
  fingerprint: string;
  occurrences: number;
  severity: Severity;
  type: FindingType;
  rawMessage: string;
  rawStack: string;
  mappedLocation?: MappedLocation;
  actionHistory: RecordedAction[];
  repro?: ReproReport;
}
