import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { extractFrame, extractServerFrame, resolveFrame } from "../src/core/resolver.js";

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
