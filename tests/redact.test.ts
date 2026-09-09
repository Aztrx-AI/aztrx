import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, unredact, sanitizeSecrets } from "../src/core/heal/redact.js";

test("redact/unredact round-trips whole-match secrets", () => {
  const secrets = [
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456",
    "AKIAIOSFODNN7EXAMPLE",
    "ghp_abcdefghijklmnopqrstuvwxyz123456",
    "xoxb-123456789012-abcdefghijklmnop",
  ];
  for (const s of secrets) {
    const { text, map } = redact(`const key = "${s}"`);
    assert.ok(!text.includes(s), `secret leaked: ${s}`);
    assert.equal(unredact(text, map), `const key = "${s}"`);
  }
});

test("redact replaces key=value and key: value secret shapes, preserving the key", () => {
  const { text, map } = redact(`password = "hunter2secret"; apiKey: "sk-live-abc"`);
  assert.ok(!text.includes("hunter2secret"));
  assert.ok(!text.includes("sk-live-abc"));
  // The key names stay visible (structure survives for the model).
  assert.ok(text.includes("password"));
  assert.ok(text.includes("apiKey"));
  // Round-trip restores both values.
  const back = unredact(text, map);
  assert.ok(back.includes("hunter2secret"));
  assert.ok(back.includes("sk-live-abc"));
});

test("redact scrubs passwords embedded in a database URL", () => {
  const { text, map } = redact("postgresql://admin:correct-horse-battery@db.internal:5432/app");
  assert.ok(!text.includes("correct-horse-battery"));
  assert.ok(text.startsWith("postgresql://admin:"));
  assert.equal(unredact(text, map), "postgresql://admin:correct-horse-battery@db.internal:5432/app");
});

test("sanitizeSecrets collapses secrets and emails to a fixed token (irreversible)", () => {
  const out = sanitizeSecrets(
    "credential: sk-ant-abcdefghijklmnopqrstuvwxyz123456 — reach danis@example.com for help"
  );
  assert.ok(!out.includes("sk-ant-"));
  assert.ok(!out.includes("danis@example.com"));
  assert.ok(out.includes("[REDACTED]"));
});

test("sanitizeSecrets leaves non-secret prose untouched", () => {
  const plain = "The button's onClick dereferences window.customer.address.";
  assert.equal(sanitizeSecrets(plain), plain);
});
