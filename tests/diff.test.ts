import { test } from "node:test";
import assert from "node:assert/strict";
import { diffText, diffHunks } from "../src/core/diff.js";
import type { DiffLine } from "../src/core/diff.js";

/** Reconstruct the full line text from a diff line's tokens. */
function text(l: DiffLine): string {
  return l.tokens.map((t) => t.text).join("");
}

function texts(lines: DiffLine[]): string[] {
  return lines.map(text);
}

function kinds(l: DiffLine): string[] {
  return l.tokens.map((t) => t.kind);
}

test("pure insertion highlights the inserted text on the add line only", () => {
  const lines = diffText("const x = foo.bar;", "const x = foo?.bar;");
  const del = lines.filter((l) => l.type === "del");
  const add = lines.filter((l) => l.type === "add");

  assert.equal(del.length, 1);
  assert.equal(add.length, 1);
  assert.equal(texts(del)[0], "const x = foo.bar;");
  assert.equal(texts(add)[0], "const x = foo?.bar;");

  // Nothing was removed — the del line carries no highlight token…
  assert.ok(kinds(del[0]).every((k) => k === "ctx"));
  // …and the inserted `?` is marked on the add line.
  const inserted = add[0].tokens.find((t) => t.kind === "add");
  assert.ok(inserted, "marks an inserted span");
  assert.equal(inserted!.text, "?");
});

test("replacement highlights the changed region on both lines", () => {
  const lines = diffText("const city = user.address.city;", "const city = user?.address?.city;");
  const del = lines.find((l) => l.type === "del")!;
  const add = lines.find((l) => l.type === "add")!;

  assert.equal(text(del), "const city = user.address.city;");
  assert.equal(text(add), "const city = user?.address?.city;");
  assert.ok(del.tokens.some((t) => t.kind === "del"), "removed span marked");
  assert.ok(add.tokens.some((t) => t.kind === "add"), "added span marked");
});

test("multi-line hunk omits common lines and pairs the changed one", () => {
  const oldText = "function bad() {\n  return foo.bar;\n}";
  const newText = "function bad() {\n  return foo?.bar;\n}";
  const lines = diffText(oldText, newText);

  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, "del");
  assert.equal(lines[1].type, "add");
  assert.equal(text(lines[0]), "  return foo.bar;");
  assert.equal(text(lines[1]), "  return foo?.bar;");
});

test("whole-line deletion is a single full-context del line", () => {
  const lines = diffText("line1\nline2\nline3", "line1\nline3");
  const del = lines.filter((l) => l.type === "del");

  assert.equal(del.length, 1);
  assert.equal(text(del[0]), "line2");
  assert.ok(kinds(del[0]).every((k) => k === "ctx"));
  assert.equal(lines.filter((l) => l.type === "add").length, 0);
});

test("whole-line insertion is a single full-context add line", () => {
  const lines = diffText("line1\nline3", "line1\nline2\nline3");
  const add = lines.filter((l) => l.type === "add");

  assert.equal(add.length, 1);
  assert.equal(text(add[0]), "line2");
  assert.equal(lines.filter((l) => l.type === "del").length, 0);
});

test("reconstructed token text always equals the source line", () => {
  const oldText = "a\nkeep me\nb\nc";
  const newText = "a\nkeep me\nB\nc\nD";
  const lines = diffText(oldText, newText);

  for (const l of lines) {
    const reconstructed = text(l);
    if (l.type === "del") assert.ok(oldText.split("\n").includes(reconstructed));
    else assert.ok(newText.split("\n").includes(reconstructed));
  }
});

test("trailing newline does not emit a phantom blank line", () => {
  const lines = diffText("foo();\n", "foo?.();\n");
  // A trailing "\n" would surface as an empty del/add pair if mishandled.
  assert.ok(lines.every((l) => text(l) !== ""), "no empty diff lines");
});

test("diffHunks returns one group per hunk", () => {
  const groups = diffHunks([
    { search: "a", replace: "b" },
    { search: "c", replace: "d" },
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].map(text), ["a", "b"]);
  assert.deepEqual(groups[1].map(text), ["c", "d"]);
});
