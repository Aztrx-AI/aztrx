import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIntent } from "../src/core/intent.js";
import { businessRiskOf, annotateBusinessRisks } from "../src/core/businessRisk.js";
import type { Finding } from "../src/core/types.js";

test("intent: a payment fear picks the payment team", () => {
  const plan = parseIntent("Проверь безопасность оплаты");
  assert.equal(plan.theme, "payment");
  assert.ok(plan.roles.includes("paywall-bypass"));
  assert.ok(plan.roles.includes("token-tamper"));
  assert.ok(plan.roles.includes("race-hunter"));
  assert.match(plan.hint, /платёж|оплат/i);
});

test("intent: a data-leak fear sends the key hunter", () => {
  const plan = parseIntent("can users leak each other's data?");
  assert.equal(plan.theme, "data");
  assert.ok(plan.roles.includes("ssr-leak"));
  assert.ok(plan.roles.includes("observer"));
});

test("intent: an auth fear forges tokens", () => {
  const plan = parseIntent("что если подделают токен и зайдут как админ");
  assert.equal(plan.theme, "auth");
  assert.ok(plan.roles.includes("token-tamper"));
  assert.ok(plan.roles.includes("hostile"));
});

test("intent: empty input runs the whole swarm", () => {
  const plan = parseIntent(undefined);
  assert.equal(plan.theme, "general");
  assert.ok(plan.roles.length >= 13);
});

test("intent: gibberish falls back to the full swarm with an honest hint", () => {
  const plan = parseIntent("xyzzy123");
  assert.equal(plan.theme, "general");
  assert.match(plan.hint, /xyzzy123/);
});

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: "f",
    fingerprint: "f",
    occurrences: 1,
    severity: "error",
    type: "console_error",
    rawMessage: "",
    rawStack: "",
    actionHistory: [],
    ...overrides,
  };
}

test("businessRisk: an exposed Stripe key is money, not jargon", () => {
  const f = finding({
    type: "secret_leak",
    rawMessage: "Secret exposed in page source: Stripe live key on /checkout (from SSR/hydration HTML)",
  });
  const risk = businessRiskOf(f, "ru");
  assert.match(risk, /stripe live key/i);
  assert.match(risk, /счёт/i);
});

test("businessRisk: a forged role is 'your roles are decoration'", () => {
  const f = finding({
    type: "secret_leak",
    rawMessage: `Token tampering accepted: role=admin on token opened "admin panel" — the app trusted a forged identity claim`,
  });
  const risk = businessRiskOf(f, "en");
  assert.match(risk, /admin panel/);
  assert.match(risk, /decoration/);
});

test("businessRisk: a paywall bypass is lost revenue", () => {
  const f = finding({
    type: "secret_leak",
    rawMessage: `Paywall bypassed: /files/premium.pdf renders "download the file" without payment or login`,
  });
  const risk = businessRiskOf(f, "ru");
  assert.match(risk, /\/files\/premium\.pdf/);
  assert.match(risk, /доход/);
});

test("businessRisk: a 5xx is uptime one curl away", () => {
  const f = finding({ type: "network_5xx", rawMessage: "HTTP 500 on https://api.example.com/orders" });
  const risk = businessRiskOf(f, "en");
  assert.match(risk, /https:\/\/api\.example\.com\/orders/);
  assert.match(risk, /down|uptime/i);
});

test("annotateBusinessRisks: fills in place and never overwrites", () => {
  const f = finding({ type: "network_timeout", rawMessage: "timeout on https://x.io" });
  const [out] = annotateBusinessRisks([f], "ru");
  assert.ok(out.businessRisk);
  const first = out.businessRisk;
  annotateBusinessRisks([out], "ru");
  assert.equal(out.businessRisk, first);
});
