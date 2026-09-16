import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSignals } from "../src/core/profile.js";
import { synthesizeRoles, profileSummary } from "../src/core/synthesize.js";
import type { ProjectProfile } from "../src/core/profile.js";

const SHOP_TEXT =
  "Welcome to our store. Add to cart, checkout now. Subscribe for 10% discount — use coupon code SAVE50 at checkout. Sign in to track your orders. Stripe handles billing.";

const CHAT_TEXT =
  "Team chat: send a message, mention @teammates, threads and comments everywhere. Live updates in realtime.";

test("extractSignals: a shop's text votes for e-commerce and accounts", () => {
  const signals = extractSignals(SHOP_TEXT);
  assert.ok(signals.includes("cart"), "cart signal fires");
  assert.ok(signals.includes("pricing"), "pricing signal fires");
  assert.ok(signals.includes("payments-lib"), "stripe fires payments-lib");
  assert.ok(signals.includes("auth"), "sign in fires auth");
});

test("extractSignals: a chat app votes for collaboration", () => {
  const signals = extractSignals(CHAT_TEXT);
  assert.ok(signals.includes("chat"));
  assert.ok(signals.includes("realtime"));
});

test("extractSignals: unrelated text fires nothing", () => {
  assert.deepEqual(extractSignals("A plain static page about trains."), []);
});

function profile(domains: string[], signals: string[]): ProjectProfile {
  return { domains, signals, framework: "" };
}

test("synthesizeRoles: a shop gets its audience on top of the base catalog", () => {
  const roles = synthesizeRoles(profile(["e-commerce"], ["cart", "pricing"]));
  assert.equal(roles.length, 13, "10 base + 3 shop personas");
  const ids = roles.map((r) => r.id);
  assert.ok(ids.includes("rushed-buyer"));
  assert.ok(ids.includes("coupon-hunter"));
  assert.ok(ids.includes("window-shopper"));
  assert.equal(ids[0], "novice", "the base catalog comes first");
});

test("synthesizeRoles: personas are weighted — the audience mix, not equality", () => {
  const roles = synthesizeRoles(profile(["e-commerce"], ["cart"]));
  const buyer = roles.find((r) => r.id === "rushed-buyer")!;
  assert.equal(buyer.weight, 5);
  assert.equal(buyer.mode, "solo");
  assert.ok(buyer.behaviors[0].payloads === undefined || Array.isArray(buyer.behaviors[0].payloads));
});

test("synthesizeRoles: coupon hunters carry domain-flavored payloads", () => {
  const roles = synthesizeRoles(profile(["e-commerce"], ["cart"]));
  const hunter = roles.find((r) => r.id === "coupon-hunter")!;
  assert.ok(hunter.behaviors[0].payloads!.includes("SAVE50"));
  assert.ok(hunter.behaviors[0].payloads!.includes("' OR 1=1--"));
});

test("synthesizeRoles: an unknown domain adds nothing", () => {
  const roles = synthesizeRoles(profile([], []));
  assert.equal(roles.length, 10, "base catalog only");
});

test("synthesizeRoles: no duplicate ids when a domain repeats", () => {
  const roles = synthesizeRoles(profile(["e-commerce"], []));
  const ids = roles.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("profileSummary: names the domains, signals and persona count", () => {
  const summary = profileSummary(profile(["e-commerce"], ["cart", "pricing"]), 3);
  assert.match(summary, /e-commerce/);
  assert.match(summary, /cart, pricing/);
  assert.match(summary, /\+3 persona/);
});
