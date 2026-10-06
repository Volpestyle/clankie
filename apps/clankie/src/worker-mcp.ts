import { ProjectIdSchema, type ProjectsSettings } from "@clankie/protocol/projects";
import type { FleetSettings } from "@clankie/settings";
import type { LocalFleetIdentity } from "./local-fleet-link.ts";
import type { ProjectProcessProof } from "./project-process-proof.ts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  CapabilityTokenIssuer,
  CapabilityGrantSchema,
  ProviderAccountSchema,
  type CredentialStore,
  verifyLinearApiAccount,
  verifyLinearApiOauthAccount,
  LINEAR_API_PROVIDER_ID,
  verifyLinearAppAccount,
  resolveProviderBearer,
} from "@clankie/credential-broker";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { verifyLinearMcpAccount, type McpHost } from "./mcp-host.ts";
import { isLinearWorkerTool } from "./linear-publishing.ts";
import {
  MinecraftActionSchema,
  WorkerReportBridgeStatusSchema,
  type WorkerBridgeStatus,
  type WorkerReportBridgeStatus,
} from "@clankie/protocol";
import type { MinecraftService } from "./minecraft.ts";
import { DurableReceiptStore } from "./durable-receipt-store.ts";
import { canonicalJson } from "@clankie/play";

const minecraftWorkerSchemas = {
  clankie_minecraft_observe: z.strictObject({}),
  clankie_minecraft_status: z.strictObject({ actionId: z.string().min(1).max(128).optional() }),
  clankie_minecraft_cancel: z.strictObject({ actionId: z.string().min(1).max(128).optional() }),
  clankie_minecraft_act: z.strictObject({
    request: MinecraftActionSchema,
    actionId: z.string().min(1).max(128).optional(),
  }),
};
const minecraftWorkerCatalog = Object.entries(minecraftWorkerSchemas).map(([qualifiedName, schema]) => ({
  qualifiedName,
  description:
    "Drive Clankie's current Minecraft stay only when he explicitly selected your exact fleet principal through minecraft_driver. One driver; the owning conversation keeps its play lease and authority. Read motor settlement and verified evidence separately. No join, configuration, administration or raw motor access.",
  inputSchema: z.toJSONSchema(schema),
}));

const ToolRuleSchema = z
  .object({
    name: z.string().min(1).max(128),
    /** Exact top-level argument restrictions, enforced on every invocation. */
    arguments: z.record(z.string(), z.json()).default({}),
    forbiddenArguments: z.array(z.string().min(1).max(128)).max(64).default([]),
  })
  .strict();
const FleetIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/u);
export const WorkerGrantRequestSchema = z
  .object({
    principalId: z.string().min(1).max(256),
    workId: z.string().min(1).max(256),
    server: z.string().min(1).max(128),
    /** Empty only for a project grant, which then takes the server's whole worker-safe set. */
    tools: z.array(ToolRuleSchema).max(64),
    ttlSeconds: z.number().int().min(1).max(900).default(900),
    project: ProjectIdSchema.optional(),
  })
  .strict()
  .refine((value) => value.tools.length > 0 || value.project !== undefined, "Name at least one tool");
const RecordSchema = z.object({
  grant: CapabilityGrantSchema,
  server: z.string(),
  lane: z.literal("operator"),
  tools: z.array(ToolRuleSchema),
  account: ProviderAccountSchema.optional(),
  backend: z.literal("local").optional(),
  revokedAt: z.string().datetime().optional(),
  fleet: FleetIdSchema.optional(),
  project: ProjectIdSchema.optional(),
});
type GrantRecord = z.infer<typeof RecordSchema>;
type WorkerAuthorization = {
  key: string;
  principalId: string;
  records: GrantRecord[];
  expiresAt: number;
  grantId?: string;
  /** Standing fleet records are synthesized from the current connected catalog, never persisted. */
  fleet?: string;
  pane?: string;
  /** Observational process generation; never part of authorization. */
  bridgeId?: string;
  validateFleet?(signal?: AbortSignal): boolean | Promise<boolean>;
  /** Optional author attribution only; this never changes the connected tool grant. */
  nativeWriteProof?(signal?: AbortSignal): Promise<ProjectProcessProof | undefined>;
  currentFleet?: (() => boolean) | undefined;
};
const FleetSearchSchema = z
  .object({
    query: z.string().max(500).optional(),
    names: z.array(z.string().min(1).max(256)).min(1).max(10).optional(),
  })
  .strict();
const FleetCallSchema = z.union([
  z.strictObject({
    name: z.string().min(1).max(256),
    arguments: z.record(z.string(), z.json()),
    background: z.boolean().optional(),
  }),
  z.strictObject({ receiptId: z.string().uuid() }),
]);
const WorkerCallResultSchema = z.strictObject({
  outcome: z.literal("ok"),
  content: z.string(),
  isError: z.boolean(),
});
const WorkerCallReceiptSchema = z.object({
  id: z.string().uuid(),
  owner: z.string(),
  server: z.string(),
  tool: z.string(),
  binding: z.string(),
  /** Absent only on journals written before caller-held receipt IDs. */
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  createdAt: z.number(),
  state: z.enum(["uncertain", "settled"]),
  reason: z.string().max(500).optional(),
  result: WorkerCallResultSchema.optional(),
});
type WorkerCallReceipt = z.infer<typeof WorkerCallReceiptSchema>;
const uncertainWorkerCall = (receiptId: string, reason?: string) => ({
  outcome: "uncertain" as const,
  receiptId,
  detail: "may have applied; reconcile, don’t retry",
  ...(reason === undefined ? {} : { reason: reason.slice(0, 500) }),
});
const workerCallResponse = <T extends { outcome: string; isError?: boolean }>(result: T) => ({
  content: [{ type: "text" as const, text: JSON.stringify(result) }],
  isError: result.outcome === "uncertain" ? false : result.outcome !== "ok" || result.isError === true,
});
const FLEET_TOOLS = [
  {
    name: "clankie_tools",
    description:
      "Search available tools with query (up to 20 names and one-line descriptions), or request full input schemas with names (up to 10). The linear_* tracker tools use the owner's connected Linear account or durable local fallback. Discover a tool's schema before calling it.",
    inputSchema: z.toJSONSchema(FleetSearchSchema) as { type: "object" },
  },
  {
    name: "clankie_call",
    description:
      "Call an available tool by its qualified name and arguments. Use clankie_tools to find its name and input schema. Tracker calls use the active backend; other provider calls use Clankie's verified connected account. Set background:true for automated polling so reads yield under Linear budget pressure; ordinary owner/lead reads and writes retain priority. Calls return a receiptId. An uncertain call may have applied: reconcile with only {receiptId}, never retry its name and arguments. Receipt lookup is read-only and rechecks current access.",
    inputSchema: { ...z.toJSONSchema(FleetCallSchema), type: "object" as const },
  },
];
const uuid = z.string().uuid();
const KEY_ID = "clankie_worker_mcp_signing";
const WORKER_REQUEST_TIMEOUT_MS = 30_000;
// The local listener delegates MCP admission to this boundary. Preserve its
// public refusal without exposing process, account or credential details.
class LocalFleetAdmissionError extends Error {}
async function beforeWorkerDeadline<T>(
  signal: AbortSignal,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  let aborted!: () => void;
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      aborted = () => reject(new Error(`${name} timed out or was cancelled: ${String(signal.reason)}`));
      signal.addEventListener("abort", aborted, { once: true });
    });
    return await Promise.race([operation(), cancelled]);
  } finally {
    signal.removeEventListener("abort", aborted);
  }
}
const BridgeNotificationSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal("notifications/clankie/bridge_status"),
  id: z.never().optional(),
  params: z.object({
    status: z.enum(["ready", "missing", "stalled"]),
    reason: z.string().max(500),
    tools: z.array(z.string().min(1).max(256)).max(128).optional(),
    report: WorkerReportBridgeStatusSchema.optional(),

    pluginVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/u)
      .optional(),
    runtimeRevision: z.string().min(1).max(256).optional(),
  }),
});

