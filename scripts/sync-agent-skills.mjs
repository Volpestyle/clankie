import { spawnSync } from "node:child_process";
import { lstat, mkdir, readdir, readFile, readlink, rm, symlink } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";

// `.agents/skills` is the single source of truth for load-on-demand skills.
// Every other provider root mirrors it with relative symlinks so the copies
// cannot drift: editing any provider path edits the canonical file directly.
const rootArgumentIndex = process.argv.indexOf("--root");
if (rootArgumentIndex !== -1 && !process.argv[rootArgumentIndex + 1]) {
  console.error("usage: sync-agent-skills.mjs [--check] [--root PATH]");
  process.exit(2);
}
const root =
  rootArgumentIndex === -1
    ? resolve(import.meta.dirname, "..")
    : resolve(process.argv[rootArgumentIndex + 1]);
const source = resolve(root, ".agents/skills");
const targets = [
  resolve(root, ".claude/skills"),
  resolve(root, ".pi/agent/skills"),
  resolve(root, ".codex/skills"),
];

const check = process.argv.includes("--check");

const skills = (await readdir(source, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const canonical = new Set(skills);

const contentProblems = await validateCanonicalSkills();
if (contentProblems.length) {
  console.error("Canonical skill validation failed:");
  for (const problem of contentProblems) console.error(`- ${problem}`);
  process.exit(1);
}

const drift = [];

for (const target of targets) {
  if (!check) await mkdir(target, { recursive: true });

  // Prune anything in the mirror that is not a current canonical skill.
  let existing = [];
  try {
    existing = await readdir(target, { withFileTypes: true });
  } catch {
    existing = [];
  }
  for (const entry of existing) {
    if (canonical.has(entry.name)) continue;
    const stray = resolve(target, entry.name);
    if (check) drift.push(`stray mirror entry ${rel(stray)}`);
    else await rm(stray, { recursive: true, force: true });
  }

  // Ensure every canonical skill is a relative symlink to the source.
  for (const name of skills) {
    const link = resolve(target, name);
    const expected = relative(target, resolve(source, name));
    if (await isCorrectSymlink(link, expected)) continue;
    if (check) {
      drift.push(`${rel(link)} is not a symlink to ${expected}`);
      continue;
    }
    await rm(link, { recursive: true, force: true });
    await symlink(expected, link);
  }
}

async function isCorrectSymlink(link, expected) {
  try {
    const stats = await lstat(link);
    return stats.isSymbolicLink() && (await readlink(link)) === expected;
  } catch {
    return false;
  }
}

function rel(path) {
  return relative(root, path);
}

async function validateCanonicalSkills() {
  const problems = [];
  if (!skills.length) {
    problems.push(`${rel(source)} contains no skill directories`);
    return problems;
  }

  for (const name of skills) {
    const skillDirectory = resolve(source, name);
    const skillFile = resolve(skillDirectory, "SKILL.md");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) {
      problems.push(`${rel(skillDirectory)} must use a lowercase kebab-case directory name`);
    }

    let skillContents;
    try {
      skillContents = await readFile(skillFile, "utf8");
    } catch {
      problems.push(`${rel(skillFile)} is missing or unreadable`);
      continue;
    }

    const frontmatter = parseFrontmatter(skillContents);
    if (!frontmatter) {
      problems.push(`${rel(skillFile)} must start with YAML frontmatter`);
    } else {
      if (frontmatter.name !== name) {
        problems.push(
          `${rel(skillFile)} frontmatter name must equal its directory (${JSON.stringify(name)})`,
        );
      }
      if (!frontmatter.description) {
        problems.push(`${rel(skillFile)} frontmatter description must be non-empty`);
      }
    }

    const files = await listFiles(skillDirectory);
    for (const file of files) {
      if (extname(file) === ".md") {
        problems.push(...(await validateLocalMarkdownLinks(file)));
      }
      if (extname(file) === ".sh") {
        const stats = await lstat(file);
        if ((stats.mode & 0o111) === 0) {
          problems.push(`${rel(file)} must be executable`);
        }
        const result = spawnSync("bash", ["-n", file], { encoding: "utf8" });
        if (result.status !== 0) {
          const detail = `${result.stderr || result.stdout}`.trim().split("\n").at(-1);
          problems.push(`${rel(file)} fails bash -n${detail ? `: ${detail}` : ""}`);
        }
      }
    }
  }

  return problems;
}

function parseFrontmatter(contents) {
  const normalized = contents.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return undefined;
  const end = normalized.indexOf("\n---\n", 4);
  if (end === -1) return undefined;
  const block = normalized.slice(4, end);
  return {
    name: frontmatterScalar(block, "name"),
    description: frontmatterScalar(block, "description"),
  };
}

function frontmatterScalar(block, key) {
  const lines = block.split("\n");
  const keyPattern = new RegExp(`^${key}:\\s*(.*)$`, "u");
  const index = lines.findIndex((line) => keyPattern.test(line));
  if (index === -1) return undefined;
  const value = keyPattern.exec(lines[index])?.[1].trim();
  if (!value) return undefined;
  if (/^[>|][+-]?$/u.test(value)) {
    const continuation = [];
    for (const line of lines.slice(index + 1)) {
      if (line && !/^\s/u.test(line)) break;
      if (line.trim()) continuation.push(line.trim());
    }
    return continuation.join(" ") || undefined;
  }
  return value.replace(/^(['"])(.*)\1$/u, "$2");
}

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function validateLocalMarkdownLinks(file) {
  const problems = [];
  const contents = await readFile(file, "utf8");
  const links = contents.matchAll(/!?\[[^\n]*?\]\(([^)\n]+)\)/gu);
  for (const match of links) {
    let destination = match[1].trim();
    if (destination.startsWith("<") && destination.endsWith(">")) {
      destination = destination.slice(1, -1);
    } else {
      destination = destination.split(/\s+["']/u, 1)[0];
    }
    if (!destination || destination.startsWith("#") || /^(?:[a-z]+:|\/\/)/iu.test(destination)) {
      continue;
    }

    const pathPart = destination.split(/[?#]/u, 1)[0];
    if (!pathPart) continue;
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(pathPart);
    } catch {
      problems.push(`${rel(file)} contains an invalid encoded link: ${destination}`);
      continue;
    }
    const target = resolve(dirname(file), decodedPath);
    try {
      await lstat(target);
    } catch {
      problems.push(`${rel(file)} links to missing local path ${destination}`);
    }
  }
  return problems;
}

if (check) {
  if (drift.length) {
    console.error("Provider skill mirror drift detected:");
    for (const problem of drift) console.error(`- ${problem}`);
    console.error("Run `pnpm skills:sync` to repair.");
    process.exitCode = 1;
  } else {
    console.log(
      `Validated ${skills.length} skills and verified their symlinks across ${targets.length} provider roots.`,
    );
  }
} else {
  console.log(`Validated and linked ${skills.length} skills into ${targets.length} provider roots.`);
}
