import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  OPERATOR_COMPOSER_CATALOG_MAX,
  type OperatorComposerCatalog,
  type OperatorFleetSeat,
} from "@clankie/protocol";
import { getAgentDir, loadSkills } from "@earendil-works/pi-coding-agent";

const SKILL_NAME = /^[a-z0-9][a-z0-9:_-]*$/u;
const CODEX_SKILLS_TIMEOUT_MS = 5_000;

function catalogSkills(
  skills: readonly {
    readonly name: string;
    readonly description: string;
    readonly disableModelInvocation: boolean;
  }[],
  source: string,
  invocation: (name: string) => string,
): OperatorComposerCatalog["skills"] {
  const unique = new Map<string, OperatorComposerCatalog["skills"][number]>();
  for (const skill of skills) {
    if (skill.disableModelInvocation || !SKILL_NAME.test(skill.name) || unique.has(skill.name)) continue;
    const description = skill.description.trim().slice(0, 512);
    if (description.length === 0) continue;
    unique.set(skill.name, {
      name: skill.name,
      description,
      source,
      invocation: invocation(skill.name),
    });
  }
  return [...unique.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, OPERATOR_COMPOSER_CATALOG_MAX);
}

/** Parse Codex's public `skills/list` result without trusting its process boundary. */
export function codexCatalogSkills(result: unknown): OperatorComposerCatalog["skills"] | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const data = (result as { readonly data?: unknown }).data;
  if (!Array.isArray(data)) return undefined;
  const skills = data.flatMap(
    (
      entry,
    ): Array<{
      name: string;
      description: string;
      disableModelInvocation: boolean;
    }> => {
      if (entry === null || typeof entry !== "object") return [];
      const values = (entry as { readonly skills?: unknown }).skills;
      if (!Array.isArray(values)) return [];
      return values.flatMap((value) => {
        if (value === null || typeof value !== "object") return [];
        const skill = value as Record<string, unknown>;
        return typeof skill.name === "string" && typeof skill.description === "string"
          ? [
              {
                name: skill.name,
                description: skill.description,
                disableModelInvocation: skill.enabled !== true,
              },
            ]
          : [];
      });
    },
  );
  return catalogSkills(skills, "codex", (name) => `$${name}`);
}

/** Ask the installed Codex harness for the same enabled skill catalog its TUI uses. */
function discoverCodexSkills(cwd: string): Promise<OperatorComposerCatalog["skills"]> {
  return new Promise((resolve, reject) => {
    const process = spawn("codex", ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buffer = "";
    let settled = false;
    const finish = (error: Error | undefined, skills?: OperatorComposerCatalog["skills"]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      process.kill();
      if (error !== undefined) reject(error);
      else resolve(skills ?? []);
    };
    const timeout = setTimeout(
      () => finish(new Error("Codex skills/list timed out")),
      CODEX_SKILLS_TIMEOUT_MS,
    );
    process.on("error", (error) => finish(error));
    process.on("exit", () => finish(new Error("Codex app-server exited before skills/list")));
    process.stdout.setEncoding("utf8");
    process.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length === 0) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message === null || typeof message !== "object") continue;
        const response = message as { readonly id?: unknown; readonly result?: unknown };
        if (response.id === 1) {
          process.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          process.stdin.write(
            `${JSON.stringify({
              id: 2,
              method: "skills/list",
              params: { cwds: [cwd], forceReload: false },
            })}\n`,
          );
        } else if (response.id === 2) {
          const skills = codexCatalogSkills(response.result);
          finish(
            skills === undefined ? new Error("Codex returned an invalid skills/list result") : undefined,
            skills,
          );
        }
      }
    });
    process.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "clankie", version: "0.2.0" }, capabilities: {} },
      })}\n`,
    );
  });
}

export function captainComposerCatalog(input: {
  readonly cwd: string;
  readonly repoRoot: string;
}): OperatorComposerCatalog {
  const skillPaths = [
    join(input.repoRoot, ".agents", "skills"),
    join(input.repoRoot, ".agents", "dev-skills"),
  ].filter(existsSync);
  const { skills } = loadSkills({
    cwd: input.cwd,
    agentDir: getAgentDir(),
    skillPaths,
    includeDefaults: true,
  });
  return {
    schemaVersion: 1,
    commands: [],
    skills: catalogSkills(skills, "clankie", (name) => `/skill:${name}`),
  };
}

export async function seatComposerCatalog(
  seat: Pick<OperatorFleetSeat, "harness" | "workingDirectory">,
  home = homedir(),
): Promise<OperatorComposerCatalog> {
  const harness = seat.harness.toLowerCase();
  const invocation =
    harness === "codex"
      ? (name: string): string => `$${name}`
      : harness === "claude"
        ? (name: string): string => `/${name}`
        : harness === "pi"
          ? (name: string): string => `/skill:${name}`
          : undefined;
  if (invocation === undefined) return { schemaVersion: 1, commands: [], skills: [] };

  const cwd = seat.workingDirectory ?? home;
  if (harness === "codex") {
    const skills = await discoverCodexSkills(cwd).catch(() => undefined);
    if (skills !== undefined) return { schemaVersion: 1, commands: [], skills };
  }
  const agentDir = harness === "pi" ? join(home, ".pi", "agent") : join(home, `.${harness}`);
  const skillPaths = [
    join(cwd, ".agents", "skills"),
    join(cwd, `.${harness}`, "skills"),
    join(home, ".agents", "skills"),
    join(home, `.${harness}`, "skills"),
    join(agentDir, "skills"),
  ].filter(existsSync);
  const { skills } = loadSkills({ cwd, agentDir, skillPaths, includeDefaults: false });
  return {
    schemaVersion: 1,
    commands: [],
    skills: catalogSkills(skills, harness, invocation),
  };
}
