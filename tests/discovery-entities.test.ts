import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { chromium, type Page } from "playwright";
// Compiled output, not src/: Playwright serializes functions into the page, and
// tsx's keep-names helper does not exist there. The shipped build is what runs.
import { surveyEntities } from "../dist/core/discovery/entities.js";
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

const STATES = ["draft", "review", "live"];

async function withPage<T>(html: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("http://list.test/", (r) => r.fulfill({ contentType: "text/html", body: html }));
    await page.goto("http://list.test/");
    return await fn(page);
  } finally {
    await browser.close();
  }
}

// ---- static pages: how the page is read ------------------------------------

const row = (cells: string[]) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
const sel = (cur: string) => `<select>${STATES.map((s) => `<option${s === cur ? " selected" : ""}>${s}</option>`).join("")}</select>`;
const table = (rows: string[]) => `<table><tbody>${rows.join("")}</tbody></table>`;

test("entities: repeated rows with different states are found, identified by the text that tells them apart", { skip, timeout: 60_000 }, async () => {
  const html = table([row(["E-1", `<span>draft</span>`, sel("draft")]), row(["E-2", `<span>review</span>`, sel("review")]), row(["E-3", `<span>live</span>`, sel("live")])]);
  const s = await withPage(html, (p) => surveyEntities(p, STATES));
  assert.equal(s.mode, "entities");
  assert.equal(s.shape, "tr ×3");
  assert.equal(s.slot, "text:0");
  assert.deepEqual(
    s.entities?.map((e) => ({ value: e.value, state: e.state })),
    [
      { value: "E-1", state: "draft" },
      { value: "E-2", state: "review" },
      { value: "E-3", state: "live" },
    ]
  );
});

test("entities: rows that all show the same state are still separate entities", { skip, timeout: 60_000 }, async () => {
  const html = table([row(["A", sel("draft")]), row(["B", sel("draft")]), row(["C", sel("draft")])]);
  const s = await withPage(html, (p) => surveyEntities(p, STATES));
  assert.equal(s.mode, "entities");
  assert.deepEqual(s.entities?.map((e) => e.value), ["A", "B", "C"]);
  assert.ok(s.entities?.every((e) => e.state === "draft"));
});

test("entities: an id/data attribute is a firmer identity than text, wherever it sits", { skip, timeout: 60_000 }, async () => {
  // Row text repeats ("Item"); the only thing that differs is a data attribute on a descendant.
  const html = table([1, 2, 3].map((n) => row([`Item`, `<span>draft</span>`, `<span data-key="k${n}">${sel("draft")}</span>`])));
  const s = await withPage(html, (p) => surveyEntities(p, STATES));
  assert.equal(s.mode, "entities");
  assert.match(s.slot ?? "", /^attr:data-key:/);
  assert.deepEqual(s.entities?.map((e) => e.value), ["k1", "k2", "k3"]);
});

test("entities: a link target tells rows apart when nothing else does", { skip, timeout: 60_000 }, async () => {
  const html = table([1, 2].map((n) => row([`<a href="/things/${n}">open</a>`, sel("draft")])));
  const s = await withPage(html, (p) => surveyEntities(p, STATES));
  assert.equal(s.mode, "entities");
  assert.match(s.slot ?? "", /^href:/);
  assert.deepEqual(s.entities?.map((e) => e.value), ["/things/1", "/things/2"]);
});

test("entities: repetitions nothing can tell apart are ambiguous, not guessed", { skip, timeout: 60_000 }, async () => {
  const html = table([row(["Item", sel("draft")]), row(["Item", sel("review")]), row(["Item", sel("live")])]);
  const s = await withPage(html, (p) => surveyEntities(p, STATES));
  assert.equal(s.mode, "ambiguous");
  assert.match(s.reason ?? "", /nothing inside them tells one from another/);
});

test("entities: two unlike regions showing states are ambiguous", { skip, timeout: 60_000 }, async () => {
  // An orders-style list and a "recent activity" feed that also shows states.
  const html =
    table([row(["A", sel("draft")]), row(["B", sel("review")])]) +
    `<ul><li>live</li><li>review</li></ul>`;
  const s = await withPage(html, (p) => surveyEntities(p, STATES));
  assert.equal(s.mode, "ambiguous");
  assert.match(s.reason ?? "", /regions that are not alike/);
});

test("entities: one thing shown in two places is a single entity, and a lone state is too", { skip, timeout: 60_000 }, async () => {
  const both = await withPage(`<p>Stage: <b>draft</b></p>${sel("draft")}`, (p) => surveyEntities(p, STATES));
  assert.equal(both.mode, "single");
  const lone = await withPage(`<p>Stage: <b>review</b></p><button>Go</button>`, (p) => surveyEntities(p, STATES));
  assert.equal(lone.mode, "single");
  const none = await withPage(`<p>Hello</p>`, (p) => surveyEntities(p, STATES));
  assert.equal(none.mode, "none");
});

