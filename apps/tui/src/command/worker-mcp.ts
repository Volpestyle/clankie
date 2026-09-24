import { mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CapabilityGrantSchema } from "@clankie/credential-broker";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { commandHost } from "./io.ts";

function workerEndpoint(endpoint: string): URL {
  const url = new URL(endpoint);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        (url.hostname === "localhost" || /^127(\.\d{1,3}){3}$/u.test(url.hostname))
      ))
  )
    throw new Error("Worker endpoint must use HTTPS or loopback HTTP");
  return url;
}

/** One enrolled connection; account authority remains in the service's issued grants. */
export async function runEnrolledWorkerMcp(
  options: { env?: NodeJS.ProcessEnv; host?: string; transport?: Transport } = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const capability = env.SWARM_SESSION_CAPABILITY;
  const scope = env.SWARM_SCOPE;
  if (!capability || !scope)
    throw new Error("Swarm worker MCP requires SWARM_SESSION_CAPABILITY and SWARM_SCOPE");
  const url = workerEndpoint(
    `${commandHost(options).replace(/\/$/u, "")}/v1/worker-mcp/swarm/${encodeURIComponent(scope)}`,
  );
  const connection = env.CLANKIE_SWARM_CONNECTION;
  if (connection !== undefined) {
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(connection) || connection === "embedded")
      throw new Error("CLANKIE_SWARM_CONNECTION must name an external connection; omit for embedded");
    url.searchParams.set("connection", connection);
  }
  const upstream = new Client({ name: "clankie-enrolled-worker", version: "1" });
  const server = new Server(
    { name: "clankie-worker", version: "1" },
    { capabilities: { tools: { listChanged: true } } },
  );
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let failure: unknown;
  const closed = new Promise<void>((resolve) => {
    server.onclose = resolve;
  });
  try {
    await upstream.connect(
      new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { authorization: `Bearer ${capability}` } },
      }) as unknown as Transport,
    );
    server.setRequestHandler(ListToolsRequestSchema, () => upstream.listTools());
    server.setRequestHandler(CallToolRequestSchema, (request) => upstream.callTool(request.params));
    await server.connect(options.transport ?? new StdioServerTransport());
    upstream.setNotificationHandler(ToolListChangedNotificationSchema, () => server.sendToolListChanged());
    // Keep the authenticated MCP session alive while the harness waits for work.
    heartbeat = setInterval(() => {
      void upstream.ping().catch((error: unknown) => {
        failure = error;
        void server.close();
      });
    }, 60_000);
    await closed;
    if (failure) throw new Error("Swarm worker session is unavailable", { cause: failure });
    return 0;
  } finally {
    clearInterval(heartbeat);
    await server.close();
    await upstream.close();
  }
}

/** Pull only an already-issued grant using this runtime's Swarm identity. */
export async function runSwarmWorkerMcp(
  id: string,
  options: { env?: NodeJS.ProcessEnv; host?: string; transport?: Transport } = {},
): Promise<number> {
  const grantId = z.string().uuid().parse(id);
  const capability = (options.env ?? process.env).SWARM_SESSION_CAPABILITY;
  if (!capability) throw new Error("Swarm worker delivery requires this runtime's SWARM_SESSION_CAPABILITY");
  const endpoint = workerEndpoint(`${commandHost(options).replace(/\/$/u, "")}/v1/worker-mcp`);
  const response = await fetch(`${endpoint.href}/claim/${grantId}`, {
    method: "POST",
    headers: { authorization: `Bearer ${capability}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Swarm worker access unavailable: ${response.status}`);
  const grant = z
    .object({ token: z.string().min(1), grant: CapabilityGrantSchema, renewable: z.boolean() })
    .parse(await response.json());
  if (grant.grant.grantId !== grantId) throw new Error("Service returned another worker grant");
  const directory = await mkdtemp(join(tmpdir(), "clankie-worker-access-"));
  try {
    const file = join(directory, "grant.json");
    await writeFile(file, JSON.stringify({ endpoint: endpoint.href, ...grant }), { mode: 0o600, flag: "wx" });
    return await runWorkerMcp(file, options.transport);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Worker-only bridge: no operator credential, seat outbox or channel capability. */
export async function runWorkerMcp(path: string, transport?: Transport): Promise<number> {
  const grantPath = await realpath(path);
  const metadata = await stat(grantPath);
  if ((metadata.mode & 0o077) !== 0) throw new Error("Worker grant file must be private (chmod 600)");
  let grant = z
    .object({
      endpoint: z.string().url(),
      token: z.string().min(1),
      grant: CapabilityGrantSchema.optional(),
      renewable: z.boolean().default(false),
    })
    .parse(JSON.parse(await readFile(grantPath, "utf8")));
  if (grant.renewable && !grant.grant) throw new Error("Renewable worker file needs grant metadata");
  const url = workerEndpoint(grant.endpoint);
  const upstream = new Client({ name: "clankie-worker-bridge", version: "1" });
  const server = new Server({ name: "clankie-worker", version: "1" }, { capabilities: { tools: {} } });
  let stopped = false;
  let failure: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined;
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => {
      stopped = true;
      resolve();
    };
  });
  const schedule = (retry = false) => {
    if (stopped || !grant.renewable || !grant.grant) return;
    const lifetime = grant.grant.expiresAt - grant.grant.issuedAt;
    const delay = retry
      ? 1000
      : Math.max(100, (grant.grant.expiresAt - Date.now() / 1000 - Math.min(60, lifetime / 2)) * 1000);
    timer = setTimeout(() => {
      pending = (async () => {
        let terminal = false;
        try {
          const response = await fetch(`${url.href.replace(/\/$/u, "")}/renew`, {
            method: "POST",
            headers: { authorization: `Bearer ${grant.token}` },
            signal: AbortSignal.timeout(10_000),
          });
          if (!response.ok) {
            terminal = response.status === 401 || response.status === 403;
            throw new Error(`Worker renewal refused: ${response.status}`);
          }
          const renewed = z
            .object({ token: z.string().min(1), grant: CapabilityGrantSchema, renewable: z.literal(true) })
            .parse(await response.json());
          if (renewed.grant.grantId !== grant.grant!.grantId || renewed.grant.expiresAt <= Date.now() / 1000)
            throw new Error("Worker renewal returned invalid metadata");
          if (stopped) return;
          const next = { ...grant, ...renewed };
          const temporary = `${grantPath}.${randomUUID()}.tmp`;
          try {
            await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
            await rename(temporary, grantPath);
          } finally {
            await rm(temporary, { force: true });
          }
          grant = next;
          schedule();
        } catch (error) {
          if (stopped) return;
          if (terminal || grant.grant!.expiresAt <= Date.now() / 1000) {
            failure = new Error(
              "Worker access renewal stopped; reissue access after resolving the grant or connection",
              { cause: error },
            );
            await server.close();
          } else schedule(true);
        }
      })();
    }, delay);
  };
  try {
    await upstream.connect(
      new StreamableHTTPClientTransport(url, {
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers);
          headers.set("authorization", `Bearer ${grant.token}`);
          return fetch(input, { ...init, headers });
        },
      }) as unknown as Transport,
    );
    server.setRequestHandler(ListToolsRequestSchema, () => upstream.listTools());
    server.setRequestHandler(CallToolRequestSchema, (request) => upstream.callTool(request.params));
    await server.connect(transport ?? new StdioServerTransport());
    schedule();
    await closed;
    if (failure) throw failure;
    return 0;
  } finally {
    stopped = true;
    clearTimeout(timer);
    await pending;
    await server.close();
    await upstream.close();
  }
}
