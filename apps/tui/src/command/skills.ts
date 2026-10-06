import { bundledSkills } from "@clankie/settings";

const USAGE = "Usage: clankie skills";

/** Read-only: every shipped skill is always on. */
export async function runSkillsCommand(args: readonly string[], options: { repoRoot: string }) {
  if (args.length !== 0 && !(args.length === 1 && args[0] === "status")) throw new Error(USAGE);
  return { ok: true, catalog: bundledSkills(options.repoRoot) };
}
