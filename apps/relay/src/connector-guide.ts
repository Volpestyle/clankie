import { readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { bundledSkills } from "@clankie/settings";

// The guide behind `clankie_guide`: the product skills this install ships in
// `.agents/skills` (ADR 0236), served as topics so a client that can't load
// skills natively can still read them. Only a skill's own Markdown files are
// served; scripts and anything outside a skill's folder are not.

const GUIDE_TEXT_MAX = 128 * 1024;

interface GuideTopic {
  readonly topic: string;
  readonly about?: string;
}

export type GuideAnswer =
  | { readonly kind: "topics"; readonly topics: readonly GuideTopic[] }
  | { readonly kind: "page"; readonly topic: string; readonly text: string; readonly more: readonly string[] }
  | { readonly kind: "missing"; readonly detail: string };

export class ClankieGuide {
  private readonly repoRoot: string;

  public constructor(repoRoot: string) {
    this.repoRoot = repoRoot;
  }

  public async answer(topic: string | undefined): Promise<GuideAnswer> {
    const skills = bundledSkills(this.repoRoot);
    if (topic === undefined || topic.trim().length === 0)
      return {
        kind: "topics",
        topics: await Promise.all(
          skills.map(async (skill) => {
            const about = description(await readFile(join(skill.path, "SKILL.md"), "utf8").catch(() => ""));
            return { topic: skill.name, ...(about === undefined ? {} : { about }) };
          }),
        ),
      };
    const [name, ...rest] = topic.trim().replace(/\\/gu, "/").split("/");
    const skill = skills.find((candidate) => candidate.name === name);
    if (skill === undefined)
      return {
        kind: "missing",
        detail: `There's no guide topic called ${name}. Call clankie_guide without a topic to list them.`,
      };
    const page = rest.length === 0 ? "SKILL.md" : rest.join("/");
    const root = await realpath(skill.path);
    // allow-swallowed-rejection -- a page that doesn't exist answers as a missing topic below.
    const file = await realpath(join(root, page)).catch(() => undefined);
    if (file === undefined || !file.startsWith(root + sep) || !file.endsWith(".md"))
      return { kind: "missing", detail: `${topic} isn't a page of the ${name} guide.` };
    const text = await readFile(file, "utf8");
    return {
      kind: "page",
      topic: rest.length === 0 ? name! : `${name}/${relative(root, file).split(sep).join("/")}`,
      text:
        text.length > GUIDE_TEXT_MAX
          ? `${text.slice(0, GUIDE_TEXT_MAX)}\n\n[cut here: the page is longer]`
          : text,
      more: rest.length === 0 ? await pages(root, name!) : [],
    };
  }
}

/** The other Markdown pages a skill carries, as topics. */
async function pages(root: string, name: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .filter((page) => page !== "SKILL.md")
    .sort()
    .map((page) => `${name}/${page}`);
}

/** The frontmatter's one-line description, quoted or folded. */
function description(skill: string): string | undefined {
  const frontmatter = /^---\n([\s\S]*?)\n---/u.exec(skill)?.[1];
  if (frontmatter === undefined) return undefined;
  const lines = frontmatter.split("\n");
  const index = lines.findIndex((line) => line.startsWith("description:"));
  if (index < 0) return undefined;
  const value = lines[index]!.slice("description:".length).trim();
  if (value === ">" || value === "|" || value === ">-" || value === "|-") {
    const folded = [];
    for (const line of lines.slice(index + 1)) {
      if (!/^\s+/u.test(line)) break;
      folded.push(line.trim());
    }
    return folded.join(" ") || undefined;
  }
  return value.replace(/^(["'])([\s\S]*)\1$/u, "$2") || undefined;
}
