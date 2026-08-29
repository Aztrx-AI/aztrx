/**
 * F13 — the only place Aztrx writes a verified patch into the user's *working
 * tree*. Healing itself stays sandboxed (see `index.ts`); this module is the
 * explicit, opt-in "apply" step behind `--fix`, so the recipe's promised
 * `git diff` shows real changes.
 *
 * Rules that keep this safe:
 *   - Only findings whose heal result is `healed` (verified: bug gone) are applied.
 *   - The file is re-read *per finding* (several findings can touch one file),
 *     and each patch is applied with exact-match hunks. A mismatch is a conflict
 *     and is skipped — its `.patch` artifact stays for manual review.
 *   - Paths are confined to `repoRoot`; anything escaping it is refused.
 *   - Aztrx never commits. This writes working-tree files only.
 */

import * as fs from "fs";
import * as path from "path";
import type { Finding } from "../types.js";
import { applyHunks } from "./sandbox.js";

export interface AppliedPatch {
  filePath: string;
  hunkCount: number;
}

export interface ApplyConflict {
  filePath: string;
  error: string;
}

export interface ApplySummary {
  applied: AppliedPatch[];
  conflicts: ApplyConflict[];
}

export function applyVerifiedPatches(repoRoot: string, findings: Finding[]): ApplySummary {
  const applied: AppliedPatch[] = [];
  const conflicts: ApplyConflict[] = [];
  const root = path.resolve(repoRoot);

  for (const f of findings) {
    if (f.heal?.status !== "healed") continue;
    const filePath = f.heal.filePath;
    if (!filePath) {
      conflicts.push({ filePath, error: "no source file recorded" });
      continue;
    }

    const abs = path.resolve(root, filePath);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      conflicts.push({ filePath, error: `refusing to write outside repo: ${filePath}` });
      continue;
    }

    let current: string;
    try {
      current = fs.readFileSync(abs, "utf-8");
    } catch (e) {
      conflicts.push({ filePath, error: `cannot read: ${(e as Error).message}` });
      continue;
    }

    const result = applyHunks(current, f.heal.hunks);
    if (!result.ok) {
      conflicts.push({ filePath, error: result.errors.join("; ") });
      continue;
    }

    fs.writeFileSync(abs, result.patched, "utf-8");
    applied.push({ filePath, hunkCount: result.applied });
  }

  return { applied, conflicts };
}