// ---- live pages: experiments stay inside one entity ------------------------

const SOURCE: EvidenceChunk = {
  source: "git_diff",
  location: "flow.ts",
  changedLines: [4], // only the `live` row changed: rules are "from live, not to draft / review"
  content: ["export const FLOW = {", '  draft: ["review"],', '  review: ["live"],', "  live: [],", "};"].join("\n"),
};

interface ListOpts {
  /** The page refuses moves the source doesn't list. */
  enforce: boolean;
  /** Re-sort the rows by state after every change, so a row moves. */
  reorder?: boolean;
  /** The row vanishes after any change. */
  removeOnChange?: boolean;
  /** Rows show nothing that tells them apart. */
  noIdentity?: boolean;
  /** Every render gives each row a fresh random DOM id (an identity that does not last). */
  randomIds?: boolean;
  /** Starting [id, state] pairs. */
  start?: Array<[string, string]>;
}

function listPage(o: ListOpts): string {
  const start = o.start ?? [["E-1", "draft"], ["E-2", "review"], ["E-3", "live"], ["E-4", "review"]];
  return `<!doctype html><title>list</title>
<table><thead><tr><th>Item</th><th>Stage</th><th>Move</th></tr></thead><tbody id="rows"></tbody></table>
<script>
  // Built at runtime, so the page itself states no literal table for aztrx to read.
  const ok = JSON.parse('{"draft":["review"],"review":["live"],"live":[]}');
  const order = ["draft", "review", "live"];
  let items = JSON.parse(${JSON.stringify(JSON.stringify(start.map(([id, st]) => ({ id, st }))))});
  window.changes = [];
  let shown = [];
  const rows = document.getElementById("rows");
  function render() {
    shown = [...items];
    ${o.reorder ? 'shown.sort((a, b) => order.indexOf(a.st) - order.indexOf(b.st) || a.id.localeCompare(b.id));' : ""}
    rows.innerHTML = shown.map((i, n) =>
      "<tr" + ${o.randomIds ? `' id="r' + Math.random().toString(36).slice(2) + '"'` : '""'} + "><td>" + ${o.noIdentity ? '"Item"' : "i.id"} + "</td><td><span>" + i.st + "</span></td><td><select data-n=\\"" + n + "\\">" +
      order.map((s) => "<option" + (s === i.st ? " selected" : "") + ">" + s + "</option>").join("") + "</select></td></tr>").join("");
  }
  rows.addEventListener("change", (e) => {
    const s = e.target;
    const it = shown[Number(s.getAttribute("data-n"))];
    window.changes.push({ id: it.id, to: s.value });
    if (${o.enforce ? "ok[it.st].includes(s.value)" : "true"}) it.st = s.value;
    ${o.removeOnChange ? "items = items.filter((x) => x !== it);" : ""}
    render();
  });
  render();
</script>`;
}

async function discover(o: ListOpts) {
  return withPage(listPage(o), async (page) => {
    const bus = new EventBus();
    const findings: string[] = [];
    bus.on("telemetry", (p) => findings.push(p.rawMessage));
    const res = await invariantDiscovery(page, bus, { extraEvidence: [SOURCE], maxCandidates: 10 });
    const changes = (await page.evaluate(() => (window as unknown as { changes: Array<{ id: string; to: string }> }).changes)) as Array<{ id: string; to: string }>;
    return { res, findings, changes, trace: (id: string) => res.traces.find((t) => t.candidate.id === id)! };
  });
}

const RULE = "FLOW:live->draft=>stays(live)";
const stage = (t: { stages: Array<{ stage: string; outcome: string }> }, name: string) => t.stages.find((s) => s.stage === name)!.outcome;

