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
  resolveProviderBearer,
} from "@clankie/credential-broker";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { verifyLinearMcpAccount, type McpHost } from "./mcp-host.ts";
import type { SwarmHost } from "@clankie/swarm";

const SwarmAssignmentSchema = z
  .object({
    conversationId: z.string().min(1).max(256),
    connectionId: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/u)
      .optional(),
    taskId: z.string().min(1).max(128),
  })
  .strict();
const SwarmBindingSchema = SwarmAssignmentSchema.extend({
  scope: z.string().min(1),
  actor: z.string().min(1),
  attemptId: z.string().min(1),
  fence: z.number().int().positive(),
});

const ToolRuleSchema = z
  .object({
    name: z.string().min(1).max(128),
    /** Exact top-level argument restrictions, enforced on every invocation. */
    arguments: z.record(z.string(), z.json()).default({}),
    forbiddenArguments: z.array(z.string().min(1).max(128)).max(64).default([]),
  })
  .strict();
export const WorkerGrantRequestSchema = z
  .object({
    principalId: z.string().min(1).max(256),
    workId: z.string().min(1).max(256),
    server: z.string().min(1).max(128),
    tools: z.array(ToolRuleSchema).min(1).max(64),
    ttlSeconds: z.number().int().min(1).max(900).default(900),
    swarm: SwarmAssignmentSchema.optional(),
    renewable: z.boolean().default(false),
  })
  .strict()
  .refine((value) => !value.renewable || value.swarm !== undefined, "Renewal requires a Swarm assignment");
const RecordSchema = z.object({
  grant: CapabilityGrantSchema,
  server: z.string(),
  lane: z.literal("operator"),
  tools: z.array(ToolRuleSchema),
  account: ProviderAccountSchema,
  revokedAt: z.string().datetime().optional(),
  swarm: SwarmBindingSchema.optional(),
  renewable: z.boolean().default(false),
});
type GrantRecord = z.infer<typeof RecordSchema>;
type WorkerAuthorization = {
  key: string;
  principalId: string;
  records: GrantRecord[];
  expiresAt: number;
  grantId?: string;
};
const uuid = z.string().uuid();
const KEY_ID = "clankie_worker_mcp_signing";
const swarmPrincipalKey = (scope: string, actor: string, connectionId?: string) =>
  JSON.stringify(["swarm", connectionId ?? "embedded", scope, actor]);

/** Immutable grants plus a durable revocation marker; only the service writes them. */
export class WorkerMcp {
  private issuerPromise: Promise<CapabilityTokenIssuer> | undefined;
  private readonly options: {
    directory: string;
    credentials: CredentialStore;
    host: McpHost;
    swarm?: Pick<SwarmHost, "assignment"> & Partial<Pick<SwarmHost, "worker" | "workerInScope">>;
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
  constructor(options: {
    directory: string;
    credentials: CredentialStore;
    host: McpHost;
    swarm?: Pick<SwarmHost, "assignment"> & Partial<Pick<SwarmHost, "worker" | "workerInScope">>;
  }) {
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
    return RecordSchema.parse(JSON.parse(await readFile(this.path(id), "utf8")));
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
    const request = WorkerGrantRequestSchema.parse(input);
    const swarm =
      request.swarm === undefined ? undefined : await this.assignment(request.swarm, request.principalId);
    const { account, binding } = await this.options.host.account(request.server, "operator");
    const catalog = await this.options.host.catalog("operator");
    if (new Set(request.tools.map((tool) => tool.name)).size !== request.tools.length)
      throw new Error("Tool names must be unique");
    for (const rule of request.tools) {
      if (!catalog.some((tool) => tool.server === request.server && tool.name === rule.name))
        throw new Error(`Unavailable tool: ${rule.name}`);
    }
    const now = Math.floor(Date.now() / 1000);
    const record: GrantRecord = {
      server: request.server,
      lane: "operator",
      tools: request.tools,
      account,
      renewable: request.renewable,
      ...(swarm === undefined ? {} : { swarm }),
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
    if (!record.swarm) return;
    const key = swarmPrincipalKey(record.swarm.scope, record.grant.principalId, record.swarm.connectionId);
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => session.principalKey === key)
        .map((session) => session.server.sendToolListChanged().catch(() => undefined)),
    );
  }

