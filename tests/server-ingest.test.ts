import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createIngestServer } from "../server/index.js";
import type { Config } from "../server/config.js";
import type { RunUpload, TelemetryEnvelopeUpload } from "../server/types.js";

/**
 * The smoke test `server/index.ts:62` has been promising since it was written —
 * "Exporting (rather than auto-listening) lets the smoke test drive the whole
 * ingest path in-process on an ephemeral port." No such test existed anywhere in
 * the repo; this is it.
 *
 * It drives the real `createIngestServer` over real HTTP on port 0: the auth
 * gate, both ingest routes, and the fingerprint dedup the dashboard is built on.
 * Payload shape is taken from the wire contract in `server/types.ts`.
 */

const KEY = "sk_test_key";

function testConfig(): Config {
  return {
    port: 0, // ephemeral — never collides with a real server
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-ingest-")),
    keys: { [KEY]: { org: "acme", label: "Acme Inc" } },
  };
}

async function withServer(fn: (base: string) => Promise<void>): Promise<void> {
  const cfg = testConfig();
  const server = createIngestServer(cfg);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(cfg.dataDir, { recursive: true, force: true });
  }
}

function post(base: string, route: string, body: unknown, key?: string): Promise<Response> {
  return fetch(`${base}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { "x-api-key": key } : {}),
    },
    body: JSON.stringify(body),
  });
}

function runPayload(fingerprint: string): RunUpload {
  return {
    schema: "aztrx.run/1",
    sentAt: new Date().toISOString(),
    framework: "vite",
    framework_version: "8.3.0",
    target: "http://localhost:5173/",
    mode: "crash",
    counts: { crash: 1 },
    findings: [
      {
        fingerprint,
        severity: "crash",
        type: "runtime_crash",
        message: "Cannot read properties of undefined (reading 'items')",
        location: { file: "src/Cart.tsx", line: 42, column: 9 },
        patch: null,
        model_tier: null,
      },
    ],
  };
}

function telemetryPayload(fingerprint: string): TelemetryEnvelopeUpload {
  return {
    schema: "aztrx.telemetry/1",
    sentAt: new Date().toISOString(),
    tuples: [
      {
        crash_fingerprint: fingerprint,
        min_repro_spec: null,
        verified_patch: null,
        framework_metadata: { framework: "vite", version: "8.3.0" },
        model_tier_used: null,
      },
    ],
  };
}

test("ingest: /health answers without a key and counts the orgs", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, orgs: 1 });
  });
});

test("ingest: the auth gate holds — an unkeyed upload is refused", async () => {
  await withServer(async (base) => {
    const res = await post(base, "/api/runs", runPayload("fp-1"));
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { ok: false, error: "invalid api key" });
  });
});

test("ingest: a wrong key is refused exactly like a missing one", async () => {
  await withServer(async (base) => {
    const res = await post(base, "/api/runs", runPayload("fp-1"), "sk_not_a_real_key");
    assert.equal(res.status, 401);
  });
});

test("ingest: a keyed run upload is accepted and stored", async () => {
  await withServer(async (base) => {
    const res = await post(base, "/api/runs", runPayload("fp-1"), KEY);
    assert.equal(res.status, 201);
    const body = (await res.json()) as { ok: boolean; findings: number; new: number };
    assert.equal(body.ok, true);
    assert.equal(body.findings, 1);
    assert.equal(body.new, 1);

    const org = await fetch(`${base}/api/org`, { headers: { "x-api-key": KEY } });
    assert.equal(org.status, 200);
    const seen = (await org.json()) as { org: string; label: string; runs: number; findings: unknown[] };
    assert.equal(seen.org, "acme");
    assert.equal(seen.label, "Acme Inc");
    assert.equal(seen.runs, 1);
    assert.equal(seen.findings.length, 1);
  });
});

test("ingest: the same fingerprint twice dedups — that is the dashboard's whole basis", async () => {
  await withServer(async (base) => {
    const first = (await (await post(base, "/api/runs", runPayload("fp-same"), KEY)).json()) as {
      new: number;
    };
    assert.equal(first.new, 1, "the first sighting of a fingerprint is new");

    const second = (await (await post(base, "/api/runs", runPayload("fp-same"), KEY)).json()) as {
      findings: number;
      new: number;
    };
    assert.equal(second.findings, 1, "the finding is still counted");
    assert.equal(second.new, 0, "but it is not a new one");

    const org = (await (await fetch(`${base}/api/org`, { headers: { "x-api-key": KEY } })).json()) as {
      runs: number;
      findings: unknown[];
    };
    assert.equal(org.runs, 2, "two runs seen");
    assert.equal(org.findings.length, 1, "one finding, not two");
  });
});

test("ingest: telemetry accepts a well-formed envelope", async () => {
  await withServer(async (base) => {
    const res = await post(base, "/api/telemetry", telemetryPayload("fp-t"), KEY);
    assert.equal(res.status, 201);
    const body = (await res.json()) as { ok: boolean; accepted: number; new: number };
    assert.equal(body.ok, true);
    assert.equal(body.accepted, 1);
  });
});

test("ingest: a payload that is not our schema is rejected, not stored", async () => {
  await withServer(async (base) => {
    const res = await post(base, "/api/runs", { schema: "something/else", findings: [] }, KEY);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { ok: false, error: "invalid run payload" });
  });
});

test("ingest: an unknown route under a valid key is a 404, not a silent success", async () => {
  await withServer(async (base) => {
    const res = await post(base, "/api/nope", {}, KEY);
    assert.equal(res.status, 404);
  });
});

test("dashboard: /api/runs returns the run timeline for the org", async () => {
  await withServer(async (base) => {
    await post(base, "/api/runs", runPayload("fp-r1"), KEY);
    await post(base, "/api/runs", runPayload("fp-r2"), KEY);

    const res = await fetch(`${base}/api/runs`, { headers: { "x-api-key": KEY } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      org: string;
      runs: { run_id: string; findings: string[]; target: string; mode: string }[];
    };
    assert.equal(body.ok, true);
    assert.equal(body.org, "acme");
    assert.equal(body.runs.length, 2, "two runs on the timeline, newest first");
    assert.equal(body.runs[0].findings[0], "fp-r2", "the latest run sorts first");
  });
});

test("dashboard: /api/runs needs a key like everything else", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/runs`);
    assert.equal(res.status, 401);
  });
});

test("dashboard: /api/findings/:fp returns one canonical finding", async () => {
  await withServer(async (base) => {
    await post(base, "/api/runs", runPayload("fp-detail"), KEY);
    await post(base, "/api/runs", runPayload("fp-detail"), KEY);

    const res = await fetch(`${base}/api/findings/fp-detail`, { headers: { "x-api-key": KEY } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      finding: { fingerprint: string; occurrences: number; seen_runs: number; latest: { run_id: string } };
    };
    assert.equal(body.ok, true);
    assert.equal(body.finding.fingerprint, "fp-detail");
    assert.equal(body.finding.occurrences, 2, "dedup counts both sightings");
    assert.equal(body.finding.seen_runs, 2);
    assert.ok(body.finding.latest.run_id, "the latest sighting names its run");
  });
});

test("dashboard: a fingerprint nobody reported is a 404, not an empty page", async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/findings/never-seen`, { headers: { "x-api-key": KEY } });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { ok: false, error: "unknown fingerprint" });
  });
});
