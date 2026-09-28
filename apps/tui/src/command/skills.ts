import { bundledSkills, SettingsStore, defaultSettingsPath } from "@clankie/settings";

const USAGE = "Usage: clankie skills [opinionated on|off | exclude NAME | include NAME]";

export async function runSkillsCommand(
  args: readonly string[],
  options: { repoRoot: string; env?: NodeJS.ProcessEnv; settings?: SettingsStore },
) {
  const store = options.settings ?? new SettingsStore(defaultSettingsPath(options.env ?? process.env));
  const [verb, value] = args;
  if (args.length === 2 && verb === "opinionated" && (value === "on" || value === "off")) {
    await store.update((current) => ({
      ...current,
      skills: { ...current.skills, opinionated: value === "on" },
    }));
  } else if (args.length === 2 && (verb === "exclude" || verb === "include")) {
    const skill = bundledSkills(options.repoRoot).find((entry) => entry.name === value);
    if (!skill) throw new Error(`Unknown bundled skill: ${value}`);
    if (skill.class === "product") throw new Error(`${value} is a product/tool skill and is always on.`);
    await store.update((current) => ({
      ...current,
      skills: {
        ...current.skills,
        exclude:
          verb === "include"
            ? current.skills.exclude.filter((name) => name !== value)
            : [...new Set([...current.skills.exclude, skill.name])].sort(),
      },
    }));
  } else if (args.length !== 0 && !(args.length === 1 && verb === "status")) {
    throw new Error(USAGE);
  }
  const selection = (await store.load()).skills;
  return {
    ok: true,
    skills: selection,
    catalog: bundledSkills(options.repoRoot, selection),
    settingsFile: store.path,
    applies:
      "New sessions and local hires. Existing sessions keep loaded context; start a fresh seat or reset the conversation.",
  };
}
