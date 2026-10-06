import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { discoverConvention, readConvention, type CommandRunner } from "@clankie/work-items";
import { ProjectProposalDraftSchema, type ProjectProposalDraft } from "@clankie/protocol/projects";
import type { ResourceSnapshot } from "@clankie/fleet-resources";
import { defaultRun } from "../work-items.ts";

/** Bounded local reads. No install, tracker write, hire, or model call. */
async function filesUnder(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string, depth: number) => {
    if (depth > 8 || files.length >= 10_000) return;
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      if (files.length >= 10_000) break;
      if ([".git", "node_modules", ".local", "dist", "build", "vendor", ".clankie"].includes(entry.name))
        continue;
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path, depth + 1);
      else if (entry.isFile()) files.push(path);
    }
  };
  await walk("", 0);
  return files;
}

export async function inferProjectDefaults(
  workspace: string,
  resources: ResourceSnapshot | undefined,
  run: CommandRunner = defaultRun,
): Promise<{ draft?: ProjectProposalDraft; question?: string }> {
  const recorded = await readConvention(workspace);
  const discovery = recorded ? undefined : await discoverConvention(workspace, run);
  if (discovery?.question) return { question: discovery.question };
  const tracker = recorded ?? discovery!.suggestion!;
  const files = await filesUnder(workspace);
  const manifests = await Promise.all(
    files
      .filter((file) => /(?:^|\/)package\.json$/u.test(file))
      .slice(0, 64)
      .map(async (file) => {
        try {
          const text = await readFile(join(workspace, file), "utf8");
          if (text.length > 100_000) return {};
          const parsed: unknown = JSON.parse(text);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
          return parsed as {
            dependencies?: Record<string, unknown>;
            devDependencies?: Record<string, unknown>;
            scripts?: Record<string, unknown>;
          };
        } catch {
          return {};
        }
      }),
  );
  const nativeUi = await Promise.all(
    files
      .filter((file) => file.endsWith(".swift"))
      .slice(0, 64)
      .map(async (file) => {
        try {
          return /\bimport\s+(?:SwiftUI|UIKit|AppKit)\b/u.test(
            (await readFile(join(workspace, file), "utf8")).slice(0, 100_000),
          );
        } catch {
          return false;
        }
      }),
  );
  const hasUi =
    nativeUi.some(Boolean) ||
    files.some(
      (file) => /\.(?:tsx|jsx|vue|svelte|html|storyboard|xib)$/u.test(file) || /\.xcodeproj\//u.test(file),
    ) ||
    manifests.some((m) =>
      Object.keys({ ...m.dependencies, ...m.devDependencies }).some((name) =>
        ["react", "react-native", "vue", "svelte", "next", "expo", "@angular/core"].includes(name),
      ),
    );
  const hasTests =
    files.some(
      (file) => /(?:^|\/)(?:tests?|__tests__|spec)\//u.test(file) || /\.(?:test|spec)\.[^/]+$/u.test(file),
    ) || manifests.some((m) => typeof m.scripts?.test === "string");
  const sourceCount = files.filter((file) =>
    /\.(?:[cm]?[jt]sx?|swift|rs|go|py|java|kt|vue|svelte|cpp|c|h)$/u.test(file),
  ).length;
  let activity = 0;
  try {
    activity = (await run("git", ["log", "--since=14 days ago", "-100", "--format=%H"], workspace))
      .trim()
      .split("\n")
      .filter(Boolean).length;
  } catch {
    /* An unversioned workspace stays small. */
  }
  const desired = sourceCount >= 1000 && activity >= 50 ? 4 : 2;
  const available =
    resources?.pressure.healthy === true ? Math.max(0, Math.floor(resources.capacity.heavySlots)) : 0;
  const workerCap = Math.min(desired, available);
  const size = workerCap <= 1 ? "solo" : workerCap >= 4 ? "large" : "small";
  const roleReasons = [
    "builder: Implement changes in this repository.",
    "reviewer: Review changes before they land.",
    ...(hasUi ? ["designer: The repository contains an app UI."] : []),
    ...(hasTests ? ["tester: The repository contains a test suite."] : []),
  ];
  const name = basename(workspace).trim().slice(0, 100) || "Project";
  const projectId = (
    `${name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/gu, "-")
      .replace(/^-+/u, "")}` || "project"
  ).slice(0, 54);
  const setup = recorded
    ? undefined
    : {
        backend: tracker.backend,
        ...(tracker.linear
          ? {
              linearTeam: tracker.linear.team,
              linearProject: tracker.linear.project,
              linearLabel: tracker.linear.label,
            }
          : {}),
        ...(tracker.github ? { githubRepo: tracker.github.repo } : {}),
        ...(tracker.directory ? { directory: tracker.directory } : {}),
        ...(tracker.decisions ? { decisions: tracker.decisions } : {}),
      };
  return {
    draft: ProjectProposalDraftSchema.parse({
      projectId: /^[a-z]/u.test(projectId) ? projectId : `p-${projectId}`,
      name,
      prompt: "Here's what I picked. Accept to save the project, or tweak one field.",
      roles: roleReasons.map((reason) => ({ role: reason.split(":")[0] })),
      fleet: { size },
      workerCap,
      trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" },
      ...(setup ? { trackerSetup: setup } : {}),
      evidence: [
        recorded
          ? `tracker: Follow the saved ${tracker.backend} convention.`
          : `tracker: ${
              discovery!.signals
                .filter((s) => s.suggests?.backend)
                .map((s) => s.detail)
                .join("; ")
                .slice(0, 450) || "No tracker detected; use local work records."
            }`,
        ...roleReasons,
        `fleet: ${size}, at most ${workerCap} workers; ${sourceCount} source files, ${activity} commits in 14 days; ${resources === undefined ? "resource governor unavailable" : resources.pressure.healthy ? `governor capacity ${available}` : "resource pressure blocks hires"}.`,
      ],
    }),
  };
}
