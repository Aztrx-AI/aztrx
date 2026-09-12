/**
 * `aztrx-cli mcp install` — write the editor config that starts this server.
 *
 * This mirrors the discipline of `hook install` (`src/hooks/index.ts`), with one
 * difference that changes everything: an MCP config file is **shared with other
 * servers**. A hook file is ours; `.mcp.json` is not. So this never writes a whole
 * file, it edits one key inside one — read, parse, add, write back — and it
 * refuses rather than clobbers when the file will not parse. A refused install is
 * a message the user can act on; a clobbered config is their other three servers
 * gone, discovered a week later.
 */

import * as fs from "fs";
import * as path from "path";

/** The key our server lives under. Also the marker we look for on uninstall. */
export const MCP_SERVER_NAME = "aztrx";

export interface EditorTarget {
  id: string;
  label: string;
  /** Path relative to the repo root. */
  file: string;
  /** The key the servers live under. VS Code's differs, and conflating the two
   * produces a file that editor reads as having no servers in it at all. */
  key: string;
  /** Only offered when this path exists. An editor the project does not use
   * should be reported as skipped, not written to. */
  marker?: string;
}

export const TARGETS: EditorTarget[] = [
  // Always offered: `.mcp.json` at the repo root is the portable form, and a
  // project that has not opened Claude Code yet can still commit one.
  { id: "claude-code", label: "Claude Code", file: ".mcp.json", key: "mcpServers" },
  {
    id: "cursor",
    label: "Cursor",
    file: ".cursor/mcp.json",
    key: "mcpServers",
    marker: ".cursor",
  },
  { id: "vscode", label: "VS Code", file: ".vscode/mcp.json", key: "servers", marker: ".vscode" },
];

/** What each editor runs.
 *
 * Pinned to this build's version, so upgrading the CLI is upgrading the server —
 * a config that says `aztrx-cli@latest` would silently change under the user.
 * `npx -y` because an editor spawns this from a fresh shell with no PATH set up
 * for the project. */
export function serverEntry(version: string): Record<string, unknown> {
  return { type: "stdio", command: "npx", args: ["-y", `aztrx-cli@${version}`, "mcp"] };
}

export type ConfigStatus = "written" | "unchanged" | "skipped" | "refused";

export interface ConfigOutcome {
  target: EditorTarget;
  status: ConfigStatus;
  path: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Reading and writing JSON without losing what is already there
// ---------------------------------------------------------------------------

type Loaded = { ok: true; doc: Record<string, unknown> } | { ok: false; error: string };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function loadJson(abs: string): Loaded {
  if (!fs.existsSync(abs)) return { ok: true, doc: {} };
  let raw: string;
  try {
    raw = fs.readFileSync(abs, "utf-8");
  } catch (e) {
    return { ok: false, error: `it cannot be read: ${(e as Error).message}` };
  }
  // An empty file is an empty config, not a syntax error — `.mcp.json` gets
  // created by hand as often as by a tool.
  if (!raw.trim()) return { ok: true, doc: {} };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    // V8's message starts with a capital and is spliced into the middle of our
    // sentence ("… exists and Expected double-quoted property name …").
    const msg = (e as Error).message;
    return { ok: false, error: msg.charAt(0).toLowerCase() + msg.slice(1) };
  }
  if (!isObject(value)) return { ok: false, error: "its top level is not a JSON object" };
  return { ok: true, doc: value };
}

/** Copy the file aside before an overwrite we could not parse.
 *
 * Best effort on purpose. The refusal above is the safety; this is the kindness —
 * a JSON syntax error is usually one missing comma, and the user's other servers
 * are in there. */
function backup(abs: string): string | null {
  const dest = `${abs}.bak`;
  try {
    fs.copyFileSync(abs, dest);
    return dest;
  } catch {
    return null;
  }
}