/** Immutable grants plus a durable revocation marker; only the service writes them. */
export class WorkerMcp {
  private issuerPromise: Promise<CapabilityTokenIssuer> | undefined;
  private readonly options: {
    directory: string;
    credentials: CredentialStore;
    host: McpHost;
    projects?(): Promise<ProjectsSettings>;
    fleetTools?(): Promise<FleetSettings["tools"]>;
    fleetPeerMessages?(): Promise<FleetSettings["peerMessages"]>;
    /** The entire worker operation, including admission and provider discovery. */
    requestTimeoutMs?: number;
    reportBridgeObserved?(fleet: string, pane: string, report: WorkerReportBridgeStatus): void;
    /** Canonical settings generation, checked without yielding at provider dispatch. */
    fleetToolsSnapshot?(): Promise<{ tools: FleetSettings["tools"]; assertCurrent(): void }>;
    minecraft?: Pick<MinecraftService, "workerCommand">;
    pluginExpectedVersion?(): string;
    /** Service-owned generation; informative metadata, never an admission credential. */
    runtimeRevision?: string;
    catalogRefreshPending?: (fleet: string, pane: string) => Promise<boolean>;
    pluginVersionObserved?(identity: LocalFleetIdentity, version: string): Promise<boolean>;
  };
  private readonly sessions = new Map<
    string,
    {
      grantId?: string;
      principalKey: string;
      bridgeId?: string;
      server: Server;
      transport: WebStandardStreamableHTTPServerTransport;
      expiresAt: number;
      pluginVersion?: string;
      pluginNoticeVersion?: string;
    }
  >();
  private readonly requestTimeoutMs: number;
  private runtimeRevision: string;
  private readonly catalogRevisions = new Map<string, string>();

  /** Display/refresh signal only: never grants a tool or a delivery capability. */
  requestCatalogRefresh(fleet: string, pane: string, revision: string): void {
    if (!/^[A-Za-z0-9_.:-]{1,256}$/u.test(revision)) throw new Error("Invalid catalog revision");
    this.catalogRevisions.set(JSON.stringify([fleet, pane]), revision);
  }

  expectRuntimeRevision(revision: string): void {
    if (!/^[A-Za-z0-9_.:-]{1,256}$/u.test(revision)) throw new Error("Invalid runtime revision");
    this.runtimeRevision = revision;
    this.catalogRevisions.clear();
  }
  private readonly callReceipts: DurableReceiptStore<WorkerCallReceipt>;
  private closed = false;
  constructor(options: WorkerMcp["options"]) {
    this.options = options;
    this.runtimeRevision = options.runtimeRevision ?? randomUUID();
    const timeout = options.requestTimeoutMs ?? WORKER_REQUEST_TIMEOUT_MS;
    if (!Number.isInteger(timeout) || timeout <= 0) throw new Error("Invalid worker request timeout");
    this.requestTimeoutMs = Math.min(timeout, WORKER_REQUEST_TIMEOUT_MS);
    this.callReceipts = new DurableReceiptStore({
      path: join(options.directory, "receipts", "connected-calls.json"),
      schema: WorkerCallReceiptSchema,
      unreadableMessage: "Worker call receipts are unreadable; no connected call was dispatched",
    });
  }

  private readonly bridges = new Map<
    string,
    {
      generation: string | undefined;
      last?: WorkerBridgeStatus;
      lastReport?: WorkerReportBridgeStatus;

      pluginVersion?: string;
      runtimeRevision?: string;
      active: Map<symbol, { since: number; operation: string }>;
    }
  >();
  private readonly fleetRequests = new Map<
    string,
    { authorize(signal: AbortSignal): Promise<WorkerAuthorization>; signal: AbortSignal; deadline: number }
  >();

  private bridge(authority: WorkerAuthorization) {
    if (this.closed || authority.fleet === undefined || authority.pane === undefined) return undefined;
    const key = JSON.stringify([authority.fleet, authority.pane]);
    let state = this.bridges.get(key);
    if (!state) {
      state = { generation: authority.bridgeId, active: new Map() };
      this.bridges.set(key, state);
    }
    return state.generation === authority.bridgeId ? state : undefined;
  }

  /** Observations explain bridge health; they never grant native or provider authority. */
  bridgeStatus(fleet: string, pane: string): WorkerBridgeStatus {
    const state = this.bridges.get(JSON.stringify([fleet, pane]));
    const pending = state && [...state.active.values()].sort((a, b) => a.since - b.since)[0];
    const expectedPluginVersion = this.options.pluginExpectedVersion?.();
    const version = state?.pluginVersion;
    const expectedRuntimeRevision =
      this.catalogRevisions.get(JSON.stringify([fleet, pane])) ?? this.runtimeRevision;
    const observation = {
      ...(version === undefined ? {} : { pluginVersion: version }),
      ...(expectedPluginVersion === undefined ? {} : { expectedPluginVersion }),
      ...(version === undefined || expectedPluginVersion === undefined
        ? {}
        : {
            behind: version !== expectedPluginVersion || state?.runtimeRevision !== expectedRuntimeRevision,
          }),
      ...(state?.runtimeRevision === undefined ? {} : { runtimeRevision: state.runtimeRevision }),
      expectedRuntimeRevision,
    };
    if (pending) {
      const stalled = Date.now() - pending.since >= this.requestTimeoutMs;
      return {
        status: stalled ? "stalled" : "pending",
        reason: `${pending.operation}${stalled ? " exceeded the worker deadline" : " is pending"}`,
        pendingSince: new Date(pending.since).toISOString(),
        ...(state.last?.tools ? { tools: state.last.tools } : {}),
        ...observation,
      };
    }
    return {
      ...(state?.last ?? {
        status: "not-observed" as const,
        reason: "Worker bridge catalog has not been observed",
      }),
      ...observation,
    };
  }

  reportBridgeStatus(fleet: string, pane: string): WorkerReportBridgeStatus | undefined {
    return this.bridges.get(JSON.stringify([fleet, pane]))?.lastReport;
  }

