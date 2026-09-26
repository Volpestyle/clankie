import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  WorkBackendKindSchema,
  WorkConventionSchema,
  WorkEvidenceSchema,
  WorkItemStatusSchema,
  type WorkConvention,
  type WorkItem,
  type WorkRepo,
  type WorkSignal,
} from "@clankie/protocol/work-items";
import {
  ConventionNeededError,
  discoverConvention,
  readConvention,
  resolveTracker,
  writeConvention,
  type CommandRunner,
  type GhRunner,
  type LinearToolCall,
  type TrackerDeps,
} from "@clankie/work-items";
import type { McpHost } from "./mcp-host.ts";

/**
 * The work-item layer every agent and the app go through (ADR 0191). It owns
 * which repos are readable over the device contract; the backends own storage.
 */

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 30_000;

export const WorkRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("repos") }).strict(),
  z.object({ action: z.literal("discover"), repo: z.string().min(1).max(4096) }).strict(),
  z
    .object({
      action: z.literal("init"),
      repo: z.string().min(1).max(4096),
      backend: WorkBackendKindSchema.optional(),
      directory: z.string().min(1).max(256).optional(),
      githubRepo: z.string().min(1).max(200).optional(),
      linearTeam: z.string().min(1).max(64).optional(),
      linearProject: z.string().min(1).max(200).optional(),
      decisions: z.string().min(1).max(256).optional(),
      note: z.string().max(1000).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("list"),
      repo: z.string().min(1).max(4096),
      status: z.array(WorkItemStatusSchema).max(5).optional(),
      owner: z.string().min(1).max(128).optional(),
      limit: z.number().int().min(1).max(250).optional(),
    })
    .strict(),
  z
    .object({ action: z.literal("show"), repo: z.string().min(1).max(4096), id: z.string().min(1).max(64) })
    .strict(),
  z
    .object({
      action: z.literal("create"),
      repo: z.string().min(1).max(4096),
      title: z.string().trim().min(1).max(200),
      summary: z.string().max(20_000).optional(),
      owner: z.string().trim().min(1).max(128).optional(),
      criteria: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
      dependsOn: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
      status: WorkItemStatusSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("update"),
      repo: z.string().min(1).max(4096),
      id: z.string().min(1).max(64),
      status: WorkItemStatusSchema.optional(),
      owner: z.string().trim().min(1).max(128).nullable().optional(),
      title: z.string().trim().min(1).max(200).optional(),
      dependsOn: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
      check: z.array(z.number().int().min(1).max(50)).max(50).optional(),
      uncheck: z.array(z.number().int().min(1).max(50)).max(50).optional(),
      addCriteria: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("attach"),
      repo: z.string().min(1).max(4096),
      id: z.string().min(1).max(64),
      evidence: WorkEvidenceSchema,
    })
    .strict(),
]);
export type WorkRequest = z.infer<typeof WorkRequestSchema>;

const RegistrySchema = z.object({
  repos: z.array(z.object({ id: z.string(), path: z.string(), name: z.string() }).strict()).max(50),
});

export interface WorkItemsServiceOptions {
  /** Where the registry of readable repos lives. */
  readonly stateDirectory: string;
  /** The captain's working directory, always readable as `workspace`. */
  readonly workspace?: () => string | undefined;
  readonly mcpHost?: Pick<McpHost, "call">;
  /** Test seams; production shells out to git and gh. */
  readonly run?: CommandRunner;
  readonly gh?: GhRunner;
  readonly clock?: () => Date;
}

export type WorkResult =
  | { readonly repos: WorkRepo[] }
  | {
      readonly repo: WorkRepo;
      readonly signals: WorkSignal[];
      readonly convention?: WorkConvention;
      readonly question?: string;
    }
  | { readonly repo: WorkRepo; readonly convention: WorkConvention }
  | { readonly repo: WorkRepo; readonly items: WorkItem[] }
  | { readonly repo: WorkRepo; readonly item: WorkItem };

export class WorkRequestError extends Error {
  readonly code: "unknown_repo" | "not_found" | "needs_decision" | "backend_unavailable" | "invalid";
  readonly question: string | undefined;
  readonly signals: WorkSignal[] | undefined;
  constructor(
    code: WorkRequestError["code"],
    message: string,
    extra: { question?: string; signals?: WorkSignal[] } = {},
  ) {
    super(message);
    this.name = "WorkRequestError";
    this.code = code;
    this.question = extra.question;
    this.signals = extra.signals;
  }
}

