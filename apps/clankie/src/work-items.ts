import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
  WorkBackendKindSchema,
  WorkConventionSchema,
  WorkEvidenceSchema,
  WorkItemStatusSchema,
  WorkLinearLabelSchema,
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
  backendFor,
  type WorkItemPatch,
  writeConvention,
  type CommandRunner,
  githubRestApi,
  type GhRunner,
  type LinearToolCall,
  type TrackerDeps,
} from "@clankie/work-items";
import type { McpHost } from "./mcp-host.ts";
import type { ProjectsSettings } from "@clankie/protocol/projects";
import { WORK_REPO_LIST_MAX } from "@clankie/protocol/work-items";
import { createProjectWorkReader } from "./project-work-items.ts";
import {
  WorkItemWriteRequestSchema,
  WorkItemWriteReceiptRequestSchema,
  type WorkItemWriteRequest,
  type WorkItemWriteReceipt,
  type WorkItemWriteReceiptRequest,
} from "@clankie/protocol/work-item-write";
import { WorkWriteReceipts } from "./work-write-receipts.ts";
import {
  prepareWorkWriteTarget,
  type WorkWriteAuthority,
  type WorkProjectFence,
} from "./work-write-target.ts";
import { deliveryFingerprint } from "./captain/delivery-fence.ts";

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
      linearLabel: WorkLinearLabelSchema.optional(),
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
      label: z.string().trim().min(1).max(64).optional(),
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
/** Owner HTTP commands stay separate from the existing agent tool schema. */
export const WorkHttpRequestSchema = z.union([
  WorkRequestSchema,
  z.object({ action: z.literal("write"), request: WorkItemWriteRequestSchema }).strict(),
  z.object({ action: z.literal("write_receipt"), request: WorkItemWriteReceiptRequestSchema }).strict(),
]);

const RegistrySchema = z.object({
  repos: z.array(z.object({ id: z.string(), path: z.string(), name: z.string() }).strict()).max(50),
});

