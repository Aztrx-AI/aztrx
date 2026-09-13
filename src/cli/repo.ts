import * as fs from "fs";
import path from "path";
import pc from "picocolors";

/**
 * `--repo` is checked, not trusted.
 *
 * Commander consumes a `<required>` option argument even when the argument
 * *looks like a flag*: `aztrx run --repo --fix` sets `repo` to the literal
 * string `--fix` — measured against commander 12 rather than assumed. From
 * there `path.resolve` turns it into `<cwd>/--fix`, and the first
 * `mkdirSync(..., { recursive: true })` on the run path is happy to create it.
 * So a mistyped invocation does not fail, it *succeeds* — against a project
 * directory the tool invented — and leaves its `.aztrx/` artifacts inside.
 *
 * That is not hypothetical: `C:\Users\dchap\--fix\` existed holding nothing but
 * `.aztrx/`, which is exactly this. An empty directory nobody can explain is a
 * worse failure than an error message, because nothing reports it.
 */

/** Why `dir` cannot serve as a project root, or null when it can. Pure, so the
 * wording is testable without spawning a process — the caller prints and exits. */
export function repoPathProblem(dir: string): string | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(dir);
  } catch {
    // A path whose last segment is itself a flag is the signature of the option
    // having eaten one, and saying so beats leaving the user to re-read their
    // own command line for it.
    const base = path.basename(dir);
    if (base.startsWith("-")) {
      return (
        `no such directory: ${dir}\n` +
        `  \`${base}\` looks like a flag, not a path — did it get taken as the value of \`--repo\`?`
      );
    }
    return `no such directory: ${dir}`;
  }
  if (!st.isDirectory()) return `not a directory: ${dir}`;
  return null;
}

/** Absolute, existing project root — or exit 1 with the reason. */
export function resolveRepoRoot(raw: string | undefined, cwd: string = process.cwd()): string {
  const dir = path.resolve(cwd, raw ?? ".");
  const problem = repoPathProblem(dir);
  if (problem) {
    console.error(pc.red("✗ ") + problem);
    process.exit(1);
  }
  return dir;
}
