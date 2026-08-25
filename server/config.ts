import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { OrgKey } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface Config {
  port: number;
  /** Directory the JSON-file store writes into. */
  dataDir: string;
  /** apiKey → org mapping. Empty means deny-all (only /health is reachable). */
  keys: Record<string, OrgKey>;
}

function parseKeys(raw: string): Record<string, OrgKey> {
  const parsed = JSON.parse(raw) as Record<string, OrgKey>;
  for (const [key, meta] of Object.entries(parsed)) {
    if (!key || typeof meta !== "object" || meta === null || typeof meta.org !== "string" || !meta.org) {
      throw new Error("API keys must map apiKey → { org: string, label?: string }");
    }
  }
  return parsed;
}

/**
 * Load config from the environment. Keys come from `AZTRX_API_KEYS` (a JSON
 * object) or, when that's unset, a `server/keys.json` file next to this module.
 * The file form is the operator-managed registry; `keys.example.json` documents
 * its shape and the real file is gitignored.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env.AZTRX_DATA_DIR ?? path.join(__dirname, ".data"));
  const keysFile = path.join(__dirname, "keys.json");

  let keys: Record<string, OrgKey> = {};
  const envKeys = env.AZTRX_API_KEYS;
  if (envKeys) {
    keys = parseKeys(envKeys);
  } else if (fs.existsSync(keysFile)) {
    keys = parseKeys(fs.readFileSync(keysFile, "utf-8"));
  }

  const port = Number.parseInt(env.AZTRX_PORT ?? "8787", 10);
  return { port, dataDir, keys };
}
