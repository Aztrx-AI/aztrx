/**
 * Child-process environment isolation. The heal sandbox runs the project's own
 * test suite, `tsc`, and dev server — which means it executes untrusted PR code.
 * Handing that code the full `process.env` would leak the caller's secrets
 * (ANTHROPIC_API_KEY, GH_TOKEN, NPM_TOKEN, AWS_*, …) into a process the PR author
 * controls. Children therefore get only a minimal allow-list of harmless,
 * platform-essential variables.
 *
 * Escape hatch: a caller whose dev server legitimately needs app config (e.g.
 * `DATABASE_URL`) can pass it through by naming it in `AZTRX_ENV_ALLOW`
 * (comma-separated) — without re-opening the leak for every secret in the env.
 */

const ALLOWED = new Set([
  "PATH",
  "HOME",
  "USER",
  "USERNAME",
  "LOGNAME",
  "SHELL",
  "TMP",
  "TEMP",
  "TMPDIR",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "COMSPEC",
  "PATHEXT",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "NODE_ENV",
  "CI",
  "PORT",
]);

/** Build a minimal child environment: harmless platform vars, anything named in
 * `AZTRX_ENV_ALLOW`, and any caller-supplied `extra` (e.g. `{ PORT: "4317" }`). */
export function buildChildEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ALLOWED) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }

  const allow = process.env.AZTRX_ENV_ALLOW;
  if (allow) {
    for (const raw of allow.split(",")) {
      const name = raw.trim();
      if (!name) continue;
      const v = process.env[name];
      if (v !== undefined) env[name] = v;
    }
  }

  if (extra) for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}
