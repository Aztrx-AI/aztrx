/**
 * A single yes/no confirmation for `--fix`. Kept tiny and side-effect free:
 *
 *   - `--yes` short-circuits to `true` (scripts/CI).
 *   - a non-TTY stdout without `--yes` short-circuits to `false` — an unattended
 *     run never mutates the working tree, it just leaves the `.patch` files.
 *   - otherwise prompts on stdin, defaulting to "no".
 */

import * as readline from "readline";

export interface PromptOptions {
  yes?: boolean;
}

export function promptYesNo(question: string, opts: PromptOptions = {}): Promise<boolean> {
  if (opts.yes === true) return Promise.resolve(true);
  if (process.stdout.isTTY !== true) return Promise.resolve(false);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question + " ", (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

/** A single-line text prompt. Returns "" when stdout isn't a TTY (unattended run). */
export function promptInput(question: string): Promise<string> {
  if (process.stdout.isTTY !== true) return Promise.resolve("");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question + " ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