export interface WorkItemsServiceOptions {
  readonly projects?: () => Promise<ProjectsSettings>;
  readonly projectsFence?: () => Promise<WorkProjectFence>;
  readonly localMachineId?: string;
  /** Where the registry of readable repos lives. */
  readonly stateDirectory: string;
  /** The captain's working directory, always readable as `workspace`. */
  readonly workspace?: () => string | undefined;
  readonly mcpHost?: Pick<McpHost, "call"> & Partial<Pick<McpHost, "account">>;
  /**
   * The body's GitHub account connection token (ADR 0196). When present it is
   * used instead of `gh`; a hosted body has no `gh` login to fall back on.
   */
  readonly githubToken?: () => Promise<string | undefined>;
  readonly hosted?: boolean;
  /** Test seams; production shells out to git and gh and calls api.github.com. */
  readonly run?: CommandRunner;
  readonly gh?: GhRunner;
  readonly fetch?: typeof fetch;
  readonly githubApiBase?: string;
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
  readonly code:
    | "unknown_repo"
    | "not_found"
    | "needs_decision"
    | "backend_unavailable"
    | "invalid"
    | "result_too_large";
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
  const projectReader =
    options.projects && options.localMachineId
      ? createProjectWorkReader({ projects: options.projects, localMachineId: options.localMachineId })
      : undefined;
  const registryPath = join(options.stateDirectory, "work-repos.json");
  const writeReceipts = new WorkWriteReceipts(join(options.stateDirectory, "work-write-receipts.json"));
  const writeLocks = new Map<string, Promise<unknown>>();
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
            resultMode: "data",
          });
          if (result.outcome === "refused" && result.reason === "result_too_large")
            throw new WorkRequestError("result_too_large", `Linear ${tool}: ${result.detail}`);
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
      root: entry.path,
      ...(convention === undefined ? {} : { backend: convention.backend }),
      needsDecision: convention === undefined,
    };
  };

  const deps = async (path: string): Promise<TrackerDeps> => {
    const token = await options.githubToken?.();
    return {
      run,
      ...(options.hosted === true ? {} : { gh: options.gh ?? defaultGh(path) }),
      ...(token === undefined
        ? {}
        : {
            github: githubRestApi({
              token,
              ...(options.githubApiBase === undefined ? {} : { baseUrl: options.githubApiBase }),
              ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            }),
          }),
      ...(linear === undefined ? {} : { linear }),
      clock,
    };
  };

  const tracker = async (path: string, record: boolean, requireRecorded = false) => {
    try {
      return await resolveTracker(path, await deps(path), { record, requireRecorded });
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

  const authorizeWrite = async (authority: WorkWriteAuthority) => {
    if (!authority.current() || !(await authority.authorize()) || !authority.current())
      throw new Error("Owner authority expired or was revoked. Read the work again.");
  };
  const prepareWrite = async (repoId: string, authority: WorkWriteAuthority) => {
    await authorizeWrite(authority);
    return prepareWorkWriteTarget({
      repoId,
      ...(options.localMachineId === undefined ? {} : { localMachineId: options.localMachineId }),
      ...(options.projectsFence === undefined ? {} : { projectsFence: options.projectsFence }),
      locate: async () => {
        const entry = await locate(repoId, false);
        const registry = () => {
          try {
            return readFileSync(registryPath, "utf8");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
          }
        };
        const saved = registry();
        const workspace = options.workspace?.();
        // Close the await between registry lookup and capturing its generation.
        if (!(await known()).some((repo) => repo.id === repoId && repo.path === entry.path))
          throw new Error("Saved work repository changed.");
        return {
          path: entry.path,
          assertCurrent: () => {
            if (registry() !== saved || options.workspace?.() !== workspace)
              throw new Error("Saved work repository changed.");
          },
        };
      },
    });
  };
  const receipt = (
    requestId: string,
    outcome: WorkItemWriteReceipt["outcome"],
    message: string,
  ): WorkItemWriteReceipt => ({ requestId, outcome, message });
  const accountBinding = async (kind: WorkConvention["backend"]) => {
    if (kind === "linear") {
      if (!options.mcpHost?.account) throw new Error("Connected Linear account cannot be checked.");
      return (await options.mcpHost.account("linear", "operator")).binding;
    }
    if (kind === "github") {
      const token = await options.githubToken?.();
      // Owner writes use the connected account. An ambient gh login is not a bound account.
      if (!token) throw new Error("Connect GitHub to write work from a device.");
      return deliveryFingerprint(token);
    }
    return "files";
  };
  const writeScope = async (request: WorkItemWriteReceiptRequest, authority: WorkWriteAuthority) => {
    const target = await prepareWrite(request.repoId, authority);
    const account = await accountBinding(target.convention.backend);
    await authorizeWrite(authority);
    target.assertCurrent();
    return {
      target,
      account,
      scope: {
        owner: authority.principal,
        repoId: request.repoId,
        itemId: request.itemId,
        binding: deliveryFingerprint(JSON.stringify([target.binding, account])),
      },
    };
  };
  const handleOwnerWrite = async (
    request: WorkItemWriteRequest,
    authority: WorkWriteAuthority,
  ): Promise<WorkItemWriteReceipt> => {
    const key = JSON.stringify([request.repoId, request.itemId]);
    const operation = async (): Promise<WorkItemWriteReceipt> => {
      let begun = false;
      let dispatched = false;
      let confirmed = false;
      try {
        const { target, account, scope } = await writeScope(request, authority);
        const previous = writeReceipts.begin(request.requestId, scope, request.command);
        if (previous) return previous;
        begun = true;
        const beforeWrite = () => {
          if (!authority.current()) throw new Error("Owner authority expired or was revoked.");
          target.assertCurrent();
        };
        const fence = async () => {
          await authorizeWrite(authority);
          beforeWrite();
          return beforeWrite;
        };
        const onDispatch = () => {
          dispatched = true;
        };
        const effectConfirmed = () => {
          confirmed = true;
        };
        const dependencies = await deps(target.path);
        // No inferred backend or gh fallback on the owner-authorized path.
        const writeDeps: { -readonly [K in keyof TrackerDeps]: TrackerDeps[K] } = {
          ...dependencies,
          scopedWrites: true,
          beforeWrite,
          effectConfirmed,
          ...(target.convention.backend === "default" || target.convention.backend === "markdown"
            ? { onDispatch }
            : {}),
        };
        if (target.convention.backend === "linear") {
          writeDeps.linear = async (tool, args) => {
            const writing = tool === "save_issue";
            if (!options.mcpHost) throw new Error("Linear is unavailable.");
            if ((await options.mcpHost.account!("linear", "operator")).binding !== account)
              throw new Error("Connected Linear account changed.");
            const result = await options.mcpHost.call({
              lane: "operator",
              server: "linear",
              tool,
              arguments: args,
              resultMode: "data",
              fence,
              ...(writing ? { onDispatch, onSettled: effectConfirmed } : {}),
            });
            if (result.outcome !== "ok") {
              if (writing) dispatched = result.possiblyDispatched === true;
              throw new Error("Connected provider did not return a settled result.");
            }
            if (result.isError) throw new Error("Connected provider refused the write.");
            return result.content.trim() ? (JSON.parse(result.content) as unknown) : undefined;
          };
        }
        if (target.convention.backend === "github") {
          const api = dependencies.github;
          if (!api) throw new Error("GitHub is unavailable.");
          writeDeps.github = {
            ...api,
            request: async (method, path, body) => {
              if (method !== "GET") {
                await authorizeWrite(authority);
                if ((await accountBinding("github")) !== account)
                  throw new Error("Connected GitHub account changed.");
                beforeWrite();
                onDispatch();
              }
              return api.request(method, path, body);
            },
          };
          delete writeDeps.gh;
        }
        // Files have no credential await; authorization is renewed before preparation and checked at rename.
        await authorizeWrite(authority);
        beforeWrite();
        const backend = backendFor(target.path, target.convention, writeDeps);
        const command = request.command;
        let patch: WorkItemPatch;
        switch (command.action) {
          case "assign":
            patch = { owner: command.owner };
            break;
          case "add_label":
            patch = { addLabels: [command.label] };
            break;
          case "remove_label":
            patch = { removeLabels: [command.label] };
            break;
          case "add_dependency":
            if (command.id === request.itemId) throw new Error("An item cannot block itself.");
            patch = { addDependsOn: [command.id] };
            break;
        }
        const item = await backend.update(request.itemId, patch);
        return writeReceipts.settle(request.requestId, {
          ...receipt(request.requestId, "applied", "Work item updated."),
          item,
        });
      } catch (error) {
        const result = confirmed
          ? receipt(
              request.requestId,
              "applied",
              "The tracker accepted the write. Refresh the item to read its current state.",
            )
          : dispatched
            ? receipt(
                request.requestId,
                "uncertain",
                "The write may have happened. Read this receipt and the tracker; this request will never be replayed.",
              )
            : receipt(
                request.requestId,
                "refused",
                error instanceof Error &&
                  (error.name === "WorkItemScopeError" ||
                    /^(Owner authority|Saved work|Connected .* account|An item cannot|No work item|Work item .*outside|Role label|This project|Project work|Connect GitHub)/u.test(
                      error.message,
                    ))
                  ? error.message
                  : "This saved work tracker cannot accept the write. Read the work again and check its connection.",
              );
        if (!begun) return result;
        try {
          return writeReceipts.settle(request.requestId, result);
        } catch {
          return receipt(
            request.requestId,
            "uncertain",
            "The receipt could not be settled. The write may have happened; inspect the tracker and never resend it.",
          );
        }
      }
    };
    const pending = (writeLocks.get(key) ?? Promise.resolve()).then(operation, operation);
    writeLocks.set(key, pending);
    try {
      return await pending;
    } finally {
      if (writeLocks.get(key) === pending) writeLocks.delete(key);
    }
  };
  return {
    handleOwnerWrite,
    async readOwnerReceipt(
      request: WorkItemWriteReceiptRequest,
      authority: WorkWriteAuthority,
    ): Promise<WorkItemWriteReceipt> {
      try {
        const { scope } = await writeScope(request, authority);
        return writeReceipts.read(request.requestId, scope);
      } catch {
        return receipt(
          request.requestId,
          "refused",
          "No receipt is available for this owner and current work tracker.",
        );
      }
    },
    async handle(request: WorkRequest, local: boolean): Promise<WorkResult> {
      if (request.action === "repos") {
        const repos = [
          ...((await projectReader?.repos()) ?? []),
          ...(await Promise.all((await known()).map(describe))),
        ];
        if (repos.length > WORK_REPO_LIST_MAX)
          throw new WorkRequestError("result_too_large", "There are too many work trackers to list at once.");
        return { repos };
      }
      if (/^project-[a-f0-9]{48}$/u.test(request.repo)) {
        if (request.action !== "list" && request.action !== "show")
          throw new WorkRequestError("invalid", "Project tracker references are read-only");
        try {
          if (!projectReader) throw new Error("Project settings unavailable");
          const read = await projectReader.prepare(request.repo);
          const { backend } = await tracker(read.path, false, true);
          await read.validate();
          if (request.action === "list") {
            const items = await backend.list({
              ...(request.status === undefined ? {} : { status: request.status }),
              ...(request.owner === undefined ? {} : { owner: request.owner }),
              ...(request.label === undefined ? {} : { label: request.label }),
              limit: request.limit ?? 250,
            });
            await read.validate();
            return { repo: read.repo, items };
          }
          const item = await backend.get(request.id);
          await read.validate();
          if (!item) throw new WorkRequestError("not_found", `No work item ${request.id}`);
          return { repo: read.repo, item };
        } catch (error) {
          if (error instanceof WorkRequestError && error.code === "not_found") throw error;
          if (error instanceof WorkRequestError && error.code === "result_too_large")
            throw new WorkRequestError(
              "result_too_large",
              "This project’s work is too large to read at once.",
            );
          throw new WorkRequestError(
            "backend_unavailable",
            "This project’s workspace or saved work tracker can’t be read here. Read the work again.",
          );
        }
      }
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
          if (request.linearLabel !== undefined) {
            if (convention.backend !== "linear" || convention.linear === undefined)
              throw new WorkRequestError(
                "invalid",
                "A Linear board label requires a linear convention with a team",
              );
            convention = WorkConventionSchema.parse({
              ...convention,
              linear: { ...convention.linear, label: request.linearLabel },
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
              ...(request.label === undefined ? {} : { label: request.label }),
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
