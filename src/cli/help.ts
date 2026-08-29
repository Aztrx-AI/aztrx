import { Command, Help, Option } from "commander";

/**
 * Intent-grouped `--help` for the `run` command. Commander v12 has no native
 * option grouping, so we tag each Option with a group and render the sections
 * ourselves (reusing commander's own term/description/wrap helpers for a
 * consistent look).
 *
 * The goal is a funnel the user can actually remember — Detect / Prove / Fix /
 * Report & ship / Auth — with everything else demoted to a compact "Advanced
 * options" block rather than a flat 40-line dump.
 */

export type GroupName = "detect" | "prove" | "fix" | "ship" | "auth" | "advanced";

const GROUP_HEADINGS: Record<GroupName, string> = {
  detect: "Detect",
  prove: "Prove",
  fix: "Fix",
  ship: "Report & ship",
  auth: "Auth",
  advanced: "Advanced options",
};

// Primary groups render first, in this order, with aligned descriptions.
const PRIMARY_GROUPS: GroupName[] = ["detect", "prove", "fix", "ship", "auth"];

interface GroupedOption extends Option {
  __aztrxGroup?: GroupName;
}

/** Build a commander Option tagged with a help group (defaults to "advanced"). */
export function opt(
  flags: string,
  description: string,
  group: GroupName = "advanced",
): Option {
  const option = new Option(flags, description);
  (option as GroupedOption).__aztrxGroup = group;
  return option;
}

function groupOf(option: Option): GroupName {
  return (option as GroupedOption).__aztrxGroup ?? "advanced";
}

/**
 * Standalone `Help.formatHelp` override, registered via
 * `runCommand.configureHelp({ formatHelp })`. Mirrors commander's built-in
 * layout (Usage / Description / Arguments / Commands) but replaces the flat
 * "Options:" list with named groups, and compresses the advanced flags into a
 * single wrapped line of flag names.
 */
export function formatHelp(cmd: Command, helper: Help): string {
  const termWidth = helper.padWidth(cmd, helper);
  const helpWidth = helper.helpWidth || 80;
  const itemIndentWidth = 2;
  const itemSeparatorWidth = 2;

  const formatItem = (term: string, description: string): string => {
    if (description) {
      const fullText = `${term.padEnd(termWidth + itemSeparatorWidth)}${description}`;
      return helper.wrap(fullText, helpWidth - itemIndentWidth, termWidth + itemSeparatorWidth);
    }
    return term;
  };
  const formatList = (lines: string[]): string =>
    lines.join("\n").replace(/^/gm, " ".repeat(itemIndentWidth));

  const output: string[] = [`Usage: ${helper.commandUsage(cmd)}`, ""];

  const description = helper.commandDescription(cmd);
  if (description.length > 0) {
    output.push(helper.wrap(description, helpWidth, 0), "");
  }

  const argumentList = helper
    .visibleArguments(cmd)
    .map((arg) => formatItem(helper.argumentTerm(arg), helper.argumentDescription(arg)));
  if (argumentList.length > 0) {
    output.push("Arguments:", formatList(argumentList), "");
  }

  // Separate the implicit `-h, --help` so it isn't swallowed by a group.
  const visible = helper.visibleOptions(cmd);
  const helpOption = visible.find((o) => o.short === "-h" && o.long === "--help");
  const grouped = visible.filter((o) => o !== helpOption);

  const buckets = new Map<GroupName, Option[]>();
  for (const o of grouped) {
    const g = groupOf(o);
    if (!buckets.has(g)) buckets.set(g, []);
    buckets.get(g)!.push(o);
  }

  for (const g of PRIMARY_GROUPS) {
    const opts = buckets.get(g);
    if (!opts || opts.length === 0) continue;
    const list = opts.map((o) => formatItem(helper.optionTerm(o), helper.optionDescription(o)));
    output.push(`${GROUP_HEADINGS[g]}:`, formatList(list), "");
  }

  const advanced = buckets.get("advanced");
  if (advanced && advanced.length > 0) {
    const names = advanced.map((o) => helper.optionTerm(o)).join(", ");
    output.push(
      `${GROUP_HEADINGS.advanced}:`,
      formatList([helper.wrap(names, helpWidth - itemIndentWidth, 0)]),
      "",
    );
  }

  if (helpOption) {
    output.push(
      formatList([formatItem(helper.optionTerm(helpOption), helper.optionDescription(helpOption))]),
      "",
    );
  }

  const commandList = helper
    .visibleCommands(cmd)
    .map((c) => formatItem(helper.subcommandTerm(c), helper.subcommandDescription(c)));
  if (commandList.length > 0) {
    output.push("Commands:", formatList(commandList), "");
  }

  return output.join("\n");
}