test("scoped: the experiment runs inside one entity, and no other row is touched", { skip, timeout: 120_000 }, async () => {
  const { trace, findings, changes } = await discover({ enforce: true, reorder: true });
  const t = trace(RULE);
  assert.equal(t.verdict, "preserved", t.stoppedBecause);
  assert.equal(findings.length, 0);
  assert.ok(t.stages.every((s) => s.outcome === "ok"), JSON.stringify(t.stages));

  // The binding says what was repeated and what told the repetitions apart.
  const scope = t.binding!.find((b) => b.role === "entity_scope")!;
  // Rows are sorted by state, so document order is E-1 (draft), E-2, E-4 (review), E-3 (live).
  assert.match(scope.matched, /tr ×4; identity at text:0 \("E-1", "E-2", "E-4", "E-3"\)/);
  assert.ok((scope.confidence ?? 0) > 0);

  // The forbidden attempt went to the entity that was already `live`, and before/after name it.
  const forbidden = t.observations.find((o) => o.label === "forbidden")!;
  assert.deepEqual(forbidden.before.flags, { state: "live", entity: "E-3" });
  assert.deepEqual(forbidden.after.flags, { state: "live", entity: "E-3" });
  assert.match(forbidden.actions.at(-1)!.detail ?? "", /entity "E-3"/);

  // The control moved a *different* entity, in the state it needs, and the untouched rows were never touched.
  const control = t.observations.find((o) => o.label === "allowed-control")!;
  assert.equal(control.controlOk, true);
  const touched = new Set(changes.map((c) => c.id));
  assert.ok(touched.has("E-3"));
  assert.ok(!touched.has("E-2") && !touched.has("E-4"), `rows that were never the subject changed: ${[...touched].join(",")}`);
});

test("scoped: rows re-sorting after the action do not lose the entity", { skip, timeout: 120_000 }, async () => {
  // Every successful move re-sorts the table, so the row we acted on changes position.
  const { trace, changes } = await discover({ enforce: true, reorder: true, start: [["E-1", "draft"], ["E-2", "draft"], ["E-3", "live"]] });
  const control = trace(RULE).observations.find((o) => o.label === "allowed-control")!;
  assert.equal(control.controlOk, true, control.note);
  // Two rows were in `draft`. One was chosen — the first, by identity, not by luck —
  // moved, re-sorted to a new position, and read back as the same entity.
  assert.deepEqual(control.before.flags, { state: "draft", entity: "E-1" });
  assert.deepEqual(control.after.flags, { state: "review", entity: "E-1" });
  assert.ok(changes.some((c) => c.id === "E-1" && c.to === "review"));
});

test("scoped: a page that breaks the rule is caught on the entity it was tried on", { skip, timeout: 120_000 }, async () => {
  const { trace, findings } = await discover({ enforce: false, reorder: true });
  const t = trace(RULE);
  assert.equal(t.verdict, "violated", t.stoppedBecause);
  const mine = findings.find((m) => /moving to "draft"/.test(m))!;
  assert.match(mine, /\(entity "E-3"\)/);
  assert.match(mine, /Trace:/);
  const forbidden = t.observations.find((o) => o.label === "forbidden")!;
  assert.deepEqual(forbidden.after.flags, { state: "draft", entity: "E-3" });
  assert.equal(forbidden.reproduced, true);
});

test("scoped: an entity that vanishes after the action is unknown — another row never stands in", { skip, timeout: 120_000 }, async () => {
  const { trace, findings } = await discover({ enforce: false, removeOnChange: true });
  const t = trace(RULE);
  assert.equal(t.verdict, "unknown");
  assert.equal(findings.length, 0, "a vanished row must not read as a violation or as a refusal");
  assert.equal(stage(t, "experiment_executed"), "failed");
  assert.match(t.stoppedBecause ?? "", /could not be re-identified after the action/);
  assert.match(t.stoppedBecause ?? "", /gone or its identity changed/);
});

test("scoped: repetitions with no identity stop at binding", { skip, timeout: 120_000 }, async () => {
  const { trace, findings } = await discover({ enforce: true, noIdentity: true });
  const t = trace(RULE);
  assert.equal(t.verdict, "unknown");
  assert.equal(findings.length, 0);
  assert.equal(stage(t, "runtime_bound"), "failed");
  assert.match(t.stoppedBecause ?? "", /entity scoping: .*nothing inside them tells one from another/);
});

test("scoped: an identity attribute regenerated on every render is re-found through the entity's other values", { skip, timeout: 120_000 }, async () => {
  const { trace, findings } = await discover({ enforce: true, reorder: true, randomIds: true });
  const t = trace(RULE);
  assert.equal(t.verdict, "preserved", t.stoppedBecause);
  assert.equal(findings.length, 0);
  const scope = t.binding!.find((b) => b.role === "entity_scope")!;
  assert.match(scope.matched, /identity at attr:id:/, "the random id is what the page offered first");
  const control = t.observations.find((o) => o.label === "allowed-control")!;
  assert.equal(control.controlOk, true, control.note);
  assert.equal(control.before.flags?.entity, control.after.flags?.entity);
});