const defaultRun: CommandRunner = async (command, args, cwd) =>
  (await execFileAsync(command, [...args], { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }))
    .stdout;

const defaultGh =
  (cwd: string): GhRunner =>
  async (args, stdin) =>
    new Promise((resolvePromise, reject) => {
      const child = execFile(
        "gh",
        [...args],
        { cwd, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout, stderr) =>
          error ? reject(new Error(`${error.message}\n${String(stderr)}`)) : resolvePromise(String(stdout)),
      );
      if (stdin !== undefined) child.stdin?.end(stdin);
    });

function repoId(path: string): string {
  const name = basename(path)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
  return `${name || "repo"}-${createHash("sha256").update(path).digest("hex").slice(0, 8)}`;
}

export function createWorkItemsService(options: WorkItemsServiceOptions) {
  const registryPath = join(options.stateDirectory, "work-repos.json");
  const run = options.run ?? defaultRun;
  const clock = options.clock ?? (() => new Date());

  const linear: LinearToolCall | undefined =
    options.mcpHost === undefined
      ? undefined
      : async (tool, args) => {
          const result = await options.mcpHost!.call({
            lane: "operator",
            server: "linear",
            tool,
            arguments: args,
          });
          if (result.outcome !== "ok") throw new Error(`Linear ${tool}: ${result.detail}`);
          if (result.isError) throw new Error(`Linear ${tool}: ${result.content.slice(0, 500)}`);
          return result.content.trim().length === 0 ? undefined : (JSON.parse(result.content) as unknown);
        };

  const readRegistry = async () => {
    try {
      return RegistrySchema.parse(JSON.parse(await readFile(registryPath, "utf8"))).repos;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };

  const writeRegistry = async (repos: { id: string; path: string; name: string }[]) => {
    await mkdir(options.stateDirectory, { recursive: true });
    const temporary = `${registryPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ repos }, null, 2)}\n`, "utf8");
    await rename(temporary, registryPath);
  };

  const known = async () => {
    const repos = await readRegistry();
    const workspace = options.workspace?.();
    return workspace === undefined || repos.some((repo) => repo.path === resolve(workspace))
      ? repos
      : [{ id: "workspace", path: resolve(workspace), name: basename(workspace) }, ...repos];
  };

  /** Registers a local path the operator or an agent named, so the app can read it later. */
  const register = async (path: string) => {
    const repos = await readRegistry();
    const absolute = resolve(path);
    const existing = (await known()).find((repo) => repo.path === absolute);
    if (existing !== undefined) return existing;
    const entry = { id: repoId(absolute), path: absolute, name: basename(absolute) };
    await writeRegistry([...repos.filter((repo) => repo.path !== absolute), entry].slice(-50));
    return entry;
  };

  /**
   * A device may only name a registered repo id. A local caller (the CLI, the
   * captain, a hire on this machine) may also name a path, which registers it.
   */
  const locate = async (ref: string, local: boolean) => {
    const byId = (await known()).find((repo) => repo.id === ref);
    if (byId !== undefined) return byId;
    if (local && isAbsolute(ref)) return register(ref);
    throw new WorkRequestError("unknown_repo", `No registered repo ${ref}`);
  };

  const describe = async (entry: { id: string; path: string; name: string }): Promise<WorkRepo> => {
    const convention = await readConvention(entry.path).catch(() => undefined);
    return {
      id: entry.id,
      name: entry.name,
      ...(convention === undefined ? {} : { backend: convention.backend }),
      needsDecision: convention === undefined,
    };
  };

  const deps = (path: string): TrackerDeps => ({
    run,
    gh: options.gh ?? defaultGh(path),
    ...(linear === undefined ? {} : { linear }),
    clock,
  });

  const tracker = async (path: string, record: boolean) => {
    try {
      return await resolveTracker(path, deps(path), { record });
    } catch (error) {
      if (error instanceof ConventionNeededError)
        throw new WorkRequestError("needs_decision", error.message, {
          ...(error.discovery.question === undefined ? {} : { question: error.discovery.question }),
          signals: error.discovery.signals,
        });
      if (error instanceof Error && error.name === "BackendUnavailableError")
        throw new WorkRequestError("backend_unavailable", error.message);
      throw error;
    }
  };

  return {
    async handle(request: WorkRequest, local: boolean): Promise<WorkResult> {
      if (request.action === "repos") return { repos: await Promise.all((await known()).map(describe)) };
      const entry = await locate(request.repo, local);
      switch (request.action) {
        case "discover": {
          const discovery = await discoverConvention(entry.path, run);
          const recorded = await readConvention(entry.path);
          return {
            repo: await describe(entry),
            signals: discovery.signals,
            ...(recorded === undefined ? {} : { convention: recorded }),
            ...(recorded === undefined && discovery.question !== undefined
              ? { question: discovery.question }
              : {}),
          };
        }
        case "init": {
          if (!local) throw new WorkRequestError("invalid", "Only this machine records a convention");
          let convention: WorkConvention;
          if (request.backend === undefined) {
            const discovery = await discoverConvention(entry.path, run);
            if (discovery.suggestion === undefined)
              throw new WorkRequestError("needs_decision", discovery.question ?? "Choose a backend", {
                ...(discovery.question === undefined ? {} : { question: discovery.question }),
                signals: discovery.signals,
              });
            convention = { ...discovery.suggestion, decidedAt: clock().toISOString() };
          } else {
            convention = WorkConventionSchema.parse({
              schemaVersion: 1,
              backend: request.backend,
              ...(request.directory === undefined ? {} : { directory: request.directory }),
              ...(request.githubRepo === undefined ? {} : { github: { repo: request.githubRepo } }),
              ...(request.linearTeam === undefined
                ? {}
                : {
                    linear: {
                      team: request.linearTeam,
                      ...(request.linearProject === undefined ? {} : { project: request.linearProject }),
                    },
                  }),
              ...(request.decisions === undefined ? {} : { decisions: request.decisions }),
              decidedBy: "owner",
              decidedAt: clock().toISOString(),
              ...(request.note === undefined ? {} : { note: request.note }),
            });
          }
          await writeConvention(entry.path, convention);
          return { repo: await describe(entry), convention };
        }
        case "list": {
          const { backend } = await tracker(entry.path, false);
          return {
            repo: await describe(entry),
            items: await backend.list({
              ...(request.status === undefined ? {} : { status: request.status }),
              ...(request.owner === undefined ? {} : { owner: request.owner }),
              limit: request.limit ?? 250,
            }),
          };
        }
        case "show": {
          const { backend } = await tracker(entry.path, false);
          const item = await backend.get(request.id);
          if (item === undefined) throw new WorkRequestError("not_found", `No work item ${request.id}`);
          return { repo: await describe(entry), item };
        }
        case "create": {
          if (!local) throw new WorkRequestError("invalid", "Devices read work items; agents write them");
          const { backend } = await tracker(entry.path, true);
          const item = await backend.create({
            title: request.title,
            ...(request.summary === undefined ? {} : { summary: request.summary }),
            ...(request.owner === undefined ? {} : { owner: request.owner }),
            ...(request.criteria === undefined ? {} : { criteria: request.criteria }),
            ...(request.dependsOn === undefined ? {} : { dependsOn: request.dependsOn }),
            ...(request.status === undefined ? {} : { status: request.status }),
          });
          return { repo: await describe(entry), item };
        }
        case "update": {
          if (!local) throw new WorkRequestError("invalid", "Devices read work items; agents write them");
          const { backend } = await tracker(entry.path, true);
          const patch = {
            ...(request.status === undefined ? {} : { status: request.status }),
            ...(request.owner === undefined ? {} : { owner: request.owner }),
            ...(request.title === undefined ? {} : { title: request.title }),
            ...(request.dependsOn === undefined ? {} : { dependsOn: request.dependsOn }),
            ...(request.check === undefined ? {} : { check: request.check }),
            ...(request.uncheck === undefined ? {} : { uncheck: request.uncheck }),
            ...(request.addCriteria === undefined ? {} : { addCriteria: request.addCriteria }),
          };
          try {
            return { repo: await describe(entry), item: await backend.update(request.id, patch) };
          } catch (error) {
            if (error instanceof Error && error.name === "WorkItemNotFoundError")
              throw new WorkRequestError("not_found", error.message);
            throw error;
          }
        }
        case "attach": {
          if (!local) throw new WorkRequestError("invalid", "Devices read work items; agents write them");
          const { backend } = await tracker(entry.path, true);
          try {
            return { repo: await describe(entry), item: await backend.attach(request.id, request.evidence) };
          } catch (error) {
            if (error instanceof Error && error.name === "WorkItemNotFoundError")
              throw new WorkRequestError("not_found", error.message);
            throw error;
          }
        }
      }
    },
  };
}

export type WorkItemsService = ReturnType<typeof createWorkItemsService>;