  async list(): Promise<GrantRecord[]> {
    const files = await readdir(this.options.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    return Promise.all(
      files.filter((file) => file.endsWith(".json")).map((file) => this.read(file.slice(0, -5))),
    );
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
    const presented = record.renewable
      ? { ...verified.grant, issuedAt: record.grant.issuedAt, expiresAt: record.grant.expiresAt }
      : verified.grant;
    if (
      record.revokedAt !== undefined ||
      !isDeepStrictEqual(record.grant, presented) ||
      verified.grant.issuedAt < record.grant.issuedAt ||
      verified.grant.expiresAt - verified.grant.issuedAt > record.grant.expiresAt - record.grant.issuedAt
    )
      throw new Error("Worker grant revoked or changed");
    await this.checkBinding(record);
    return { ...record, grant: verified.grant };
  }

  private async checkBinding(record: GrantRecord) {
    if (record.revokedAt !== undefined) throw new Error("Worker grant revoked");
    const current = await this.options.host.account(record.server, record.lane);
    if (current.binding !== record.grant.profileHash) throw new Error("Delegated account changed");
    if (
      record.swarm !== undefined &&
      !isDeepStrictEqual(record.swarm, await this.assignment(record.swarm, record.grant.principalId))
    )
      throw new Error("Swarm assignment changed");
  }

  /** Exchange an authenticated Swarm session for this worker's existing grant.
   * This is delivery, never enrollment-based issuance of new authority. */
  async claim(id: string, request: Request): Promise<Response> {
    const capability = request.headers.get("authorization")?.match(/^Bearer (\S+)$/u)?.[1];
    if (!capability) return Response.json({ error: "worker_authentication_required" }, { status: 401 });
    try {
      const record = await this.read(id);
      if (!record.swarm || !this.options.swarm?.worker) throw new Error("Swarm delivery unavailable");
      const identity = await this.options.swarm.worker(
        record.swarm.conversationId,
        capability,
        record.swarm.connectionId,
      );
      if (identity.actor !== record.grant.principalId || identity.scope !== record.swarm.scope)
        throw new Error("Grant belongs to another worker");
      await this.checkBinding(record);
      const issuedAt = Math.floor(Date.now() / 1000);
      const grant = record.renewable
        ? {
            ...record.grant,
            issuedAt,
            expiresAt: issuedAt + record.grant.expiresAt - record.grant.issuedAt,
          }
        : record.grant;
      if (grant.expiresAt <= issuedAt) throw new Error("Grant expired");
      return Response.json(
        { grant, token: (await this.issuer()).issue(grant), renewable: record.renewable },
        { headers: { "cache-control": "no-store" } },
      );
    } catch {
      return Response.json({ error: "worker_claim_refused" }, { status: 403 });
    }
  }

  /** Renew the same authority, never a new grant or a new revocation lineage. */
  async renew(request: Request): Promise<Response> {
    const token = request.headers.get("authorization")?.match(/^Bearer (\S+)$/u)?.[1];
    if (!token) return Response.json({ error: "worker_authentication_required" }, { status: 401 });
    try {
      const record = await this.authorize(token);
      if (!record.renewable || !record.swarm) throw new Error("Grant is not renewable");
      const issuedAt = Math.floor(Date.now() / 1000);
      const grant = {
        ...record.grant,
        issuedAt,
        expiresAt: issuedAt + record.grant.expiresAt - record.grant.issuedAt,
      };
      for (const session of this.sessions.values()) {
        if (session.grantId === grant.grantId)
          session.expiresAt = Math.max(session.expiresAt, grant.expiresAt);
      }
      return Response.json(
        { token: (await this.issuer()).issue(grant), grant, renewable: true },
        {
          headers: { "cache-control": "no-store" },
        },
      );
    } catch {
      return Response.json({ error: "worker_renewal_refused" }, { status: 403 });
    }
  }

  private async assignment(input: z.infer<typeof SwarmAssignmentSchema>, actor: string) {
    if (!this.options.swarm) throw new Error("Swarm assignment verification unavailable");
    const binding = SwarmBindingSchema.parse(
      await this.options.swarm.assignment(input.conversationId, input.taskId, actor, input.connectionId),
    );
    if (binding.connectionId !== input.connectionId) throw new Error("Swarm connection binding changed");
    return binding;
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

  /** An enrolled worker starts with no tools and sees only explicitly issued, live grants. */
  async handleSwarm(scope: string, request: Request): Promise<Response> {
    return this.handleAuthorized(request, async (capability) => {
      if (!this.options.swarm?.workerInScope) throw new Error("Swarm worker access unavailable");
      const connectionId = new URL(request.url).searchParams.get("connection") ?? undefined;
      if (connectionId !== undefined && !/^[a-z][a-z0-9-]{0,63}$/u.test(connectionId))
        throw new Error("Invalid Swarm connection");
      const identity = await this.options.swarm.workerInScope(scope, capability, connectionId);
      if (identity.scope !== scope) throw new Error("Worker belongs to another scope");
      const now = Math.floor(Date.now() / 1000);
      const records: GrantRecord[] = [];
      // ponytail: scan issued grants; index by worker/scope if grant volume warrants it.
      for (const record of await this.list()) {
        if (
          record.swarm?.scope !== scope ||
          record.swarm.connectionId !== connectionId ||
          record.grant.principalId !== identity.actor ||
          record.revokedAt !== undefined ||
          (!record.renewable && record.grant.expiresAt <= now)
        )
          continue;
        try {
          await this.checkBinding(record);
          records.push(record);
        } catch {
          /* Unavailable grants confer no tools. */
        }
      }
      return {
        key: swarmPrincipalKey(scope, identity.actor, connectionId),
        principalId: identity.actor,
        records,
        expiresAt: now + 900,
      };
    });
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
      if (sessionId !== id && session.expiresAt <= Date.now() / 1000) {
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
        instructions: `Delegated connected tools for worker ${authority.principalId}. Only explicit, live grants confer access. You remain a worker; this is not Clankie's operator seat.`,
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
      const current = await authenticate(extra.authInfo?.token ?? "");
      if (current.key !== authority.key) throw new Error("Worker session changed");
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
        const args = call.params.arguments ?? {};
        const current = authorityNow.records.find((record) =>
          record.tools.some(
            (rule) =>
              `${record.server}_${rule.name}` === call.params.name &&
              rule.forbiddenArguments.every((key) => !Object.hasOwn(args, key)) &&
              Object.entries(rule.arguments).every(([key, value]) => isDeepStrictEqual(args[key], value)),
          ),
        );
        if (!current) throw new Error("Tool or arguments are not granted");
        const rule = current.tools.find((rule) => `${current.server}_${rule.name}` === call.params.name)!;
        const result = await this.options.host.call({
          lane: current.lane,
          server: current.server,
          tool: rule.name,
          arguments: args,
          delegation: {
            binding: current.grant.profileHash,
            grantId: current.grant.grantId,
            principalId: current.grant.principalId,
            workId: current.grant.missionId,
          },
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
