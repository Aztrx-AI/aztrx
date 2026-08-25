import { createHash } from "crypto";
import type { OrgKey } from "./types.js";

/**
 * Org + API-key validation. Keys are indexed by their SHA-256 digest so a key
 * never sits in memory or on disk in the clear, and a presented key is resolved
 * with one hash + one map lookup. A key that wasn't provisioned simply has no
 * entry and resolves to null (401 upstream).
 */

const digest = (key: string): string => createHash("sha256").update(key).digest("hex");

export function buildKeyIndex(keys: Record<string, OrgKey>): Map<string, OrgKey> {
  const index = new Map<string, OrgKey>();
  for (const [key, meta] of Object.entries(keys)) index.set(digest(key), meta);
  return index;
}

export function resolveOrg(index: Map<string, OrgKey>, presented: string | undefined): OrgKey | null {
  if (!presented) return null;
  return index.get(digest(presented)) ?? null;
}
