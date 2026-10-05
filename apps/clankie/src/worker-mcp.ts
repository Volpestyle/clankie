import { ProjectIdSchema, type ProjectsSettings } from "@clankie/protocol/projects";
import type { FleetSettings } from "@clankie/settings";
import type { LocalFleetIdentity } from "./local-fleet-link.ts";
import type { ProjectProcessProof } from "./project-process-proof.ts";
import { randomBytes, randomUUID } from "node:crypto";
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
  verifyLinearAppAccount,
  resolveProviderBearer,
} from "@clankie/credential-broker";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { verifyLinearMcpAccount, type McpHost } from "./mcp-host.ts";
import { isLinearWorkerTool } from "./linear-publishing.ts";
import { MinecraftActionSchema } from "@clankie/protocol";
import type { MinecraftService } from "./minecraft.ts";

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
  account: ProviderAccountSchema,
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
  validateFleet?(): boolean | Promise<boolean>;
  /** Optional author attribution only; this never changes the connected tool grant. */
  nativeWriteProof?(): Promise<ProjectProcessProof | undefined>;
  currentFleet?: (() => boolean) | undefined;
};
const FleetSearchSchema = z
  .object({
    query: z.string().max(500).optional(),
    names: z.array(z.string().min(1).max(256)).min(1).max(10).optional(),
  })
  .strict();
const FleetCallSchema = z
  .object({
    name: z.string().min(1).max(256),
    arguments: z.record(z.string(), z.json()),
  })
  .strict();
const FLEET_TOOLS = [
  {
    name: "clankie_tools",
    description:
      "Search connected tools with query (up to 20 names and one-line descriptions), or request full input schemas with names (up to 10). Discover a tool's schema before calling it.",
    inputSchema: z.toJSONSchema(FleetSearchSchema) as { type: "object" },
  },
  {
    name: "clankie_call",
    description:
      "Call a connected tool by its qualified name and arguments. Use clankie_tools to find its name and input schema. Calls use Clankie's verified connected account.",
    inputSchema: z.toJSONSchema(FleetCallSchema) as { type: "object" },
  },
];
const uuid = z.string().uuid();
const KEY_ID = "clankie_worker_mcp_signing";

