export type Severity = "crash" | "error" | "warning" | "noise";

export type FindingType =
  | "uncaught_exception"
  | "unhandled_rejection"
  | "console_error"
  | "network_5xx"
  | "network_timeout";

/** A server-side source location, e.g. a stack frame from a 500 response body. */
export interface ServerFrame {
  /** Raw path string as it appeared in the stack (file:// URL, POSIX, or Windows). */
  filePath: string;
  line: number;
  column: number;
}

/** Server-side error captured from a 500 response body by the HTTP fuzzer. */
export interface ServerErrorInfo {
  /** The server's own error message, best-effort extracted from the body. */
  message: string;
  /** Truncated response body. */
  body: string;
  /** Best-effort source location parsed from a stack trace in the body. */
  frame?: ServerFrame;
}

export interface TelemetryErrorPayload {
  type: FindingType;
  rawMessage: string;
  rawStack: string;
  url?: string;
  line?: number;
  column?: number;
  /** Server-side error context (F5-http). Present only for network findings. */
  serverError?: ServerErrorInfo;
}

export type ActionType =
  | "click"
  | "input"
  | "navigate"
  | "hover"
  | "keypress"
  | "select"
  | "scroll"
  | "request";

/** A raw HTTP request synthesized by the HTTP mutation fuzzer (F5-http). */
export interface HttpRequestAction {
  method: string;
  /** Absolute URL — matches the interceptor's `res.url()` so fingerprints line up. */
  url: string;
  headers?: Record<string, string>;
  /** Already-serialized body (JSON string, form-encoded, etc.). */
  body?: string;
}

export interface RecordedAction {
  type: ActionType;
  /** Selector cascade, most-reliable first: data-testid → text → css path. */
  selectors: string[];
  value?: string;
  timestamp: number;
  postState?: { url: string };
  /** Present when `type === "request"` — the hostile HTTP request to replay. */
  request?: HttpRequestAction;
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
  reproductions: number;
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
  /** Server's own error response, captured by `--http-fuzz` (message + body). */
  serverError?: { message: string; body: string };
  actionHistory: RecordedAction[];
  repro?: ReproReport;
  /** F10 closed-loop healing result, attached when `--heal` ran for this finding. */
  heal?: import("./heal/types.js").HealResult;
}
