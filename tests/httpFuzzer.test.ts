import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { Page } from "playwright";
import { EventBus } from "../src/core/eventBus.js";
import { httpFuzz } from "../src/core/httpFuzzer.js";
import type { TelemetryErrorPayload } from "../src/core/types.js";

test("httpFuzz catches a 500 on a JS-fetch-only endpoint via seedUrls", async () => {
  // Local server: /api/users?id=-1 → 500, everything else → 200. The endpoint is
  // invisible to performance/DOM harvesting — it only exists as a `fetch()` target.
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    if (u.pathname === "/api/users" && u.searchParams.get("id") === "-1") {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { message: "boom" } }));
      return;
    }
    res.statusCode = 200;
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

  const bus = new EventBus();
  const telemetry: TelemetryErrorPayload[] = [];
  bus.on("telemetry", (t) => telemetry.push(t));

  // Stub page: no resources and no DOM links/forms — only the seed supplies the
  // endpoint. `navigate: false` means `goto`/`waitForTimeout` are never called.
  // `/api/users` matches the destructive-path deny-list, so allow it explicitly
  // (same as the `--allow-destructive` a real run would pass).
  const page = { evaluate: async () => [] as string[] } as unknown as Page;
  const sent = await httpFuzz(page, origin, bus, {
    maxRequests: 50,
    seedUrls: [`${origin}/api/users`],
    navigate: false,
    allowDestructive: true,
  });

  await new Promise<void>((r) => server.close(() => r()));

  assert.ok(sent > 0, "expected at least one request sent");
  const fivexx = telemetry.filter((t) => t.type === "network_5xx");
  assert.ok(fivexx.length > 0, "expected a network_5xx finding");
  assert.ok(
    fivexx.some((t) => t.rawMessage.includes("/api/users")),
    "expected the 500 to name /api/users"
  );
});