  /** The caller has freshly admitted the pane; this observation grants no authority. */
  reportBridgeObserved(fleet: string, pane: string, report: WorkerReportBridgeStatus): void {
    if (this.closed) return;
    const key = JSON.stringify([fleet, pane]);
    let state = this.bridges.get(key);
    if (!state) {
      state = { generation: undefined, active: new Map() };
      this.bridges.set(key, state);
    }
    const checked = WorkerReportBridgeStatusSchema.parse(report);
    if (state.lastReport && Date.parse(state.lastReport.observedAt) > Date.parse(checked.observedAt)) return;
    const lastStoredAt = [
      state.lastReport?.lastStoredAt,
      checked.lastStoredAt,
      ...(checked.outcome === "stored" ? [checked.observedAt] : []),
    ]
      .filter((value): value is string => value !== undefined)
      .sort((left, right) => Date.parse(left) - Date.parse(right))
      .at(-1);
    state.lastReport = {
      ...checked,
      ...(lastStoredAt === undefined ? {} : { lastStoredAt }),
    };
    try {
      this.options.reportBridgeObserved?.(fleet, pane, state.lastReport);
    } catch {
      /* Diagnostic failure cannot change receipt delivery. */
    }
  }

  private catalogServed(authority: WorkerAuthorization, tools: string[], connected: boolean): void {
    const state = this.bridge(authority);
    if (
      !state ||
      (connected &&
        (state.last?.reason.startsWith("Native bridge reported") || state.last?.status === "stalled"))
    )
      return;
    state.last = {
      status: connected ? "ready" : "missing",
      reason: connected
        ? "Authenticated connected-tool catalog served; native catalog is unverified"
        : "Fleet connected tools are off",
      tools,
      observedAt: new Date().toISOString(),
    };
  }

  private async bridgeReported(
    authority: WorkerAuthorization,
    reported: z.infer<typeof BridgeNotificationSchema>["params"],
    signal: AbortSignal,
  ): Promise<void> {
    const state = this.bridge(authority);
    if (!state) return;
    const expected = await beforeWorkerDeadline(signal, "Worker bridge health settings", () =>
      this.expectedFleetToolNames(),
    );
    signal.throwIfAborted();
    if (this.bridge(authority) !== state || authority.currentFleet?.() === false) return;
    if (reported.report && authority.fleet !== undefined && authority.pane !== undefined)
      this.reportBridgeObserved(authority.fleet, authority.pane, reported.report);

    if (reported.pluginVersion !== undefined) state.pluginVersion = reported.pluginVersion;
    if (reported.runtimeRevision !== undefined) state.runtimeRevision = reported.runtimeRevision;
    const missing = expected.filter((name) => !reported.tools?.includes(name));
    if (state.last?.status === "stalled" && reported.status === "ready") return;
    state.last = {
      status: reported.status === "ready" && missing.length ? "missing" : reported.status,
      reason:
        `Native bridge reported: ${reported.status === "ready" && missing.length ? `missing ${missing.join(", ")}` : reported.reason}`.slice(
          0,
          500,
        ),
      ...(reported.tools ? { tools: reported.tools } : {}),
      observedAt: new Date().toISOString(),
    };
  }

  private async operation<T>(
    authority: WorkerAuthorization,
    token: string,
    cancellation: AbortSignal,
    name: string,
    work: (signal: AbortSignal, remaining: () => number) => Promise<T>,
  ): Promise<T> {
    const request = this.fleetRequests.get(token);
    const duration = this.requestTimeoutMs;
    const deadline = request?.deadline ?? Date.now() + duration;
    const signal = AbortSignal.any([cancellation, request?.signal ?? AbortSignal.timeout(duration)]);
    const remaining = () => Math.max(1, deadline - Date.now());
    const state = this.bridge(authority);
    const id = Symbol(name);
    state?.active.set(id, { since: Date.now(), operation: name });
    try {
      const result = await beforeWorkerDeadline(signal, name, () => work(signal, remaining));
      return result;
    } catch (error) {
      if (signal.aborted && state)
        state.last = {
          status: "stalled",
          reason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
          observedAt: new Date().toISOString(),
          ...(state.last?.tools ? { tools: state.last.tools } : {}),
        };
      throw error;
    } finally {
      state?.active.delete(id);
    }
  }