/** Immutable grants plus a durable revocation marker; only the service writes them. */
export class WorkerMcp {
  private issuerPromise: Promise<CapabilityTokenIssuer> | undefined;
  private readonly options: {
    directory: string;
    credentials: CredentialStore;
    host: McpHost;
    projects?(): Promise<ProjectsSettings>;
    fleetTools?(): Promise<FleetSettings["tools"]>;
    /** Canonical settings generation, checked without yielding at provider dispatch. */
    fleetToolsSnapshot?(): Promise<{ tools: FleetSettings["tools"]; assertCurrent(): void }>;
    minecraft?: Pick<MinecraftService, "workerCommand">;
  };
  private readonly sessions = new Map<
    string,
    {
      grantId?: string;
      principalKey: string;
      server: Server;
      transport: WebStandardStreamableHTTPServerTransport;
      expiresAt: number;
    }
  >();
  constructor(options: WorkerMcp["options"]) {
    this.options = options;
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
    if (verify) {
      const update = this.options.credentials.update;
      if (update === undefined) throw new Error("Credential store cannot verify accounts atomically");
      // Persist rotated refresh tokens even if the subsequent identity read fails.
      await resolveProviderBearer("linear", this.options.credentials);
      const result = await update.call(this.options.credentials, "linear", async (current) => {
        if (current.type === "wellknown") throw new Error("Unsupported Linear credential type");
        const account =
          current.type === "api"
            ? await verifyLinearApiAccount(current.key)
            : current.linearAuth === "app"
              ? await verifyLinearAppAccount(current.access)
              : await verifyLinearMcpAccount(current);
        if (current.account?.userId === account.userId && current.account.workspaceId === account.workspaceId)
          account.connectionId = current.account.connectionId;
        return { ...current, account };
      });
      if (result === undefined) throw new Error("Linear is not connected");
    }
    const current = await this.options.credentials.get("linear");
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
    const { account, binding } = await this.options.host.account(request.server, "operator");
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
      account,
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
    const current = await this.options.host.account(record.server, record.lane);
    if (current.binding !== record.grant.profileHash) throw new Error("Delegated account changed");
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

  /** Per-request proofs live only in service memory, never in HTTP responses or worker files. */
  private readonly localRequests = new Map<string, LocalFleetIdentity>();

  async handleLocalFleet(request: Request, identity: LocalFleetIdentity): Promise<Response> {
    const proof = randomUUID();
    this.localRequests.set(proof, identity);
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${proof}`);
    try {
      return await this.handleAuthorized(new Request(request, { headers }), async (token) => {
        const current = this.localRequests.get(token);
        if (!current || !(await current.validate())) throw new Error("Local fleet membership unavailable");
        const fleet = current.fleet ?? "default";
        return this.fleetAuthorization(
          fleet,
          () => current.validate(),
          current.current === undefined ? undefined : () => current.current!(),
          current.pane,
          async () => {
            if (!(await current.validate())) return undefined;
            const observed = await current.projectProof?.();
            if (observed?.fleet !== fleet || observed.pane !== current.pane || !(await current.validate()))
              return undefined;
            return observed;
          },
        );
      });
    } finally {
      this.localRequests.delete(proof);
    }
  }

  /** A bearer link admits its fleet, without claiming a verified pane or native occupant. */
  async handleFleet(fleet: string, request: Request, linked: (token: string) => boolean): Promise<Response> {
    return this.handleAuthorized(request, async (token) => {
      if (!linked(token)) throw new Error("Not this fleet's link");
      return this.fleetAuthorization(
        fleet,
        () => linked(token),
        () => linked(token),
      );
    });
  }

  /** Read-only startup expectation. This never authorizes a request or creates an identity. */
  async expectedProjectToolNames(_projectId: string): Promise<readonly string[]> {
    return (await this.fleetToolsEnabled()) ? FLEET_TOOLS.map((tool) => tool.name) : [];
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
    const records: GrantRecord[] = [];
    if (await this.fleetToolsEnabled()) {
      const catalog = (await this.options.host.catalog("operator")).filter(
        (tool) => tool.server !== "minecraft",
      );
      for (const server of new Set(catalog.map((tool) => tool.server))) {
        try {
          const { account, binding } = await this.options.host.account(server, "operator");
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
            account,
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
        } catch {
          // One unverified/unavailable account never removes the other servers.
        }
      }
    }
    return {
      key: JSON.stringify(pane === undefined ? ["fleet", fleet] : ["fleet", fleet, pane]),
      principalId,
      records,
      expiresAt,
      fleet,
      validateFleet,
      ...(nativeWriteProof ? { nativeWriteProof } : {}),
      currentFleet,
    };
  }

  private async handleAuthorized(
    request: Request,
    authenticate: (token: string) => Promise<WorkerAuthorization>,
  ): Promise<Response> {
    const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/u)?.[1];
    if (token === undefined)
      return Response.json({ error: "worker_authentication_required" }, { status: 401 });
    let authority: WorkerAuthorization;
    try {
      authority = await authenticate(token);
    } catch {
      return Response.json({ error: "worker_grant_unavailable" }, { status: 403 });
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
      if (session.principalKey !== authority.key)
        return Response.json({ error: "worker_session_forbidden" }, { status: 403 });
      session.expiresAt = Math.max(session.expiresAt, authority.expiresAt);
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
    const server = new Server(
      { name: "clankie-worker", version: "1" },
      {
        capabilities: { tools: { listChanged: true } },
        instructions: `Connected tools for worker ${authority.principalId}. Fleet members discover tools with clankie_tools and invoke them with clankie_call; manual grants expose their selected tools directly. You remain a worker; this is not Clankie's operator seat.`,
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
      const current = await authenticate(extra.authInfo?.token ?? "");
      if (current.key !== authority.key) throw new Error("Worker session changed");
      if (current.fleet !== undefined) return { tools: (await this.fleetToolsEnabled()) ? FLEET_TOOLS : [] };
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
    });
    server.setRequestHandler(CallToolRequestSchema, async (call, extra) => {
      try {
        const authorityNow = await authenticate(extra.authInfo?.token ?? "");
        if (authorityNow.key !== authority.key) throw new Error("Worker session changed");
        let name = call.params.name;
        let args = call.params.arguments ?? {};
        if (authorityNow.fleet !== undefined) {
          if (!(await this.fleetToolsEnabled())) throw new Error("Fleet tools are off");
          if (name === "clankie_tools") {
            const search = FleetSearchSchema.parse(args);
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
          name = invocation.name;
          args = invocation.arguments;
        }
        if (Object.hasOwn(minecraftWorkerSchemas, name)) {
          if (authorityNow.fleet === undefined || this.options.minecraft === undefined)
            throw new Error("Minecraft driver requires an admitted fleet channel");
          const input = minecraftWorkerSchemas[name as keyof typeof minecraftWorkerSchemas].parse(args);
          const action = name.slice("clankie_minecraft_".length) as "act" | "observe" | "status" | "cancel";
          const result = await this.options.minecraft.workerCommand(
            { action, ...input },
            {
              principalId: authorityNow.principalId,
              guard: async () => {
                if (!(await authorityNow.validateFleet!())) throw new Error("Fleet admission unavailable");
                const snapshot = await this.options.fleetToolsSnapshot?.();
                if (snapshot?.tools !== "connected") throw new Error("Fleet tools are off or unavailable");
                snapshot.assertCurrent();
                if (authorityNow.currentFleet?.() !== true) throw new Error("Fleet admission unavailable");
                return () => {
                  snapshot.assertCurrent();
                  if (authorityNow.currentFleet?.() !== true) throw new Error("Fleet admission unavailable");
                };
              },
            },
          );
          return { content: [{ type: "text", text: JSON.stringify(result) }], isError: false };
        }
        const current = authorityNow.records.find((record) =>
          record.tools.some(
            (rule) =>
              `${record.server}_${rule.name}` === name &&
              rule.forbiddenArguments.every((key) => !Object.hasOwn(args, key)) &&
              Object.entries(rule.arguments).every(([key, value]) => isDeepStrictEqual(args[key], value)),
          ),
        );
        if (!current || current.server === "minecraft") throw new Error("Tool or arguments are not granted");
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
        const result = await this.options.host.call({
          lane: current.lane,
          server: current.server,
          tool: rule.name,
          arguments: args,
          ...(authorityNow.nativeWriteProof ? { nativeWriteProof: authorityNow.nativeWriteProof } : {}),
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
                  if (!(await authorityNow.validateFleet!())) throw new Error("Fleet admission unavailable");
                  const snapshot = await this.options.fleetToolsSnapshot?.();
                  if (snapshot?.tools !== "connected") throw new Error("Fleet tools are off or unavailable");
                  // The host still has account/configuration I/O to finish. These
                  // canonical checks must not yield after that last awaited read.
                  return () => {
                    snapshot.assertCurrent();
                    if (authorityNow.currentFleet?.() !== true)
                      throw new Error("Fleet admission unavailable");
                  };
                },
              }),
        });
        return {
          content: [{ type: "text", text: result.outcome === "ok" ? result.content : result.detail }],
          isError: result.outcome !== "ok" || result.isError,
        };
      } catch {
        return {
          content: [
            { type: "text", text: "Worker tool access refused; inspect the current grant and account." },
          ],
          isError: true,
        };
      }
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      enableJsonResponse: true,
    });
    await server.connect(transport as unknown as Transport);
    const response = await transport.handleRequest(request, {
      authInfo: { token, clientId: authority.principalId, scopes: [] },
    });
    if (transport.sessionId === undefined) await server.close();
    else
      this.sessions.set(transport.sessionId, {
        ...(authority.grantId === undefined ? {} : { grantId: authority.grantId }),
        principalKey: authority.key,
        server,
        transport,
        expiresAt: authority.expiresAt,
      });
    return response;
  }

  async close() {
    await Promise.all([...this.sessions.values()].map((session) => session.server.close()));
    this.sessions.clear();
  }
}