function writeJson(abs: string, doc: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(doc, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// install / uninstall
// ---------------------------------------------------------------------------

export function installInto(
  repoRoot: string,
  target: EditorTarget,
  version: string,
  force = false
): ConfigOutcome {
  const abs = path.join(repoRoot, target.file);

  if (target.marker && !fs.existsSync(path.join(repoRoot, target.marker))) {
    return {
      target,
      status: "skipped",
      path: abs,
      message: `no ${target.marker}/ in this project`,
    };
  }

  const loaded = loadJson(abs);
  // Unparseable and forced → start from empty rather than from the broken parse.
  let doc: Record<string, unknown> = loaded.ok ? loaded.doc : {};
  let note = "";

  if (!loaded.ok) {
    if (!force) {
      return {
        target,
        status: "refused",
        path: abs,
        message:
          `${target.file} exists and ${loaded.error} — refusing to overwrite it, because any ` +
          "other MCP servers in it would go too. Fix the file, or pass --force (which saves a " +
          ".bak first).",
      };
    }
    const saved = backup(abs);
    note = saved ? ` (previous contents saved to ${path.basename(saved)})` : "";
  }

  const existing = doc[target.key];
  if (existing !== undefined && !isObject(existing)) {
    if (!force) {
      return {
        target,
        status: "refused",
        path: abs,
        message: `${target.file} has a \`${target.key}\` key that is not an object — refusing to overwrite it.`,
      };
    }
    const saved = backup(abs);
    note = saved ? ` (previous contents saved to ${path.basename(saved)})` : "";
    // Drop just the malformed key. Everything else at the top level of the file
    // — `$schema`, an editor's other settings — is still readable and still the
    // user's, so only the key we cannot merge into is discarded.
    delete doc[target.key];
  }

  const slot = doc[target.key];
  const servers: Record<string, unknown> = isObject(slot) ? slot : {};
  const hadOurs = MCP_SERVER_NAME in servers;
  servers[MCP_SERVER_NAME] = serverEntry(version);
  doc[target.key] = servers;

  const next = JSON.stringify(doc, null, 2) + "\n";
  const current = fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : null;
  if (current === next) {
    return { target, status: "unchanged", path: abs, message: `${target.file} is already up to date` };
  }

  writeJson(abs, doc);

  const others = Object.keys(servers).filter((k) => k !== MCP_SERVER_NAME).length;
  const kept = others
    ? ` ${others} other server${others === 1 ? "" : "s"} in the file left untouched.`
    : "";
  return {
    target,
    status: "written",
    path: abs,
    message: `${target.file} — ${hadOurs ? "updated" : "added"}.${kept}${note}`,
  };
}

export function uninstallFrom(repoRoot: string, target: EditorTarget): ConfigOutcome {
  const abs = path.join(repoRoot, target.file);
  const rel = target.file;

  if (!fs.existsSync(abs)) {
    return { target, status: "skipped", path: abs, message: `no ${rel}` };
  }

  const loaded = loadJson(abs);
  if (!loaded.ok) {
    return {
      target,
      status: "refused",
      path: abs,
      message: `${rel} ${loaded.error} — leaving it alone.`,
    };
  }

  const servers = loaded.doc[target.key];
  if (!isObject(servers) || !(MCP_SERVER_NAME in servers)) {
    return { target, status: "skipped", path: abs, message: `no aztrx entry in ${rel}` };
  }

  delete servers[MCP_SERVER_NAME];
  // The file stays even when that leaves the map empty. Deleting a file we did
  // not create, on the strength of it looking empty afterwards, is a worse
  // failure than four bytes of leftover JSON.
  writeJson(abs, loaded.doc);
  return {
    target,
    status: "written",
    path: abs,
    message: `${rel} — aztrx entry removed (the file is kept: other servers may live in it).`,
  };
}

export interface InstallSummary {
  outcomes: ConfigOutcome[];
  /** True when at least one file was written. */
  changed: boolean;
  /** True when every target was skipped or refused — nothing to tell the user
   * about beyond what the individual messages already say. */
  nothingDone: boolean;
}

export function installMcp(repoRoot: string, version: string, force = false): InstallSummary {
  const outcomes = TARGETS.map((t) => installInto(repoRoot, t, version, force));
  return {
    outcomes,
    changed: outcomes.some((o) => o.status === "written"),
    nothingDone: outcomes.every((o) => o.status === "skipped" || o.status === "refused"),
  };
}

export function uninstallMcp(repoRoot: string): InstallSummary {
  const outcomes = TARGETS.map((t) => uninstallFrom(repoRoot, t));
  return {
    outcomes,
    changed: outcomes.some((o) => o.status === "written"),
    nothingDone: outcomes.every((o) => o.status === "skipped" || o.status === "refused"),
  };
}

/** Does a target's config file exist at all? Used by the CLI to decide whether a
 * refusal is worth a non-zero exit — a project with none of these files is not an
 * error, it is a project that does not use an editor we know about. */
export function targetExists(repoRoot: string, target: EditorTarget): boolean {
  return fs.existsSync(path.join(repoRoot, target.file));
}
