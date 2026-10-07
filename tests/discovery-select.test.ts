import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { chromium } from "playwright";
// Compiled output, not src/: Playwright serializes functions into the page, and
// tsx's keep-names helper does not exist there. The shipped build is what runs.
import { invariantDiscovery } from "../dist/core/discovery/runtime.js";
import { EventBus } from "../dist/core/eventBus.js";
import type { EvidenceChunk } from "../dist/core/discovery/evidence.js";

function hasChromium(): boolean {
  try {
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
const skip = hasChromium() ? false : "playwright chromium not installed";

// The rule lives in "source": a successor list. Arbitrary words, on purpose.
// Only the `live` row changed, so only its moves are rules under test.
const SOURCE: EvidenceChunk = {
  source: "git_diff",
  changedLines: [4],
  location: "flow.ts",
  content: [
    "export const FLOW = {",
    '  draft: ["review"],',
    '  review: ["live"],',
    "  live: [],",
    "};",
  ].join("\n"),
};

interface Opts {
  /** The page refuses moves the source doesn't list. */
  enforce: boolean;
  /** The page only offers the moves it would accept (a "smart" dropdown). */
  offerOnlyValid: boolean;
  /** Label options with words that are not states. */
  opaqueLabels?: boolean;
}

function html({ enforce, offerOnlyValid, opaqueLabels }: Opts): string {
  return `<!doctype html><title>t</title>
<p>Stage: <b id="st">draft</b></p>
<select id="sel" aria-label="stage"></select>
<script>
  // Built at runtime, so the page itself states no literal table for aztrx to read.
  const ok = JSON.parse('{"draft":["review"],"review":["live"],"live":[]}');
  let cur = "draft";
  const sel = document.getElementById("sel");
  const label = (o) => ${opaqueLabels ? 'o === "draft" ? "alpha" : o === "review" ? "beta" : "gamma"' : "o"};
  function render() {
    document.getElementById("st").textContent = cur;
    const opts = ${offerOnlyValid ? "[cur, ...ok[cur]]" : "Object.keys(ok)"};
    sel.innerHTML = opts.map((o) => '<option value="' + (${opaqueLabels ? "label(o)" : "o"}) + '"' + (o === cur ? " selected" : "") + ">" + label(o) + "</option>").join("");
  }
  sel.addEventListener("change", () => {
    const to = ${opaqueLabels ? '({ alpha: "draft", beta: "review", gamma: "live" })[sel.value]' : "sel.value"};
    if (${enforce ? "ok[cur].includes(to)" : "true"}) cur = to;
    render();
  });
  render();
</script>`;
}

async function discover(opts: Opts) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("http://app.test/", (r) => r.fulfill({ contentType: "text/html", body: html(opts) }));
    await page.goto("http://app.test/");
    const bus = new EventBus();
    const findings: string[] = [];
    bus.on("telemetry", (p) => findings.push(p.rawMessage));
    const res = await invariantDiscovery(page, bus, { extraEvidence: [SOURCE], maxCandidates: 10 });
    const trace = (id: string) => res.traces.find((t) => t.candidate.id === id)!;
    return { res, trace, findings };
  } finally {
    await browser.close();
  }
}

const RULE = "FLOW:live->draft=>stays(live)";
const stage = (t: { stages: Array<{ stage: string; outcome: string }> }, name: string) => t.stages.find((s) => s.stage === name)!.outcome;

test(
  "select: a page that enforces the rule through a <select> — the move is attempted and refused",
  { skip, timeout: 120_000 },
  async () => {
    const { trace, findings } = await discover({ enforce: true, offerOnlyValid: false });
    const t = trace(RULE);
    assert.equal(t.verdict, "preserved", t.stoppedBecause);
    assert.equal(findings.length, 0);
    assert.ok(t.stages.every((s) => s.outcome === "ok"), JSON.stringify(t.stages));
    // The binding says what it tied the rule to and why.
    assert.ok(t.binding!.some((b) => b.role === "state_readout" && /b#st|select#sel selected/.test(b.matched)));
    assert.ok(t.binding!.some((b) => b.role === "control" && /select#sel option/.test(b.matched)));
    // The refused attempt really went through the select, and the control moved.
    const forbidden = t.observations.find((o) => o.label === "forbidden")!;
    assert.deepEqual(forbidden.before.flags, { state: "live" });
    assert.deepEqual(forbidden.after.flags, { state: "live" });
    assert.ok(forbidden.actions.some((a) => a.target === "→ draft"));
    assert.equal(t.observations.find((o) => o.label === "allowed-control")!.controlOk, true);
  }
);

test(
  "select: a page that does not enforce the rule — the violation is found, reproduced, and traced",
  { skip, timeout: 120_000 },
  async () => {
    const { trace, findings } = await discover({ enforce: false, offerOnlyValid: false });
    const t = trace(RULE);
    assert.equal(t.verdict, "violated", t.stoppedBecause);
    assert.ok(findings.length >= 1);
    const mine = findings.find((m) => /moving to "draft" in state "live"/.test(m))!;
    assert.match(mine, /the page shows state=draft/);
    assert.match(mine, /Trace:/);
    const forbidden = t.observations.find((o) => o.label === "forbidden")!;
    assert.deepEqual(forbidden.after.flags, { state: "draft" });
    assert.equal(forbidden.reproduced, true);
    // This page honours nothing, so the row's other unlisted move is violated too.
    assert.equal(trace("FLOW:live->review=>stays(live)").verdict, "violated");
  }
);

test(
  "select: a page that only offers valid moves cannot be asked — unknown, not preserved, and not a finding",
  { skip, timeout: 120_000 },
  async () => {
    const { trace, findings } = await discover({ enforce: true, offerOnlyValid: true });
    const t = trace(RULE);
    assert.equal(t.verdict, "unknown");
    assert.equal(findings.length, 0);
    assert.equal(stage(t, "runtime_bound"), "ok");
    assert.equal(stage(t, "experiment_executed"), "failed");
    assert.equal(stage(t, "verdict"), "skipped");
    assert.match(t.stoppedBecause ?? "", /not offered: the select offers no option for "draft"/);
    assert.match(t.stoppedBecause ?? "", /offers: live/);
  }
);

test(
  "select: options whose labels cannot be tied to states are not guessed at",
  { skip, timeout: 120_000 },
  async () => {
    const { trace, findings } = await discover({ enforce: true, offerOnlyValid: false, opaqueLabels: true });
    const t = trace(RULE);
    assert.equal(t.verdict, "unknown");
    assert.equal(findings.length, 0);
    assert.equal(stage(t, "runtime_bound"), "failed");
    assert.match(t.stoppedBecause ?? "", /binding: /);
  }
);
