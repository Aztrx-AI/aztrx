import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { chromium } from "playwright";
// Compiled output, not src/: Playwright serializes functions into the page, and
// tsx's keep-names helper does not exist there. The shipped build is what runs.
import { bindStateTransition } from "../dist/core/discovery/drivers.js";
import { inferCandidates } from "../dist/core/discovery/infer.js";
import { planExperiment } from "../dist/core/discovery/plan.js";
import { stageTable } from "../dist/core/discovery/runtime.js";
import type { StateTransitionPlan } from "../dist/core/discovery/types.js";

const MACHINE = [
  "const flow = {",
  '  open:   { start: "active", drop: "dropped" },',
  '  active: { finish: "done", drop: "dropped" },',
  "  dropped: {},",
  "  done: {},",
  "};",
].join("\n");

const candidate = () => inferCandidates({ source: "repo_source", location: "flow.js", content: MACHINE }).find((c) => c.id === "flow:dropped+finish=>stays(dropped)")!;

function hasChromium(): boolean {
  try {
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const skip = hasChromium() ? false : "playwright chromium not installed";

// ---- stage table -----------------------------------------------------------

test("stages: a candidate that was planned but could not be bound fails at runtime_bound and skips the rest", () => {
  const t = stageTable({ planned: true, bound: false, executed: false, observed: false, concluded: false, why: "binding: no control" });
  assert.deepEqual(
    t.map((s) => [s.stage, s.outcome]),
    [
      ["evidence_extracted", "ok"],
      ["invariant_inferred", "ok"],
      ["runtime_bound", "failed"],
      ["experiment_planned", "ok"],
      ["experiment_executed", "skipped"],
      ["observation_captured", "skipped"],
      ["verdict", "skipped"],
    ]
  );
  assert.equal(t.find((s) => s.outcome === "failed")?.detail, "binding: no control");
});

test("stages: a candidate with no experiment family fails at experiment_planned, before binding is even tried", () => {
  const t = stageTable({ planned: false, bound: false, executed: false, observed: false, concluded: false, why: "no family" });
  assert.equal(t.find((s) => s.outcome === "failed")?.stage, "experiment_planned");
  assert.equal(t.find((s) => s.stage === "runtime_bound")?.outcome, "skipped");
});

test("stages: a full run is ok end to end, and an unreadable outcome stops at observation_captured", () => {
  assert.ok(stageTable({ planned: true, bound: true, executed: true, observed: true, concluded: true }).every((s) => s.outcome === "ok"));
  const t = stageTable({ planned: true, bound: true, executed: true, observed: false, concluded: false, why: "unreadable" });
  assert.equal(t.find((s) => s.outcome === "failed")?.stage, "observation_captured");
  assert.equal(t.find((s) => s.stage === "verdict")?.outcome, "skipped");
});

// ---- source -> runtime link ------------------------------------------------

async function bindOn(html: string) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    const c = candidate();
    return await bindStateTransition(page, c, planExperiment(c) as StateTransitionPlan);
  } finally {
    await browser.close();
  }
}

test(
  "binding: a page that exposes the machine's vocabulary is bound, with a record of what matched",
  { skip, timeout: 60_000 },
  async () => {
    const s = await bindOn(
      `<p>Task: <b>open</b></p><button>Start</button><button>Finish</button><button>Drop</button>`
    );
    assert.ok(!("reason" in s), "reason" in s ? s.reason : "");
    const roles = s.binding.map((b) => `${b.role}:${b.name}`);
    assert.ok(roles.includes("state_readout:flow"));
    for (const e of ["start", "finish", "drop"]) assert.ok(roles.includes(`control:${e}`), e);
    assert.match(s.binding.find((b) => b.role === "state_readout")!.matched, /b "open"/);
    assert.match(s.binding.find((b) => b.name === "finish")!.matched, /button "Finish" \(exact name\)/);
  }
);

test(
  "binding: one stray button with a matching name is not enough to call a page the machine",
  { skip, timeout: 60_000 },
  async () => {
    // The page has a state-looking word and a "Finish" button — and nothing else of the machine.
    const s = await bindOn(`<p>Status: <b>open</b></p><button>Finish</button><button>Print</button>`);
    assert.ok("reason" in s);
    assert.match(s.reason, /weak source-to-page link: only 1 of 3 actions of flow/);
    assert.match(s.reason, /no control for: start, drop/);
  }
);

test(
  "binding: a page showing several of the machine's states at once is ambiguous, not guessed",
  { skip, timeout: 60_000 },
  async () => {
    const s = await bindOn(`<ul><li>open</li><li>done</li></ul><button>Start</button><button>Finish</button><button>Drop</button>`);
    assert.ok("reason" in s);
    assert.match(s.reason, /several of the machine's states at once/);
  }
);

test(
  "binding: a disabled control is not a control (a locked-down UI cannot be driven)",
  { skip, timeout: 60_000 },
  async () => {
    const s = await bindOn(
      `<p>Status: <b>open</b></p><button>Start</button><button disabled>Finish</button><button>Drop</button>`
    );
    assert.ok("reason" in s);
    assert.match(s.reason, /no control is named like "finish"|only 2 of 3|no control for: finish/);
  }
);

// ---- a list of entities ----------------------------------------------------

const SUCCESSOR_TABLE = [
  "const ORDERS = {",
  '  pending: ["shipped", "cancelled"],',
  '  shipped: ["delivered", "cancelled"],',
  "  delivered: [],",
  "  cancelled: [],",
  "};",
].join("\n");

async function bindListPage(rows: Array<{ id: string; state: string }>) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const opt = (s: string, cur: string) => `<option${s === cur ? " selected" : ""}>${s}</option>`;
    const sel = (cur: string) => `<select>${["pending", "shipped", "delivered", "cancelled"].map((s) => opt(s, cur)).join("")}</select>`;
    const body = `<table>${rows.map((r) => `<tr><td>#${r.id}</td><td>${sel(r.state)}</td></tr>`).join("")}</table>`;
    await page.route("http://list.test/", (r) => r.fulfill({ contentType: "text/html", body }));
    await page.goto("http://list.test/");
    const c = inferCandidates({ source: "repo_source", location: "o.ts", content: SUCCESSOR_TABLE }).find(
      (x) => x.id === "ORDERS:delivered->pending=>stays(delivered)"
    )!;
    return await bindStateTransition(page, c, planExperiment(c) as StateTransitionPlan);
  } finally {
    await browser.close();
  }
}

test(
  "binding: a list of entities, each with its own status select, is not one entity's state — never guessed",
  { skip, timeout: 60_000 },
  async () => {
    const mixed = await bindListPage([
      { id: "1", state: "pending" },
      { id: "2", state: "shipped" },
    ]);
    assert.ok("reason" in mixed);
    assert.match(mixed.reason, /several of the machine's states at once/);

    // Even when every row happens to show the same state, two selects are two entities.
    const same = await bindListPage([
      { id: "1", state: "pending" },
      { id: "2", state: "pending" },
    ]);
    assert.ok("reason" in same);
    assert.match(same.reason, /weak source-to-page link|selects offer the machine's states/);
  }
);

test(
  "binding: one entity with one status select is bound, whichever state it is in",
  { skip, timeout: 60_000 },
  async () => {
    for (const state of ["pending", "shipped"]) {
      const s = await bindListPage([{ id: "1", state }]);
      assert.ok(!("reason" in s), "reason" in s ? s.reason : "");
      assert.ok(s.binding.some((b) => b.role === "control" && /select/.test(b.matched)));
    }
  }
);
