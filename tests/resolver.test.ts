import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { extractFrame, extractServerFrame, reanchorPosition, resolveFrame } from "../src/core/resolver.js";

test("extractFrame pulls the about://React/Server throw site", () => {
  const stack = [
    "Error: Order submit failed: quota exceeded",
    "    at placeOrder (about://React/Server/C:%5Capp%5Cactions.ts?2:33:11)",
    "    at resolveErrorDev (http://localhost:3000/_next/static/chunks/node_modules_next_dist_compiled_react-server-dom-turbopack_123._.js:1937:105)",
  ].join("\n");
  const frame = extractFrame(stack);
  assert.ok(frame, "expected a frame");
  assert.equal(frame.url, "about://React/Server/C:%5Capp%5Cactions.ts?2");
  assert.equal(frame.line, 33);
  assert.equal(frame.column, 11);
});

test("extractServerFrame skips node_modules and takes the first own frame", () => {
  const stack = [
    "at resolveErrorDev (/app/node_modules/next/dist/server.js:10:5)",
    "at placeOrder (/app/app/actions.ts:7:8)",
  ].join("\n");
  const frame = extractServerFrame(stack);
  assert.ok(frame, "expected a server frame");
  assert.equal(frame.filePath, "/app/app/actions.ts");
  assert.equal(frame.line, 7);
});

test("resolveFrame maps a Server Action throw site through its sourcemap", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-resolve-"));

  const actionsPath = path.join(root, "app", "actions.ts");
  fs.mkdirSync(path.dirname(actionsPath), { recursive: true });
  fs.writeFileSync(
    actionsPath,
    [
      '"use server";',
      "",
      "export async function placeOrder() {",
      "  // Server Action that always fails.",
      '  throw new Error("Order submit failed: quota exceeded");',
      "}",
      "",
    ].join("\n"),
    "utf-8"
  );

  const chunkPath = path.join(root, "chunks", "_chunk.js");
  fs.mkdirSync(path.dirname(chunkPath), { recursive: true });
  fs.writeFileSync(chunkPath, "", "utf-8");

  // A minimal sourcemap: generated (1,0) → source line 5 (`AAIA` = src line 4,
  // 0-indexed). Turbopack emits `file:///` sources in its sectioned maps.
  fs.writeFileSync(
    chunkPath + ".map",
    JSON.stringify({
      version: 3,
      sources: [pathToFileURL(actionsPath).href],
      names: [],
      mappings: "AAIA",
    }),
    "utf-8"
  );

  const url = "about://React/Server/" + encodeURIComponent(chunkPath) + "?2";
  const resolved = await resolveFrame({ url, line: 1, column: 0, message: "Order submit failed: quota exceeded" }, root);

  assert.equal(resolved.resolvedFrom, "sourcemap");
  assert.equal(path.normalize(resolved.sourceFile), path.normalize(path.join("app", "actions.ts")));
  assert.equal(resolved.line, 5);
  assert.match(resolved.codeSnippet, /quota exceeded/);
});

test("resolveFrame maps an inline-script frame (root URL) to index.html", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aztrx-resolve-"));
  const lines = [
    "<!doctype html>",
    "<html>",
    "<body>",
    "  <div id=\"app\"></div>",
    "  <script>",
    "    async function loadUsers() {",
    "      const res = await fetch('/api/users');",
    "      const json = await res.json();",
    "      json.users.map(u => u.name);",
    "    }",
    "    loadUsers();",
    "  </script>",
    "</body>",
    "</html>",
    "",
  ];
  fs.writeFileSync(path.join(root, "index.html"), lines.join("\n"), "utf-8");

  // V8 reports an inline <script> throw with the page URL as the frame URL.
  const resolved = await resolveFrame(
    { url: "http://localhost:3000/", line: 9, column: 6, message: "Cannot read properties of undefined (reading 'map')" },
    root
  );

  assert.equal(resolved.resolvedFrom, "direct");
  assert.equal(path.normalize(resolved.sourceFile), "index.html");
  assert.match(resolved.codeSnippet, /json\.users\.map/);
});

/**
 * The `webpack-internal://` re-anchoring. Every fixture below is the shape a
 * real Next.js dev stack produced on `agentbridge` — the frame named the right
 * file and a line from webpack's generated module, which is not the line in the
 * `.tsx` on disk.
 */

test("reanchorPosition finds the throw site a webpack-internal frame got wrong", () => {
  // Real case: reported app/page.tsx:29:21, actual line 15. Line 9 also reads
  // `.agents`, but optional-chained — it cannot have thrown.
  const content = [
    "  fetchAgents().then((d) => setAgents(d?.agents ?? []));", // 1
    "", // 2
    "  const handleRefresh = async () => {", // 3
    "    // BUG: `d` is undefined when the refresh fails.", // 4
    "    const d = await fetchAgents();", // 5
    "    setAgents(d.agents.map((a: any) => a));", // 6
    "  };", // 7
    "    </div>", // 8
  ].join("\n");
  const at = reanchorPosition(content, 8, 21, "Cannot read properties of undefined (reading 'agents')");
  assert.equal(at.line, 6, "must land on the unguarded read, not the guarded one or the mapped line");
  assert.equal(at.column, content.split("\n")[5].indexOf(".agents") + 1);
});

test("reanchorPosition ignores a property named only in a comment", () => {
  // Real case: the line above the bug is a comment spelling out `.ok`.
  const content = [
    "    // BUG: `result` is undefined on a failed test → .ok throws.", // 1
    "    setStatus((s) => ({ ...s, [id]: result.ok ? 'connected' : 'failed' }));", // 2
    "  });", // 3
    "    </div>", // 4
  ].join("\n");
  const at = reanchorPosition(content, 4, 30, "Cannot read properties of undefined (reading 'ok')");
  assert.equal(at.line, 2);
});

test("reanchorPosition leaves an already-correct line alone", () => {
  const content = "    const payload = { name, model: model.toLowerCase() };\n    return payload;\n";
  const at = reanchorPosition(content, 1, 26, "Cannot read properties of null (reading 'toLowerCase')");
  assert.equal(at.line, 1);
  assert.equal(at.column, 26, "a correct position is returned untouched");
});

test("reanchorPosition does not guess when the property is ambiguous", () => {
  // Two unguarded reads and no way to tell which threw: keep the mapped
  // position rather than move the snippet to a confident wrong answer.
  const content = "  a.thing();\n  b.thing();\n";
  const at = reanchorPosition(content, 2, 5, "Cannot read properties of undefined (reading 'thing')");
  assert.equal(at.line, 2);
  assert.equal(at.column, 5);
});

test("reanchorPosition only fires on a null-deref message", () => {
  // `qty.toFixed is not a function` names no property being read, so there is
  // nothing to re-anchor with — the mapped line stands.
  const content = "    qty.toFixed(2);\n    </div>\n";
  const at = reanchorPosition(content, 2, 9, "qty.toFixed is not a function");
  assert.equal(at.line, 2);
});
