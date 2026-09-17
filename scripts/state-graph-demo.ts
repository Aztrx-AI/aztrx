/**
 * State-Graph demo — run the Mapper against a target and print the state tree.
 * Usage: npx tsx scripts/state-graph-demo.ts [url] [--dry-run]
 * Default target: the stateful SPA fixture (needs `node fixtures/serve.mjs`).
 */

import { chromium } from "playwright";
import { buildStateGraph } from "../src/core/mapper.js";

async function main() {
  const url = process.argv[2] ?? "http://localhost:8901/stateful.html";
  const dryRun = process.argv.includes("--dry-run");

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);

  const graph = await buildStateGraph(page, url, {
    maxStates: 15,
    maxActionsPerState: 8,
    dryRun,
    log: (m) => process.stderr.write(`  ${m}\n`),
  });

  process.stderr.write("\n=== STATE TREE ===\n");
  process.stderr.write(graph.printTree() + "\n");
  process.stderr.write(`\n${graph.size} state(s), ${graph.getEdgeCount()} edge(s)\n`);

  await browser.close();
}

void main();
