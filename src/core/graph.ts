/**
 * State-Graph — the Mapper's model of the application as a finite state
 * machine. Every node is a full state snapshot (URL + localStorage + cookies
 * + DOM markers), every edge is the action that moves between two states.
 * A min-heap PriorityQueue drives the exploration like A*: states that smell
 * of business risk (login, checkout, admin, pay, token, auth) get a lower
 * weight and are processed first.
 */

export interface StateSnapshot {
  url: string;
  /** Full localStorage content — values live in memory only, never in reports. */
  localStorage: Record<string, string>;
  /** Cookie name/value pairs from the browser context. */
  cookies: Array<{ name: string; value: string }>;
  /** Risk markers seen in the DOM (button/link labels and key page text). */
  domMarkers: string[];
}

export type EdgeActionType = "click" | "submit" | "navigate" | "input";

export interface EdgeAction {
  type: EdgeActionType;
  /** Human-readable form: `click "Login"`. */
  label: string;
  /** Selector cascade for replay, most-reliable first. */
  selectors: string[];
  value?: string;
}

/** Business-risk words that pull a state to the front of the queue. */
export const RISK_KEYWORDS = ["login", "checkout", "admin", "pay", "token", "auth", "delete"];

/** How many risk keywords a text contains. */
export function riskWeight(text: string): number {
  const t = text.toLowerCase();
  return RISK_KEYWORDS.filter((k) => t.includes(k)).length;
}

/**
 * Heuristic weight of a state: riskier = lower number = earlier in the queue.
 * Base 10, −3 per risk keyword hit (in the URL or the DOM markers), floor 1.
 */
export function stateWeight(snapshot: StateSnapshot): number {
  const hits =
    riskWeight(snapshot.url) +
    snapshot.domMarkers.reduce((sum, m) => sum + riskWeight(m), 0);
  return Math.max(1, 10 - hits * 3);
}

/** One directed transition: an action that moved `from` into `to`. */
export class StateEdge {
  constructor(
    readonly from: StateNode,
    readonly to: StateNode,
    readonly action: EdgeAction
  ) {}
}

export class StateNode {
  /** Stable id — the state's signature (see `signatureOf`). */
  readonly id: string;
  readonly snapshot: StateSnapshot;
  /** The heuristic weight — smaller is explored sooner. */
  readonly weight: number;
  edgesOut: StateEdge[] = [];

  constructor(id: string, snapshot: StateSnapshot) {
    this.id = id;
    this.snapshot = snapshot;
    this.weight = stateWeight(snapshot);
  }
}

/** A min-heap priority queue: `pop()` returns the entry with the smallest
 * weight. Ties break by insertion order (stable). */
export class PriorityQueue<T> {
  private heap: Array<{ item: T; weight: number; seq: number }> = [];
  private seq = 0;

  get size(): number {
    return this.heap.length;
  }

  push(item: T, weight: number): void {
    this.heap.push({ item, weight, seq: this.seq++ });
    let i = this.heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!less(this.heap[i], this.heap[parent])) break;
      [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]];
      i = parent;
    }
  }

  pop(): { item: T; weight: number } | null {
    if (this.heap.length === 0) return null;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < this.heap.length && less(this.heap[l], this.heap[smallest])) smallest = l;
        if (r < this.heap.length && less(this.heap[r], this.heap[smallest])) smallest = r;
        if (smallest === i) break;
        [this.heap[i], this.heap[smallest]] = [this.heap[smallest], this.heap[i]];
        i = smallest;
      }
    }
    return { item: top.item, weight: top.weight };
  }

  peek(): { item: T; weight: number } | null {
    if (this.heap.length === 0) return null;
    const top = this.heap[0];
    return { item: top.item, weight: top.weight };
  }
}

function less(a: { weight: number; seq: number }, b: { weight: number; seq: number }): boolean {
  return a.weight !== b.weight ? a.weight < b.weight : a.seq < b.seq;
}

/** The state's identity: URL + localStorage KEYS + cookie names + markers.
 * Keys, not values — a re-issued token with the same shape is the same state,
 * while a token APPEARING where none existed is a new one. */
export function signatureOf(snapshot: StateSnapshot): string {
  const lsKeys = Object.keys(snapshot.localStorage).sort().join(",");
  const cookieNames = snapshot.cookies.map((c) => c.name).sort().join(",");
  const markers = [...snapshot.domMarkers].sort().join(",");
  return `${snapshot.url}|${lsKeys}|${cookieNames}|${markers}`;
}

export class StateGraph {
  private nodes = new Map<string, StateNode>();
  private edges: StateEdge[] = [];
  private rootId: string | null = null;

  /** Add a state (dedup by signature) and return the node — the existing one
   * when this exact state was already seen. */
  addState(snapshot: StateSnapshot): StateNode {
    const id = signatureOf(snapshot);
    const existing = this.nodes.get(id);
    if (existing) return existing;
    const node = new StateNode(id, snapshot);
    this.nodes.set(id, node);
    if (this.rootId === null) this.rootId = id;
    return node;
  }

  addEdge(from: StateNode, to: StateNode, action: EdgeAction): StateEdge {
    const edge = new StateEdge(from, to, action);
    this.edges.push(edge);
    from.edgesOut.push(edge);
    return edge;
  }

  get size(): number {
    return this.nodes.size;
  }

  get root(): StateNode | null {
    return this.rootId ? (this.nodes.get(this.rootId) ?? null) : null;
  }

  /** The node that matches a snapshot (by signature), or null. */
  getNode(snapshot: StateSnapshot): StateNode | null {
    return this.nodes.get(signatureOf(snapshot)) ?? null;
  }

  getEdgeCount(): number {
    return this.edges.length;
  }

  /** The chain of actions from the root to `node` — the Kill Chain. */
  pathTo(node: StateNode): StateEdge[] {
    const path: StateEdge[] = [];
    const seen = new Set<string>();
    const walk = (current: StateNode): boolean => {
      if (current.id === node.id) return true;
      if (seen.has(current.id)) return false;
      seen.add(current.id);
      for (const e of current.edgesOut) {
        path.push(e);
        if (walk(e.to)) return true;
        path.pop();
      }
      return false;
    };
    if (this.root) walk(this.root);
    return path;
  }

  /** A readable tree of the built states, for the terminal: states as nodes,
   * the actions that reached them as their own connector lines. */
  printTree(): string {
    const lines: string[] = [];
    const seen = new Set<string>();
    const render = (node: StateNode, prefix: string): void => {
      const marker = node.snapshot.domMarkers.length > 0 ? ` [${node.snapshot.domMarkers.join(", ")}]` : "";
      const auth = Object.keys(node.snapshot.localStorage).length > 0 ? " 🔑" : "";
      lines.push(`${prefix}${node.snapshot.url}${marker}${auth} (w=${node.weight})`);
      if (seen.has(node.id)) {
        lines.push(`${prefix}(already shown)`);
        return;
      }
      seen.add(node.id);
      node.edgesOut.forEach((e, i) => {
        const last = i === node.edgesOut.length - 1;
        lines.push(`${prefix}${last ? "└─ " : "├─ "}${e.action.label}`);
        render(e.to, prefix + (last ? "   " : "│  "));
      });
    };
    if (this.root) render(this.root, "");
    return lines.join("\n");
  }
}