  private async fleetRequest(
    request: Request,
    authorize: (signal: AbortSignal) => Promise<WorkerAuthorization>,
    observed?: (response: Response, signal: AbortSignal) => Promise<void>,
  ): Promise<Response> {
    const proof = randomUUID();
    const duration = this.requestTimeoutMs;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(duration)]);
    const bridgeId = uuid.safeParse(request.headers.get("x-clankie-bridge-id"));
    this.fleetRequests.set(proof, { authorize, signal, deadline: Date.now() + duration });
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${proof}`);
    try {
      const response = await this.handleAuthorized(
        new Request(request, { headers, signal }),
        async (token, cancellation) => {
          const current = this.fleetRequests.get(token);
          if (!current) throw new Error("Fleet request no longer active");
          const admissionSignal = cancellation
            ? AbortSignal.any([current.signal, cancellation])
            : current.signal;
          admissionSignal.throwIfAborted();
          const authority = await beforeWorkerDeadline(admissionSignal, "Worker fleet authentication", () =>
            current.authorize(admissionSignal),
          );
          admissionSignal.throwIfAborted();
          return { ...authority, ...(bridgeId.success ? { bridgeId: bridgeId.data } : {}) };
        },
      );
      if (observed) {
        const noticeSignal = AbortSignal.any([signal, AbortSignal.timeout(2_000)]);
        await beforeWorkerDeadline(noticeSignal, "Worker plugin notice", () =>
          observed(response, noticeSignal),
        ).catch(() => undefined);
      }
      return response;
    } finally {
      this.fleetRequests.delete(proof);
    }
  }

  private issuer(): Promise<CapabilityTokenIssuer> {
    return (this.issuerPromise ??= (async () => {
      let key = await this.options.credentials.get(KEY_ID);
      if (key === undefined) {
        await this.options.credentials.set(KEY_ID, {
          type: "api",
          key: randomBytes(32).toString("base64url"),
        });
        key = await this.options.credentials.get(KEY_ID);
      }
      if (key?.type !== "api") throw new Error("Worker MCP signing credential unavailable");
      return new CapabilityTokenIssuer(Buffer.from(key.key, "base64url"));
    })().catch((error: unknown) => {
      this.issuerPromise = undefined;
      throw error;
    }));
  }

  private path(id: string) {
    return join(this.options.directory, `${uuid.parse(id)}.json`);
  }
  private async read(id: string): Promise<GrantRecord> {
    const record = await this.loadRecord(id);
    if (!record) throw new Error("Retired worker grant");
    return record;
  }

  private async loadRecord(id: string): Promise<GrantRecord | undefined> {
    const raw = JSON.parse(await readFile(this.path(id), "utf8"));
    // Retired task-bound authority must never become an unbound manual grant.
    if (raw.swarm !== undefined || raw.renewable === true) return undefined;
    return RecordSchema.parse(raw);
  }

  async linearAccount(verify = false) {
    const provider = (await this.options.credentials.get(LINEAR_API_PROVIDER_ID))
      ? LINEAR_API_PROVIDER_ID
      : "linear";
    if (verify) {
      const update = this.options.credentials.update;
      if (update === undefined) throw new Error("Credential store cannot verify accounts atomically");
      // Persist rotated refresh tokens even if the subsequent identity read fails.
      await resolveProviderBearer(provider, this.options.credentials);
      const result = await update.call(this.options.credentials, provider, async (current) => {
        if (current.type === "wellknown") throw new Error("Unsupported Linear credential type");
        const account =
          current.type === "api"
            ? await verifyLinearApiAccount(current.key)
            : current.linearAuth === "api"
              ? await verifyLinearApiOauthAccount(current.access, fetch, [current.refresh])
              : current.linearAuth === "app"
                ? await verifyLinearAppAccount(current.access)
                : await verifyLinearMcpAccount(current);
        if (current.account?.userId === account.userId && current.account.workspaceId === account.workspaceId)
          account.connectionId = current.account.connectionId;
        return { ...current, account };
      });
      if (result === undefined) throw new Error("Linear is not connected");
    }
    const current = await this.options.credentials.get(provider);
    if (current === undefined) return { status: "disconnected" as const };
    if (!("account" in current) || current.account === undefined)
      return { status: "unverified" as const, type: current.type };
    return { status: "verified" as const, account: current.account };
  }

  async issue(input: z.input<typeof WorkerGrantRequestSchema>) {
    if ("fleet" in input)
      throw new Error(
        "Fleet grants are retired. Admitted fleet members use connected tools; inspect clankie fleet status and revoke old records with clankie access revoke ID.",
      );
    const request = WorkerGrantRequestSchema.parse(input);
    if (request.server === "minecraft") throw new Error("Clankie's Minecraft play seat cannot be delegated");
    if (request.project !== undefined) {
      const project = (await this.options.projects?.())?.projects.find(
        (project) => project.id === request.project,
      );
      if (!project) throw new Error("Create this project before granting its tools.");
      if (request.principalId !== `project:${project.id}` || request.workId !== `project:${project.id}`)
        throw new Error("Project grants must name their project as the principal and work.");
    }
    const { account, binding, backend } = await this.binding(request.server, "operator");
    const catalog = await this.options.host.catalog("operator");
    if (request.tools.length === 0)
      // A project's standing access: the server's tools, minus worker publishing,
      // which must name the persona it writes as.
      request.tools = catalog
        .filter(
          (tool) =>
            tool.server === request.server && !(request.server === "linear" && isLinearWorkerTool(tool.name)),
        )
        .map((tool) => ({ name: tool.name, arguments: {}, forbiddenArguments: [] }));
    if (request.tools.length === 0) throw new Error(`No tools are available on ${request.server}`);
    if (new Set(request.tools.map((tool) => tool.name)).size !== request.tools.length)
      throw new Error("Tool names must be unique");
    for (const rule of request.tools) {
      if (
        request.server === "linear" &&
        isLinearWorkerTool(rule.name) &&
        typeof rule.arguments.personaId !== "string"
      )
        throw new Error("Worker publishing grants must bind an exact personaId");
      if (!catalog.some((tool) => tool.server === request.server && tool.name === rule.name))
        throw new Error(`Unavailable tool: ${rule.name}`);
    }
    const now = Math.floor(Date.now() / 1000);
    const record: GrantRecord = {
      server: request.server,
      lane: "operator",
      tools: request.tools,
      ...(account === undefined ? {} : { account }),
      ...(backend === undefined ? {} : { backend }),
      ...(request.project === undefined ? {} : { project: request.project }),
      grant: {
        version: 1,
        grantId: randomUUID(),
        principalId: request.principalId,
        missionId: request.workId,
        profileHash: binding,
        capabilities: request.tools.map((tool) => tool.name),
        resources: [request.server],
        obligations: [],
        issuedAt: now,
        expiresAt: now + request.ttlSeconds,
        nonce: randomUUID(),
      },
    };
    const token = (await this.issuer()).issue(record.grant);
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    await writeFile(this.path(record.grant.grantId), JSON.stringify(record), { mode: 0o600, flag: "wx" });
    await this.notify(record);
    return { ...record, token };
  }

  private async notify(record: GrantRecord) {
    if (record.project === undefined) return;
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => session.grantId === undefined)
        .map((session) => session.server.sendToolListChanged().catch(() => undefined)),
    );
  }

  async list(): Promise<GrantRecord[]> {
    const files = await readdir(this.options.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const records = await Promise.all(
      files.filter((file) => file.endsWith(".json")).map((file) => this.loadRecord(file.slice(0, -5))),
    );
    return records.filter((record): record is GrantRecord => record !== undefined);
  }

  async revoke(id: string) {
    const record = await this.read(id);
    if (record.revokedAt === undefined) {
      record.revokedAt = new Date().toISOString();
      const temporary = `${this.path(id)}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
      await rename(temporary, this.path(id));
    }
    for (const [sessionId, session] of this.sessions) {
      if (session.grantId === id) {
        this.sessions.delete(sessionId);
        await session.server.close();
      }
    }
    await this.notify(record);
    return record;
  }

  private async authorize(token: string): Promise<GrantRecord> {
    const verified = (await this.issuer()).verify(token);
    const record = await this.read(verified.grant.grantId);
    if (
      record.revokedAt !== undefined ||
      !isDeepStrictEqual(record.grant, verified.grant) ||
      verified.grant.issuedAt < record.grant.issuedAt ||
      verified.grant.expiresAt - verified.grant.issuedAt > record.grant.expiresAt - record.grant.issuedAt
    )
      throw new Error("Worker grant revoked or changed");
    if (record.fleet !== undefined || record.project !== undefined)
      throw new Error("This grant requires current project membership");
    await this.checkBinding(record);
    return { ...record, grant: verified.grant };
  }

  private async checkBinding(record: GrantRecord) {
    if (record.revokedAt !== undefined) throw new Error("Worker grant revoked");
    const current = await this.binding(record.server, record.lane);
    if (current.binding !== record.grant.profileHash) throw new Error("Delegated account changed");
  }

  private binding(server: string, lane: "operator") {
    if (this.options.host.binding) return this.options.host.binding(server, lane);
    return this.options.host.account(server, lane) as Promise<{
      account?: z.infer<typeof ProviderAccountSchema>;
      binding: string;
      backend?: "local";
    }>;
  }

  private beginCallReceipt(
    id: string,
    authority: WorkerAuthorization,
    record: GrantRecord,
    tool: string,
    fingerprint: string,
  ): WorkerCallReceipt | undefined {
    const records = this.callReceipts.load();
    const previous = records.get(id);
    if (previous) {
      this.assertCallReceipt(previous, authority, record, tool, fingerprint);
      return previous;
    }
    records.set(id, {
      id,
      owner: authority.key,
      server: record.server,
      tool,
      binding: record.grant.profileHash,
      fingerprint,
      createdAt: Date.now(),
      state: "uncertain",
    });
    // Admission is durable before the synchronous hook permits provider dispatch.
    this.callReceipts.save();
    return undefined;
  }

  private assertCallReceipt(
    receipt: WorkerCallReceipt,
    authority: WorkerAuthorization,
    record: GrantRecord,
    tool: string,
    fingerprint: string,
  ): void {
    if (
      receipt.owner !== authority.key ||
      receipt.server !== record.server ||
      receipt.tool !== tool ||
      receipt.binding !== record.grant.profileHash ||
      receipt.fingerprint !== fingerprint
    )
      throw new Error(
        "Worker call receipt ID does not match its original owner, account, tool and arguments",
      );
  }

  private callReceiptResult(receipt: WorkerCallReceipt) {
    return receipt.result
      ? { ...receipt.result, receiptId: receipt.id }
      : uncertainWorkerCall(receipt.id, receipt.reason);
  }

  private uncertainCallReceipt(receiptId: string, reason: string) {
    try {
      const receipt = this.callReceipts.load().get(receiptId);
      if (receipt && receipt.state === "uncertain") {
        receipt.reason = reason.slice(0, 500);
        this.callReceipts.save();
      }
    } catch {
      // A receipt-journal failure after admission cannot make a write retryable.
    }
    return uncertainWorkerCall(receiptId, reason);
  }

  private settleCallReceipt(id: string, result: z.infer<typeof WorkerCallResultSchema>): void {
    const record = this.callReceipts.load().get(id);
    if (!record) throw new Error("Missing original worker call receipt");
    record.state = "settled";
    record.result = result;
    this.callReceipts.save();
  }

  private async reconcileCallReceipt(receiptId: string, authority: WorkerAuthorization, signal: AbortSignal) {
    receiptId = receiptId.toLowerCase();
    const receipt = this.callReceipts.load().get(receiptId);
    // The original may still be awaiting admission. Mere absence cannot prove
    // that it will never dispatch, and this read never permits a retry.
    if (!receipt) return uncertainWorkerCall(receiptId);
    if (receipt.owner !== authority.key) throw new Error("Worker call receipt unavailable");
    const records =
      authority.fleet === undefined
        ? authority.records
        : await this.connectedFleetRecords(authority, `${receipt.server}_${receipt.tool}`);
    signal.throwIfAborted();
    const current = records.find(
      (record) =>
        record.server === receipt.server &&
        record.grant.profileHash === receipt.binding &&
        record.tools.some((rule) => rule.name === receipt.tool),
    );
    if (!current) throw new Error("Worker call receipt unavailable with current access");
    await this.checkBinding(current);
    if (authority.fleet !== undefined) {
      if (!(await authority.validateFleet!())) throw new Error("Fleet admission unavailable");
      const snapshot = await this.options.fleetToolsSnapshot?.();
      if (snapshot) {
        if (snapshot.tools !== "connected") throw new Error("Fleet tools are off");
        snapshot.assertCurrent();
      } else if (!(await this.fleetToolsEnabled())) throw new Error("Fleet tools are off");
      if (authority.currentFleet?.() !== true) throw new Error("Fleet admission unavailable");
    }
    signal.throwIfAborted();
    // Reload after fresh authorization: the original call may have settled meanwhile.
    const latest = this.callReceipts.load().get(receiptId)!;
    return this.callReceiptResult(latest);
  }

  async handle(request: Request): Promise<Response> {
    return this.handleAuthorized(request, async (token) => {
      const record = await this.authorize(token);
      return {
        key: JSON.stringify(["grant", record.grant.grantId]),
        principalId: record.grant.principalId,
        records: [record],
        expiresAt: record.grant.expiresAt,
        grantId: record.grant.grantId,
      };
    });
  }

  async handleLocalFleet(request: Request, identity: LocalFleetIdentity): Promise<Response> {
    return this.fleetRequest(
      request,
      async (signal) => {
        if (!(await identity.validate(signal)))
          throw new LocalFleetAdmissionError("Local fleet membership unavailable");
        const fleet = identity.fleet ?? "default";
        return this.fleetAuthorization(
          fleet,
          (cancellation) =>
            identity.validate(cancellation ? AbortSignal.any([signal, cancellation]) : signal),
          identity.current === undefined ? undefined : () => identity.current!(),
          identity.pane,
          async (cancellation) => {
            const attributionSignal = cancellation ? AbortSignal.any([signal, cancellation]) : signal;
            if (!(await identity.validate(attributionSignal))) return undefined;
            const observed = await identity.projectProof?.(attributionSignal);
            if (
              observed?.fleet !== fleet ||
              observed.pane !== identity.pane ||
              !(await identity.validate(attributionSignal))
            )
              return undefined;
            return observed;
          },
        );
      },
      async (response, signal) => {
        const id = response.headers.get("mcp-session-id") ?? request.headers.get("mcp-session-id") ?? "";
        const session = this.sessions.get(id);
        const version = session?.pluginVersion;
        if (!response.ok || !session || typeof version !== "string") return;
        // Display delivery is bounded and cannot deny tools or cause an uncertain replay.
        const expected = this.options.pluginExpectedVersion?.();
        if (session.pluginNoticeVersion === expected && expected !== undefined) return;
        const noticeIdentity: LocalFleetIdentity = {
          ...identity,
          validate: (cancellation) =>
            identity.validate(cancellation ? AbortSignal.any([signal, cancellation]) : signal),
          ...(identity.projectProof
            ? {
                projectProof: (cancellation?: AbortSignal) =>
                  identity.projectProof!(cancellation ? AbortSignal.any([signal, cancellation]) : signal),
              }
            : {}),
        };
        const delivered = await this.options.pluginVersionObserved?.(noticeIdentity, version);
        signal.throwIfAborted();
        if (delivered && expected !== undefined && this.sessions.get(id) === session)
          session.pluginNoticeVersion = expected;
      },
    );
  }

  /** A bearer link admits its fleet, without claiming a verified pane or native occupant. */
  async handleFleet(fleet: string, request: Request, linked: (token: string) => boolean): Promise<Response> {
    const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/u)?.[1];
    return this.fleetRequest(request, async () => {
      if (token === undefined || !linked(token)) throw new Error("Not this fleet's link");
      return this.fleetAuthorization(
        fleet,
        () => linked(token),
        () => linked(token),
      );
    });
  }

  /** Read-only startup expectation. This never authorizes a request or creates an identity. */
  async expectedProjectToolNames(_projectId: string): Promise<readonly string[]> {
    return this.expectedFleetToolNames();
  }

  async expectedFleetToolNames(): Promise<readonly string[]> {
    return [
      ...((await this.fleetToolsEnabled()) ? FLEET_TOOLS.map((tool) => tool.name) : []),
      ...((await this.options.fleetPeerMessages?.()) === "on" ? ["list_fleet_seats", "message_peer"] : []),
    ];
  }

  private async fleetToolsEnabled(): Promise<boolean> {
    return (await this.options.fleetTools?.()) !== "off";
  }

  private async fleetAuthorization(
    fleet: string,
    validateFleet: NonNullable<WorkerAuthorization["validateFleet"]>,
    currentFleet: WorkerAuthorization["currentFleet"],
    pane?: string,
    nativeWriteProof?: WorkerAuthorization["nativeWriteProof"],
  ): Promise<WorkerAuthorization> {
    FleetIdSchema.parse(fleet);
    const principalId = `fleet:${fleet}:pane:${pane ?? "unverified"}`;
    const expiresAt = Math.floor(Date.now() / 1000) + 900;
    return {
      key: JSON.stringify(pane === undefined ? ["fleet", fleet] : ["fleet", fleet, pane]),
      principalId,
      records: [],
      expiresAt,
      fleet,
      ...(pane === undefined ? {} : { pane }),
      validateFleet,
      ...(nativeWriteProof ? { nativeWriteProof } : {}),
      currentFleet,
    };
  }

  /** Provider/account discovery happens on invocation, never wrapper discovery or initialize. */
  private async connectedFleetRecords(
    authority: WorkerAuthorization,
    wanted?: string,
  ): Promise<GrantRecord[]> {
    const { principalId, expiresAt, fleet } = authority;
    const records: GrantRecord[] = [];
    if (await this.fleetToolsEnabled()) {
      const catalog = (await this.options.host.catalog("operator")).filter(
        (tool) => tool.server !== "minecraft" && (wanted === undefined || tool.qualifiedName === wanted),
      );
      for (const server of new Set(catalog.map((tool) => tool.server))) {
        try {
          const { account, binding, backend } = await this.binding(server, "operator");
          const tools = catalog
            .filter(
              (tool) => tool.server === server && !(server === "linear" && isLinearWorkerTool(tool.name)),
            )
            .map((tool) => ({ name: tool.name, arguments: {}, forbiddenArguments: [] }));
          if (!tools.length) continue;
          records.push({
            server,
            lane: "operator",
            tools,
            ...(account === undefined ? {} : { account }),
            ...(backend === undefined ? {} : { backend }),
            grant: {
              version: 1,
              grantId: randomUUID(),
              principalId,
              missionId: `fleet:${fleet}`,
              profileHash: binding,
              capabilities: tools.map((tool) => tool.name),
              resources: [server],
              obligations: [],
              issuedAt: expiresAt - 900,
              expiresAt,
              nonce: randomUUID(),
            },
          });
        } catch (error) {
          if (wanted?.startsWith(`${server}_`)) throw error;
          // One unverified/unavailable account never removes the other servers.
        }
      }
    }
    return records;
  }

  private async handleAuthorized(
    request: Request,
    authenticate: (token: string, signal?: AbortSignal) => Promise<WorkerAuthorization>,
  ): Promise<Response> {
    if (this.closed) return Response.json({ error: "worker_bridge_closed" }, { status: 503 });
    const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/u)?.[1];
    if (token === undefined)
      return Response.json({ error: "worker_authentication_required" }, { status: 401 });
    let authority: WorkerAuthorization;
    try {
      authority = await authenticate(token, request.signal);
    } catch (error) {
      if (request.signal.aborted)
        return Response.json(
          { error: "worker_authentication_timeout", reason: "Worker admission timed out or was cancelled" },
          { status: 504 },
        );
      if (error instanceof LocalFleetAdmissionError)
        return Response.json({ error: "local_process_membership_required" }, { status: 403 });
      return Response.json(
        { error: "worker_grant_unavailable", reason: "Worker access unavailable" },
        { status: 403 },
      );
    }
    const id = request.headers.get("mcp-session-id");
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt <= Date.now() / 1000) {
        this.sessions.delete(sessionId);
        await session.server.close();
      }
    }
    if (id !== null) {
      const session = this.sessions.get(id);
      if (session === undefined) return Response.json({ error: "unknown_session" }, { status: 404 });
      if (session.principalKey !== authority.key || session.bridgeId !== authority.bridgeId)
        return Response.json({ error: "worker_session_forbidden" }, { status: 403 });
      session.expiresAt = Math.max(session.expiresAt, authority.expiresAt);
      if (request.method === "POST") {
        try {
          const body = await beforeWorkerDeadline(request.signal, "Worker request body", () =>
            request
              .clone()
              .json()
              .catch(() => undefined),
          );
          const notification = BridgeNotificationSchema.safeParse(body);
          if (notification.success) {
            // Notifications have no SDK auth extras. Their HTTP request has just
            // passed the same fresh fleet and session checks as a tool request.
            await this.operation(authority, token, request.signal, "Worker bridge health update", (signal) =>
              this.bridgeReported(authority, notification.data.params, signal),
            );
            return new Response(null, { status: 202, headers: { "mcp-session-id": id } });
          }
        } catch (error) {
          return Response.json(
            {
              error: "worker_request_failed",
              reason: error instanceof Error ? error.message : String(error),
            },
            { status: request.signal.aborted ? 504 : 400 },
          );
        }
      }
      const response = await session.transport.handleRequest(request, {
        authInfo: { token, clientId: authority.principalId, scopes: [] },
      });
      if (request.method === "DELETE" && response.ok) {
        this.sessions.delete(id);
        await session.server.close();
      }
      return response;
    }
    if (request.method !== "POST") return Response.json({ error: "session_required" }, { status: 400 });
    let parsedBody: unknown;
    try {
      parsedBody = await beforeWorkerDeadline(request.signal, "Worker initialize body", () =>
        request
          .clone()
          .json()
          .catch(() => undefined),
      );
    } catch (error) {
      return Response.json(
        { error: "worker_request_failed", reason: error instanceof Error ? error.message : String(error) },
        { status: request.signal.aborted ? 504 : 400 },
      );
    }
    const initialize = InitializeRequestSchema.safeParse(parsedBody);
    const server = new Server(
      { name: "clankie-worker", version: "1" },
      {
        capabilities: { tools: { listChanged: true } },
        instructions: `Connected tools for worker ${authority.principalId}. Fleet members discover tools with clankie_tools and invoke them with clankie_call; manual grants expose their selected tools directly. You remain a worker; this is not Clankie's operator seat.`,
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) =>
      this.operation(
        authority,
        extra.authInfo?.token ?? "",
        extra.signal,
        "Worker catalog discovery",
        async (signal) => {
          const current = await authenticate(extra.authInfo?.token ?? "", signal);
          signal.throwIfAborted();
          if (current.key !== authority.key) throw new Error("Worker session changed");
          if (current.fleet !== undefined) {
            const connected = await this.fleetToolsEnabled();
            const peerMessages = (await this.options.fleetPeerMessages?.()) ?? "off";
            const refreshPending =
              this.options.catalogRefreshPending && current.pane !== undefined
                ? await beforeWorkerDeadline(signal, "Native catalog publication boundary", () =>
                    this.options.catalogRefreshPending!(current.fleet!, current.pane!),
                  )
                : false;
            signal.throwIfAborted();
            const tools = connected ? FLEET_TOOLS : [];
            this.catalogServed(
              current,
              tools.map((tool) => tool.name),
              connected,
            );
            return {
              tools,
              _meta: {
                clankie: {
                  tools: connected ? "connected" : "off",
                  peerMessages,
                  refreshPending,
                  runtimeRevision:
                    this.catalogRevisions.get(JSON.stringify([authority.fleet, authority.pane])) ??
                    this.runtimeRevision,
                  ...(this.options.pluginExpectedVersion === undefined
                    ? {}
                    : { pluginVersion: this.options.pluginExpectedVersion() }),
                },
              },
            };
          }
          const catalog = current.records.length ? await this.options.host.catalog("operator") : [];
          return {
            tools: catalog
              .filter((tool) =>
                current.records.some(
                  (record) =>
                    record.server === tool.server && record.tools.some((rule) => rule.name === tool.name),
                ),
              )
              .map((tool) => ({
                name: tool.qualifiedName,
                description: tool.description,
                inputSchema: tool.inputSchema as { type: "object" },
              })),
          };
        },
      ),
    );
    server.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
      let receiptId: string | undefined;
      let admitted = false;
      let repeatedReceipt: WorkerCallReceipt | undefined;
      let unadmittedSettlement = false;
      let background = call.params._meta?.clankieRequestPriority === "background";
      try {
        if (call.params._meta?.clankieRequestPriority !== undefined && !background)
          throw new Error("Invalid request priority");
        return await this.operation(
          authority,
          extra.authInfo?.token ?? "",
          extra.signal,
          "Worker tool call",
          async (signal, remaining) => {
            const authorityNow = await authenticate(extra.authInfo?.token ?? "", signal);
            signal.throwIfAborted();
            if (authorityNow.key !== authority.key) throw new Error("Worker session changed");
            let name = call.params.name;
            let args = call.params.arguments ?? {};
            if (authorityNow.fleet === undefined && name === "clankie_call") {
              const reconciliation = z.strictObject({ receiptId: uuid }).parse(args);
              return workerCallResponse(
                await this.reconcileCallReceipt(reconciliation.receiptId, authorityNow, signal),
              );
            }
            if (authorityNow.fleet !== undefined) {
              if (!(await this.fleetToolsEnabled())) throw new Error("Fleet tools are off");
              if (name === "clankie_tools") {
                const search = FleetSearchSchema.parse(args);
                authorityNow.records = await this.connectedFleetRecords(authorityNow);
                const connected = (await this.options.host.catalog("operator")).filter((tool) =>
                  authorityNow.records.some(
                    (record) =>
                      record.server === tool.server && record.tools.some((rule) => rule.name === tool.name),
                  ),
                );
                const catalog = [
                  ...connected,
                  ...(this.options.minecraft === undefined ? [] : minecraftWorkerCatalog),
                ];
                const terms = (search.query ?? "").toLowerCase().split(/\s+/u).filter(Boolean);
                const text = search.names
                  ? JSON.stringify(
                      catalog
                        .filter((tool) => search.names!.includes(tool.qualifiedName))
                        .map((tool) => ({
                          name: tool.qualifiedName,
                          description: tool.description,
                          inputSchema: tool.inputSchema,
                        })),
                    )
                  : (() => {
                      // Rank by how many query words a tool matches: agents write
                      // several words ("linear issue create"), and requiring all of
                      // them in one tool returned nothing.
                      const ranked = catalog
                        .map((tool) => {
                          const haystack = `${tool.qualifiedName} ${tool.description ?? ""}`.toLowerCase();
                          return { tool, hits: terms.filter((term) => haystack.includes(term)).length };
                        })
                        .filter(({ hits }) => terms.length === 0 || hits > 0)
                        .sort((a, b) => b.hits - a.hits)
                        .slice(0, 20)
                        .map(
                          ({ tool }) =>
                            `${tool.qualifiedName} — ${(tool.description ?? "").replace(/\s+/gu, " ").trim()}`,
                        );
                      return ranked.length > 0 || catalog.length === 0
                        ? ranked.join("\n")
                        : "No connected tool matches those words. Try one word, such as a service name.";
                    })();
                return { content: [{ type: "text", text }], isError: false };
              }
              if (name !== "clankie_call") throw new Error("Use clankie_call for connected tools");
              const invocation = FleetCallSchema.parse(args);
              if ("receiptId" in invocation)
                return workerCallResponse(
                  await this.reconcileCallReceipt(invocation.receiptId, authorityNow, signal),
                );
              name = invocation.name;
              args = invocation.arguments;
              background ||= invocation.background === true;
            }
            if (Object.hasOwn(minecraftWorkerSchemas, name)) {
              if (authorityNow.fleet === undefined || this.options.minecraft === undefined)
                throw new Error("Minecraft driver requires an admitted fleet channel");
              const input = minecraftWorkerSchemas[name as keyof typeof minecraftWorkerSchemas].parse(args);
              const action = name.slice("clankie_minecraft_".length) as
                | "act"
                | "observe"
                | "status"
                | "cancel";
              const result = await this.options.minecraft.workerCommand(
                { action, ...input },
                {
                  principalId: authorityNow.principalId,
                  guard: async () => {
                    signal.throwIfAborted();
                    if (!(await authorityNow.validateFleet!()))
                      throw new Error("Fleet admission unavailable");
                    const snapshot = await this.options.fleetToolsSnapshot?.();
                    if (snapshot?.tools !== "connected")
                      throw new Error("Fleet tools are off or unavailable");
                    snapshot.assertCurrent();
                    if (authorityNow.currentFleet?.() !== true)
                      throw new Error("Fleet admission unavailable");
                    return () => {
                      signal.throwIfAborted();
                      snapshot.assertCurrent();
                      if (authorityNow.currentFleet?.() !== true)
                        throw new Error("Fleet admission unavailable");
                    };
                  },
                },
              );
              return { content: [{ type: "text", text: JSON.stringify(result) }], isError: false };
            }
            if (authorityNow.fleet !== undefined)
              authorityNow.records = await this.connectedFleetRecords(authorityNow, name);
            const current = authorityNow.records.find((record) =>
              record.tools.some(
                (rule) =>
                  `${record.server}_${rule.name}` === name &&
                  rule.forbiddenArguments.every((key) => !Object.hasOwn(args, key)) &&
                  Object.entries(rule.arguments).every(([key, value]) => isDeepStrictEqual(args[key], value)),
              ),
            );
            if (!current || current.server === "minecraft")
              throw new Error("Tool or arguments are not granted");
            const rule = current.tools.find((rule) => `${current.server}_${rule.name}` === name)!;
            // Manual authority stays durable; fleet authority comes from live admission and
            // the current catalog. Both retain the host's final account/config fence.
            await this.checkBinding(current);
            if (authorityNow.fleet === undefined) {
              const latest = await this.read(current.grant.grantId);
              if (latest.revokedAt !== undefined || !isDeepStrictEqual(latest, current))
                throw new Error("Worker grant revoked or changed");
            } else {
              if (!(await this.fleetToolsEnabled())) throw new Error("Fleet tools are off");
              if (!(await authorityNow.validateFleet!())) throw new Error("Fleet admission unavailable");
            }
            const suppliedId = call.params._meta?.clankieReceiptId;
            receiptId = suppliedId === undefined ? randomUUID() : uuid.parse(suppliedId).toLowerCase();
            const id = receiptId;
            const fingerprint = createHash("sha256")
              .update(canonicalJson([name, args]))
              .digest("hex");
            const previous = this.callReceipts.load().get(id);
            if (previous) {
              this.assertCallReceipt(previous, authorityNow, current, rule.name, fingerprint);
              return workerCallResponse(await this.reconcileCallReceipt(id, authorityNow, signal));
            }
            const result = await this.options.host.call({
              ...(background ? { requestPriority: "background" as const } : {}),
              timeoutMs: remaining(),
              onDispatch: () => {
                signal.throwIfAborted();
                if (!admitted) {
                  const previous = this.beginCallReceipt(id, authorityNow, current, rule.name, fingerprint);
                  if (previous) {
                    repeatedReceipt = previous;
                    // Another request admitted this ID while host discovery awaited.
                    // Throwing here refuses the second provider dispatch.
                    throw new Error("Worker call already admitted; reconcile its receipt");
                  }
                  admitted = true;
                }
              },
              onSettled: (settled, observation) => {
                if (!admitted) {
                  const previous = this.beginCallReceipt(id, authorityNow, current, rule.name, fingerprint);
                  if (previous) {
                    repeatedReceipt = previous;
                    return;
                  }
                  admitted = true;
                  if (observation?.readOnly !== true) {
                    // An unexpected unadmitted effect must remain uncertain,
                    // with a tombstone preventing this ID from executing again.
                    unadmittedSettlement = true;
                    return;
                  }
                }
                this.settleCallReceipt(id, {
                  outcome: "ok",
                  content: settled.content,
                  isError: settled.isError,
                });
                const health = this.bridge(authorityNow);
                if (!settled.isError && health?.last?.status === "stalled")
                  health.last = {
                    ...health.last,
                    status: "ready",
                    reason: "Connected tool call completed after the earlier timeout",
                    observedAt: new Date().toISOString(),
                  };
              },
              lane: current.lane,
              server: current.server,
              tool: rule.name,
              arguments: args,
              ...(authorityNow.nativeWriteProof
                ? {
                    nativeWriteProof: (attributionSignal?: AbortSignal) =>
                      authorityNow.nativeWriteProof!(
                        attributionSignal ? AbortSignal.any([signal, attributionSignal]) : signal,
                      ),
                  }
                : {}),
              delegation: {
                binding: current.grant.profileHash,
                grantId: current.grant.grantId,
                principalId: current.grant.principalId,
                workId: current.grant.missionId,
              },
              // The host awaits credentials and connections after these checks; recheck
              // fleet authority at its last moment before the provider call.
              ...(authorityNow.fleet === undefined
                ? {}
                : {
                    // Admission can await I/O; read the kill switch after it.
                    fence: async () => {
                      signal.throwIfAborted();
                      if (!(await authorityNow.validateFleet!()))
                        throw new Error("Fleet admission unavailable");
                      const snapshot = await this.options.fleetToolsSnapshot?.();
                      if (snapshot?.tools !== "connected")
                        throw new Error("Fleet tools are off or unavailable");
                      // The host still has account/configuration I/O to finish. These
                      // canonical checks must not yield after that last awaited read.
                      return () => {
                        signal.throwIfAborted();
                        snapshot.assertCurrent();
                        if (authorityNow.currentFleet?.() !== true)
                          throw new Error("Fleet admission unavailable");
                      };
                    },
                  }),
            });
            if (repeatedReceipt) return workerCallResponse(this.callReceiptResult(repeatedReceipt));
            if (unadmittedSettlement)
              return workerCallResponse(
                this.uncertainCallReceipt(
                  id,
                  "The host settled this call without durable dispatch admission; reconcile its receipt",
                ),
              );
            if (result.outcome === "ok" && admitted) this.settleCallReceipt(id, result);
            if (result.outcome !== "ok" && admitted && !this.callReceipts.load().get(id)?.result) {
              const health = this.bridge(authorityNow);
              if (health)
                health.last = {
                  status: "stalled",
                  reason: `Connected tool call has no confirmed result: ${result.detail}`.slice(0, 500),
                  observedAt: new Date().toISOString(),
                  ...(health.last?.tools ? { tools: health.last.tools } : {}),
                };
            }
            return workerCallResponse(
              result.outcome === "ok"
                ? { ...result, ...(admitted ? { receiptId: id } : {}) }
                : admitted
                  ? this.uncertainCallReceipt(id, result.detail)
                  : result,
            );
          },
        );
      } catch (error) {
        if (repeatedReceipt) return workerCallResponse(this.callReceiptResult(repeatedReceipt));
        return workerCallResponse(
          admitted && receiptId
            ? this.uncertainCallReceipt(receiptId, error instanceof Error ? error.message : String(error))
            : {
                outcome: "refused",
                reason: "worker_request_failed",
                detail: error instanceof Error ? error.message : String(error),
              },
        );
      }
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
    });
    await server.connect(transport as unknown as Transport);
    let response: Response;
    try {
      response = await beforeWorkerDeadline(request.signal, "Worker session initialization", () =>
        transport.handleRequest(request, {
          authInfo: { token, clientId: authority.principalId, scopes: [] },
          parsedBody,
        }),
      );
    } catch (error) {
      void server.close().catch(() => undefined);
      return Response.json(
        { error: "worker_request_failed", reason: error instanceof Error ? error.message : String(error) },
        { status: request.signal.aborted ? 504 : 500 },
      );
    }
    if (transport.sessionId === undefined) await server.close();
    else if (!this.closed && !request.signal.aborted) {
      this.sessions.set(transport.sessionId, {
        ...(authority.grantId === undefined ? {} : { grantId: authority.grantId }),
        principalKey: authority.key,
        ...(initialize.success && initialize.data.params.clientInfo.name === "clankie-worker"
          ? { pluginVersion: initialize.data.params.clientInfo.version }
          : {}),
        ...(authority.bridgeId ? { bridgeId: authority.bridgeId } : {}),
        server,
        transport,
        expiresAt: authority.expiresAt,
      });
      if (authority.fleet !== undefined && authority.pane !== undefined) {
        const key = JSON.stringify([authority.fleet, authority.pane]);
        if (!this.bridges.has(key) || this.bridges.get(key)?.generation !== authority.bridgeId)
          this.bridges.set(key, { generation: authority.bridgeId, active: new Map() });
        const state = this.bridges.get(key)!;
        if (
          initialize.success &&
          initialize.data.params.clientInfo.name === "clankie-worker" &&
          /^\d+\.\d+\.\d+$/u.test(initialize.data.params.clientInfo.version)
        )
          state.pluginVersion = initialize.data.params.clientInfo.version;
      }
    } else await server.close();
    return response;
  }

  async close() {
    this.closed = true;
    this.bridges.clear();
    this.fleetRequests.clear();
    await Promise.all([...this.sessions.values()].map((session) => session.server.close()));
    this.sessions.clear();
  }
}
