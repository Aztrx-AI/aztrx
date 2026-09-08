import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { captureReproFrames, encodeGif, crashFrame } from "../src/core/patrol/record.js";
import type { RecordedAction } from "../src/core/types.js";

const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(root, "..", "fixtures", "crash-demo.html"));

// Serve the fixture on an ephemeral port.
const server = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(html);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
const port = (server.address() as { port: number }).port;
const url = `http://127.0.0.1:${port}/`;

// The repro is a single click on the crashing button.
const actions: RecordedAction[] = [{ type: "click", selectors: ["#pay"], timestamp: Date.now() }];

const frames = await captureReproFrames(url, actions, {
  viewport: { width: 720, height: 430 },
  settleMs: 800,
  stepMs: 700,
});
server.close();

const gif = encodeGif(frames, { delay: 800 });
const shot = crashFrame(frames);

const outDir = resolve(root, "..", "media", "repro-demo");
mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, "crash.gif"), gif);
writeFileSync(resolve(outDir, "crash.png"), shot);
frames.forEach((f, i) => writeFileSync(resolve(outDir, `frame_${i}.png`), f));

console.log(`frames: ${frames.length}`);
console.log(`gif:    ${gif.length} bytes -> ${resolve(outDir, "crash.gif")}`);
console.log(`png:    ${shot.length} bytes -> ${resolve(outDir, "crash.png")}`);
