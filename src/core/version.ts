import { readFileSync } from "fs";
import { fileURLToPath } from "url";

// Single source of truth for the CLI's self-reported version. Read from the
// installed package.json so a future `npm version` bump never drifts from the
// printed banner — a hardcoded "v0.1.1" previously survived the 0.2.0 bump.
function readVersion(): string {
  try {
    const url = new URL("../../package.json", import.meta.url);
    return JSON.parse(readFileSync(fileURLToPath(url), "utf-8")).version as string;
  } catch {
    return "0.0.0"; // cosmetic only — package.json not resolvable (raw dist/ checkout)
  }
}

export const VERSION = readVersion();
