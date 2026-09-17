import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PriorityQueue,
  StateGraph,
  riskWeight,
  signatureOf,
  stateWeight,
} from "../src/core/graph.js";
import type { StateSnapshot } from "../src/core/graph.js";

function snap(url: string, overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    url,
    localStorage: {},
    cookies: [],
    domMarkers: [],
    ...overrides,
  };
}

test("riskWeight counts the business-risk keywords", () => {
  assert.equal(riskWeight("Proceed to Checkout and Pay now"), 2);
  assert.equal(riskWeight("Admin panel: delete user tokens"), 3); // admin, delete, token
  assert.equal(riskWeight("About us"), 0);
});

test("stateWeight: riskier states weigh less (are explored first)", () => {
  assert.ok(stateWeight(snap("http://x/checkout")) < stateWeight(snap("http://x/about")));
  assert.equal(stateWeight(snap("http://x/about")), 10); // no hits → base
  assert.ok(stateWeight(snap("http://x/login", { domMarkers: ["admin panel"] })) <= 4);
  assert.ok(stateWeight(snap("http://x/admin")) >= 1, "floor is 1");
});

test("PriorityQueue pops the smallest weight first, stable on ties", () => {
  const pq = new PriorityQueue<string>();
  pq.push("low", 5);
  pq.push("high", 1);
  pq.push("mid", 3);
  pq.push("tie-a", 3);
  pq.push("tie-b", 3);
  assert.equal(pq.pop()!.item, "high");
  assert.equal(pq.pop()!.item, "mid");
  assert.equal(pq.pop()!.item, "tie-a");
  assert.equal(pq.pop()!.item, "tie-b");
  assert.equal(pq.pop()!.item, "low");
  assert.equal(pq.pop(), null);
});

test("PriorityQueue interleaves pushes and pops correctly", () => {
  const pq = new PriorityQueue<number>();
  pq.push(1, 10);
  pq.push(2, 2);
  assert.equal(pq.pop()!.item, 2);
  pq.push(3, 1);
  assert.equal(pq.pop()!.item, 3);
  assert.equal(pq.pop()!.item, 1);
});

test("signatureOf: same URL with a token appearing is a NEW state", () => {
  const plain = signatureOf(snap("http://x/app"));
  const authed = signatureOf(snap("http://x/app", { localStorage: { token: "jwt" } }));
  assert.notEqual(plain, authed);
  // Values don't matter — a re-issued token with the same key is the same state.
  const reissued = signatureOf(snap("http://x/app", { localStorage: { token: "jwt2" } }));
  assert.equal(authed, reissued);
});

test("StateGraph dedups states and builds the path to any node", () => {
  const g = new StateGraph();
  const root = g.addState(snap("http://x/"));
  const login = g.addState(snap("http://x/login"));
  const authed = g.addState(snap("http://x/app", { localStorage: { token: "j" } }));
  const admin = g.addState(snap("http://x/admin", { localStorage: { token: "j" } }));

  g.addEdge(root, login, { type: "click", label: 'click "Login"', selectors: ["#login"] });
  g.addEdge(login, authed, { type: "submit", label: 'submit "Sign in"', selectors: ["#signin"] });
  g.addEdge(authed, admin, { type: "click", label: 'click "Admin Panel"', selectors: ["#admin"] });

  assert.equal(g.size, 4);
  assert.equal(g.getEdgeCount(), 3);
  assert.equal(g.addState(snap("http://x/login")).id, login.id, "dedup by signature");

  const path = g.pathTo(admin);
  assert.deepEqual(
    path.map((e) => e.action.label),
    ['click "Login"', 'submit "Sign in"', 'click "Admin Panel"']
  );
});

test("printTree renders the states as a readable tree", () => {
  const g = new StateGraph();
  const root = g.addState(snap("http://x/"));
  const authed = g.addState(snap("http://x/", { localStorage: { token: "j" }, domMarkers: ["admin panel"] }));
  g.addEdge(root, authed, { type: "click", label: 'click "Login"', selectors: ["#l"] });
  const tree = g.printTree();
  assert.match(tree, /http:\/\/x\//);
  assert.match(tree, /admin panel/);
  assert.match(tree, /🔑/);
  assert.match(tree, /click "Login"/);
});