test("scoped: a regenerated identity with nothing else to go on is unknown, never another row", { skip, timeout: 120_000 }, async () => {
  const { trace, findings, changes } = await discover({ enforce: true, reorder: true, randomIds: true, noIdentity: true });
  const t = trace(RULE);
  assert.equal(t.verdict, "unknown");
  assert.equal(findings.length, 0);
  assert.match(t.stoppedBecause ?? "", /gone or its identity changed|re-identified/);
  // Whatever was attempted, it was attempted on one row and nothing else was moved by mistake.
  assert.ok(new Set(changes.map((c) => c.id)).size <= 2);
});

// ---- a card list with a "smart" dropdown ------------------------------------

const img = '<img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">';
const card = (id: string, state: string, withImage: boolean, selectHtml: string) =>
  `<div class="card"><div><p>Item #${id}</p><p>someone · when</p></div><div>${selectHtml}</div><ul><li>${withImage ? img : ""}<span>thing</span></li></ul></div>`;

test("entities: cards that differ only by an optional image are still the same kind of thing", { skip, timeout: 60_000 }, async () => {
  const html = `<div id="list">${[
    card("A-1", "draft", true, sel("draft")),
    card("A-2", "review", false, sel("review")),
    card("A-3", "live", true, sel("live")),
  ].join("")}</div>`;
  const s = await withPage(html, (p) => surveyEntities(p, STATES));
  assert.equal(s.mode, "entities");
  assert.equal(s.shape, "div ×3");
  assert.equal(s.slot, "text:0/0");
  assert.deepEqual(s.entities?.map((e) => e.value), ["Item #A-1", "Item #A-2", "Item #A-3"]);
});

test("entities: a filter dropdown of states beside a list of cards is not mistaken for an entity", { skip, timeout: 60_000 }, async () => {
  const html =
    `<div><label>Show only ${sel("draft")}</label></div>` +
    `<div id="list">${[card("A-1", "draft", true, sel("draft")), card("A-2", "review", false, sel("review"))].join("")}</div>`;
  const s = await withPage(html, (p) => surveyEntities(p, STATES));
  assert.equal(s.mode, "ambiguous");
  assert.match(s.reason ?? "", /regions that are not alike/);
});

function smartCardsPage(): string {
  return `<!doctype html><title>cards</title><div id="cards"></div>
<script>
  const ok = JSON.parse('{"draft":["review"],"review":["live"],"live":[]}');
  let items = [
    { id: "A-1", st: "draft", img: true }, { id: "A-2", st: "review", img: false },
    { id: "A-3", st: "live", img: true }, { id: "A-4", st: "draft", img: false },
  ];
  const root = document.getElementById("cards");
  function render() {
    root.innerHTML = items.map((i, n) => {
      const opts = [i.st, ...ok[i.st]].map((o) => "<option" + (o === i.st ? " selected" : "") + ">" + o + "</option>").join("");
      return '<div class="card"><div><p>Item #' + i.id + "</p><p>someone · when</p></div><div>" +
        '<select data-n="' + n + '"' + (ok[i.st].length === 0 ? " disabled" : "") + ">" + opts + "</select></div>" +
        "<ul><li>" + (i.img ? '${img.replace(/'/g, "\'")}' : "") + "<span>thing</span></li></ul></div>";
    }).join("");
  }
  root.addEventListener("change", (e) => { items[Number(e.target.getAttribute("data-n"))].st = e.target.value; render(); });
  render();
</script>`;
}

test(
  "scoped: a list whose dropdowns only offer valid moves cannot be asked — every rule is unknown, none is a finding",
  { skip, timeout: 180_000 },
  async () => {
    const all: EvidenceChunk = { ...SOURCE, changedLines: [2, 3, 4] };
    const { res, findings } = await withPage(smartCardsPage(), async (page) => {
      const bus = new EventBus();
      const found: string[] = [];
      bus.on("telemetry", (p) => found.push(p.rawMessage));
      return { res: await invariantDiscovery(page, bus, { extraEvidence: [all], maxCandidates: 10 }), findings: found };
    });
    assert.equal(findings.length, 0);
    assert.ok(res.traces.length >= 4);
    for (const t of res.traces) {
      assert.equal(t.verdict, "unknown", `${t.candidate.id}: ${t.stoppedBecause}`);
      // Bound (the page is understood as cards), but the rule's own move cannot be attempted.
      assert.equal(stage(t, "runtime_bound"), "ok", `${t.candidate.id}: ${t.stoppedBecause}`);
      assert.equal(stage(t, "experiment_executed"), "failed");
      assert.match(t.stoppedBecause ?? "", /not offered: the select offers no option|the select is disabled/);
      assert.ok(t.binding!.some((b) => b.role === "entity_scope" && /div ×4/.test(b.matched)));
    }
  }
);
