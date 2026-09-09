import { test } from "node:test";
import assert from "node:assert/strict";
import { isLocalUrl, branchForSet, githubRawUrl } from "../src/core/patrol/pr.js";

test("isLocalUrl treats loopback and private ranges as local", () => {
  assert.equal(isLocalUrl("http://localhost:3000"), true);
  assert.equal(isLocalUrl("http://127.0.0.1:8080"), true);
  assert.equal(isLocalUrl("http://127.5.4.3"), true);
  assert.equal(isLocalUrl("http://0.0.0.0:3000"), true);
  // RFC1918 private ranges are dev boxes, not production.
  assert.equal(isLocalUrl("https://10.0.0.5"), true);
  assert.equal(isLocalUrl("https://172.16.0.1"), true);
  assert.equal(isLocalUrl("https://172.31.255.254"), true);
  assert.equal(isLocalUrl("https://192.168.1.10"), true);
  // Link-local + mDNS / internal suffixes.
  assert.equal(isLocalUrl("http://169.254.10.10"), true);
  assert.equal(isLocalUrl("http://my-machine.local:5173"), true);
  assert.equal(isLocalUrl("http://svc.internal"), true);
  // Publicly-routable hosts are production.
  assert.equal(isLocalUrl("https://app.example.com"), false);
  assert.equal(isLocalUrl("https://8.8.8.8"), false);
  assert.equal(isLocalUrl("https://172.15.0.1"), false); // just outside 172.16/12
  // Unparseable → assume local rather than scare-mongering.
  assert.equal(isLocalUrl("not a url"), true);
});

test("branchForSet is stable across order and varies with the set", () => {
  const a = branchForSet(["fp-1", "fp-2", "fp-3"]);
  const b = branchForSet(["fp-3", "fp-1", "fp-2"]);
  assert.equal(a, b);
  assert.match(a, /^aztrx\/fix-batch-[0-9a-f]{8}$/);
  assert.notEqual(a, branchForSet(["fp-1", "fp-2"]));
});

test("githubRawUrl handles https, ssh, scp-style, and .git remotes", () => {
  const path = "aztrx-media/deadbeef.gif";
  assert.equal(
    githubRawUrl("https://github.com/Aztrx-AI/aztrx.git", "main", path),
    "https://github.com/Aztrx-AI/aztrx/raw/main/aztrx-media/deadbeef.gif"
  );
  assert.equal(
    githubRawUrl("git@github.com:Aztrx-AI/aztrx.git", "fix/x", path),
    "https://github.com/Aztrx-AI/aztrx/raw/fix/x/aztrx-media/deadbeef.gif"
  );
  assert.equal(
    githubRawUrl("ssh://git@github.com/Aztrx-AI/aztrx", "main", path),
    "https://github.com/Aztrx-AI/aztrx/raw/main/aztrx-media/deadbeef.gif"
  );
  // Non-GitHub remotes (or trailing newline junk) yield "" — the image is just not inlined.
  assert.equal(githubRawUrl("https://gitlab.com/o/r.git", "main", path), "");
  assert.equal(githubRawUrl("", "main", path), "");
});
