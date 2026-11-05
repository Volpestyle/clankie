import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, isAbsolute, normalize } from "node:path";
import { promisify } from "node:util";
import { ProjectTrackingSchema, type ProjectTracking } from "@clankie/protocol/project-tracking";
import type { Project } from "@clankie/protocol/projects";
import type { GithubApi } from "@clankie/work-items";
import { z } from "zod";
const exec = promisify(execFile);

/** Read only this project's known roots. Repo grouping is never a scan of neighboring folders. */
export async function inferProjectTracking(
  project: Project,
  api: GithubApi,
): Promise<{ proposed?: ProjectTracking; signals: string[] }> {
  const signals: string[] = [];
  const roots = [
    ...new Set([
      ...project.workspaces
        .filter(
          (w) =>
            w.machineId === "local" && w.platform === (process.platform === "win32" ? "windows" : "posix"),
        )
        .map((w) => w.path),
      ...(project.tracking?.repositories.flatMap((repo) => (repo.localPath ? [repo.localPath] : [])) ?? []),
    ]),
  ];
  const repositories: ProjectTracking["repositories"] = [];
  const candidates: unknown[] = [];
  let conflict = false;
  for (const root of roots) {
    try {
      if (!isAbsolute(root) || normalize(root) !== root || (await realpath(root)) !== root)
        throw new Error("noncanonical source");
      const git = async (args: string[]) =>
        (await exec("git", ["-C", root, ...args], { timeout: 5000, maxBuffer: 256 * 1024 })).stdout;
      if ((await git(["rev-parse", "--show-toplevel"])).trim() !== root)
        throw new Error("not the repository root");
      const origin = (await git(["remote", "get-url", "origin"])).trim();
      const repository = /^(?:git@github\.com:|https:\/\/github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/u.exec(
        origin,
      )?.[1];
      if (!repository) throw new Error("no exact GitHub origin");
      const metadata = z
        .object({ full_name: z.string(), private: z.boolean() })
        .parse(await api.request("GET", `repos/${repository}`));
      if (metadata.full_name.toLowerCase() !== repository.toLowerCase())
        throw new Error("repository changed");
      const guides: { file: "CLAUDE.md" | "AGENTS.md"; text: string }[] = [];
      for (const file of ["CLAUDE.md", "AGENTS.md"] as const) {
        const path = join(root, file);
        const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (!info) continue;
        if (!info.isFile() || info.size > 64 * 1024) throw new Error("guide is not a bounded regular file");
        const text = await readFile(path, "utf8");
        if (text.includes("clankie:tracking")) guides.push({ file, text });
      }
      if (guides.length !== 1) throw new Error("select exactly one guide with tracking markers");
      const guide = guides[0]!;
      repositories.push({
        repository,
        visibility: metadata.private ? "private" : "public",
        guide: guide.file,
        localPath: root,
      });
      // Explicit destinations carry both the issue store and board. Historical issue keys alone
      // cannot establish the private destination, and never fill a missing board by guessing.
      const github = [
        ...guide.text.matchAll(
          /(Public|Private) work: GitHub issues in `([\w.-]+\/[\w.-]+)`; board (https:\/\/github\.com\/[^\s]+)\./gu,
        ),
      ];
      const linear = [
        ...guide.text.matchAll(
          /(Public|Private) work: Linear team `([^`\n]+)`, project `([^`\n]+)`; board (https:\/\/linear\.app\/[^\s]+)\./gu,
        ),
      ];
      const pair = <T>(rows: { audience: string; value: T }[]) => {
        const publicRows = rows.filter((row) => row.audience === "Public"),
          privateRows = rows.filter((row) => row.audience === "Private");
        return publicRows.length === 1 && privateRows.length === 1
          ? { public: publicRows[0]!.value, private: privateRows[0]!.value }
          : undefined;
      };
      const gh = pair(github.map((m) => ({ audience: m[1]!, value: { repository: m[2]!, board: m[3]! } })));
      const lin = pair(
        linear.map((m) => ({ audience: m[1]!, value: { team: m[2]!, project: m[3]!, board: m[4]! } })),
      );
      if (gh) candidates.push({ backend: "github", ...gh });
      if (lin) candidates.push({ backend: "linear", ...lin });
      const recent = await git(["log", "-50", "--format=%s%n%b"]);
      const githubActive =
        /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+|\b[\w.-]+\/[\w.-]+#\d+/u.test(recent);
      const linearActive = /\b[A-Z][A-Z0-9]+-\d+\b/u.test(recent);
      // A current saved convention and recent activity can disagree with a guide; that is
      // a proposal/owner question, not an automatic migration based on old prose.
      const conventionFile = join(root, ".clankie", "tracking.json");
      const info = await lstat(conventionFile).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      let savedBackend: unknown;
      if (info) {
        if (!info.isFile() || info.size > 16 * 1024 || (await realpath(conventionFile)) !== conventionFile)
          throw new Error("saved tracker source changed");
        savedBackend = (JSON.parse(await readFile(conventionFile, "utf8")) as { backend?: unknown }).backend;
      }
      if (
        (gh && (linearActive || (savedBackend && savedBackend !== "github"))) ||
        (lin && (githubActive || (savedBackend && savedBackend !== "linear"))) ||
        (githubActive && linearActive)
      )
        conflict = true;
      signals.push(
        `${repository}: ${metadata.private ? "private" : "public"}, ${guide.file}; recent ${githubActive ? "GitHub" : "no qualified GitHub"}/${linearActive ? "Linear" : "no Linear"} issue references${savedBackend ? `; saved tracker ${String(savedBackend)}` : ""}`,
      );
    } catch {
      conflict = true;
      signals.push(`${root}: repository, guide or tracker evidence is unavailable or ambiguous`);
    }
  }
  const distinct = [
    ...new Map(candidates.map((candidate) => [JSON.stringify(candidate), candidate])).values(),
  ];
  if (conflict || !roots.length || repositories.length !== roots.length || distinct.length !== 1)
    return {
      signals: [
        ...signals,
        "Confirm the repo grouping and both public/private destinations; evidence is missing or disagrees.",
      ],
    };
  const parsed = ProjectTrackingSchema.safeParse({ repositories, tracker: distinct[0] });
  return parsed.success
    ? { signals, proposed: parsed.data }
    : { signals: [...signals, "The observed targets do not form one valid public/private tracker setting."] };
}
