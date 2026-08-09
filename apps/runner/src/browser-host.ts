/**
 * Clankie's own browser ([ADR 0082](../../../docs/adr/0082-clankie-holds-the-browser.md)).
 *
 * The runner owns the `agent-browser` MCP server the same way it owns every
 * other process: the captain never spawns it, never holds its socket, and
 * never sees a tool doctrine did not project.
 *
 * Three things distinguish this host from the read-only projection that goes
 * to the Codex shell (`prepareBrowserControl` in `provider-factory.ts`):
 *
 * - **The full action set.** A general-purpose seat that can read a page but
 *   never fill a form is not doing the job. Restraint comes from doctrine risk
 *   classes, not from a truncated command list.
 * - **A persistent profile.** He logs into a site once and stays logged in,
 *   so a lookup behind a session does not become a password request every
 *   time. The profile is runner-private and is his, never the operator's
 *   browser — the accumulated credentials are exactly why `auth`,
 *   `set_cookies`, and `eval` are approval-class.
 * - **Doctrine on the way out.** Every descriptor is projected before the
 *   captain sees it, so `requiresApproval` is a decided fact on the wire.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { CompiledDoctrine } from "@clankie/doctrine";
import {
  mcpToolAction,
  projectCaptainMcpToolGrants,
  type CaptainMcpToolGrant,
  type McpRegistry,
} from "@clankie/mcp-registry";
import {
  BrowserToolCatalogSchema,
  CallBrowserToolResultSchema,
  type BrowserToolCatalog,
  type BrowserToolDescriptor,
  type CallBrowserToolRequest,
  type CallBrowserToolResult,
} from "@clankie/protocol";

/** The registry server name this host drives. Declared in the MCP registry. */
export const BROWSER_SERVER_NAME = "agent_browser";

/**
 * Whether the browser is switched on, defaulting to **yes**.
 *
 * Opt-in was the wrong default: a browser nobody remembers to enable is a
 * capability Clankie truthfully denies having, which is the failure this whole
 * change set exists to remove. Enabling it is still not the same as granting
 * it — doctrine and the registry decide what he may actually call, and a
 * missing binary degrades to a logged unavailability rather than a boot
 * failure. Only an explicit falsey value turns it off.
 */
export function browserEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) return true;
  return !["0", "false", "no", "off"].includes(normalized);
}

/** One tool result is capped well below the protocol's ceiling so a page dump cannot flood a turn. */
const MAX_RESULT_CHARACTERS = 100_000;
const REQUEST_TIMEOUT_MS = 60_000;
const STARTUP_TIMEOUT_MS = 30_000;

export interface BrowserHostLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export interface BrowserHostOptions {
  registry: McpRegistry;
  doctrine: CompiledDoctrine;
  runnerStateRoot: string;
  logger: BrowserHostLogger;
  environment?: NodeJS.ProcessEnv;
  /** Injected in tests so the suite never launches a browser. */
  spawnImpl?: typeof spawn;
  principalId?: string;
}

export interface BrowserHost {
  catalog(): Promise<BrowserToolCatalog>;
  call(request: CallBrowserToolRequest): Promise<CallBrowserToolResult>;
  close(): Promise<void>;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * A minimal stdio JSON-RPC client for the one MCP server this host owns.
 *
 * The MCP SDK's `Client` is deliberately not used: it is a dependency of a
 * single app in this tree, and the surface needed here is two calls
 * (`tools/list`, `tools/call`) over newline-delimited JSON-RPC. Hand-rolling
 * that keeps the runner's dependency set unchanged and keeps the framing rules
 * — one message per line, ids never reused — visible at the boundary that has
 * to enforce them.
 */
class StdioMcpClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #buffer = "";
  #closed = false;

  public constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#consume(chunk));
    child.on("exit", () => this.#failAll(new Error("browser_host_exited")));
    child.on("error", (error) => this.#failAll(error instanceof Error ? error : new Error("spawn_failed")));
  }

  public get closed(): boolean {
    return this.#closed;
  }

  #consume(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length > 0) this.#dispatch(line);
      newline = this.#buffer.indexOf("\n");
    }
  }

  #dispatch(line: string): void {
    let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return; // A server that writes noise to stdout must not crash the runner.
    }
    if (typeof message.id !== "number") return; // Notifications carry no id.
    const pending = this.#pending.get(message.id);
    if (pending === undefined) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const detail = typeof message.error.message === "string" ? message.error.message : "mcp_error";
      pending.reject(new Error(detail));
      return;
    }
    pending.resolve(message.result);
  }

  #failAll(error: Error): void {
    this.#closed = true;
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  public request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("browser_host_closed"));
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error("browser_host_timeout"));
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  public notify(method: string, params: unknown): void {
    if (this.#closed) return;
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new Error("browser_host_closed"));
    this.#child.stdin.end();
    this.#child.kill();
  }
}

export async function createBrowserHost(options: BrowserHostOptions): Promise<BrowserHost> {
  const environment = options.environment ?? process.env;
  const server = options.registry.servers.find((entry) => entry.name === BROWSER_SERVER_NAME);
  if (server === undefined || server.transport.type !== "stdio") {
    throw new Error(`the MCP registry declares no stdio server named ${BROWSER_SERVER_NAME}`);
  }

  const grants = new Map<string, CaptainMcpToolGrant>();
  for (const grant of projectCaptainMcpToolGrants(options.registry, options.doctrine, {
    principalId: options.principalId ?? "captain",
  }).granted) {
    if (grant.server === BROWSER_SERVER_NAME) grants.set(grant.tool, grant);
  }

  // Persistent and runner-private. `RESTORE_SAVE` is deliberately the opposite
  // of the Codex projection's `never`: staying logged in is the point.
  const profileDirectory = join(options.runnerStateRoot, "browser", "profile");
  const socketDirectory = join(options.runnerStateRoot, "browser", "run");
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  await mkdir(socketDirectory, { recursive: true, mode: 0o700 });

  const command = environment.CLANKIE_AGENT_BROWSER_EXECUTABLE?.trim() || server.transport.command;
  const child = (options.spawnImpl ?? spawn)(command, [...server.transport.args], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...environment,
      AGENT_BROWSER_SOCKET_DIR: socketDirectory,
      AGENT_BROWSER_PROFILE_DIR: profileDirectory,
      AGENT_BROWSER_RESTORE_SAVE: "always",
      AGENT_BROWSER_CONTENT_BOUNDARIES: "1",
    },
  }) as ChildProcessWithoutNullStreams;
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    options.logger.warn({ event: "browser.host.stderr", detail: chunk.slice(0, 500) }, "browser host stderr");
  });

  const client = new StdioMcpClient(child);
  let descriptors: BrowserToolDescriptor[] | undefined;
  let unavailableReason: string | undefined;

  try {
    await client.request(
      "initialize",
      {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "clankie-runner", version: "1" },
      },
      STARTUP_TIMEOUT_MS,
    );
    client.notify("notifications/initialized", {});
    options.logger.info(
      { event: "browser.host.ready", command, profileDirectory, granted: grants.size },
      "browser host ready",
    );
  } catch (error) {
    unavailableReason = error instanceof Error ? error.message : "browser_host_unavailable";
    options.logger.warn({ event: "browser.host.unavailable", reason: unavailableReason }, "browser host unavailable");
  }

  async function loadDescriptors(): Promise<BrowserToolDescriptor[]> {
    if (descriptors !== undefined) return descriptors;
    const result = (await client.request("tools/list", {}, REQUEST_TIMEOUT_MS)) as {
      tools?: { name?: unknown; description?: unknown; inputSchema?: unknown }[];
    };
    const projected: BrowserToolDescriptor[] = [];
    for (const tool of result.tools ?? []) {
      if (typeof tool.name !== "string") continue;
      const grant = grants.get(tool.name);
      // Undeclared or denied tools are never projected. The registry stays the
      // closed list ADR 0027 made it, so a new agent-browser release cannot
      // widen Clankie's reach without an operator editing doctrine.
      if (grant === undefined) continue;
      projected.push({
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description.slice(0, 4_000) : tool.name,
        inputSchema:
          tool.inputSchema !== null && typeof tool.inputSchema === "object"
            ? (tool.inputSchema as Record<string, unknown>)
            : { type: "object" },
        riskClass: grant.riskClass,
        requiresApproval: grant.requiresApproval,
      });
    }
    descriptors = projected;
    return projected;
  }

  return {
    async catalog(): Promise<BrowserToolCatalog> {
      if (unavailableReason !== undefined || client.closed) {
        return BrowserToolCatalogSchema.parse({
          schemaVersion: 1,
          available: false,
          reason: unavailableReason ?? "browser_host_closed",
          tools: [],
        });
      }
      try {
        return BrowserToolCatalogSchema.parse({
          schemaVersion: 1,
          available: true,
          tools: await loadDescriptors(),
        });
      } catch (error) {
        return BrowserToolCatalogSchema.parse({
          schemaVersion: 1,
          available: false,
          reason: error instanceof Error ? error.message.slice(0, 200) : "browser_catalog_failed",
          tools: [],
        });
      }
    },

    async call(request: CallBrowserToolRequest): Promise<CallBrowserToolResult> {
      const grant = grants.get(request.tool);
      if (grant === undefined) {
        return CallBrowserToolResultSchema.parse({
          outcome: "refused",
          tool: request.tool,
          reason: "doctrine_denied",
          detail: `${mcpToolAction(BROWSER_SERVER_NAME, request.tool)} is not projected to the captain`,
        });
      }
      if (unavailableReason !== undefined || client.closed) {
        return CallBrowserToolResultSchema.parse({
          outcome: "refused",
          tool: request.tool,
          reason: "browser_unavailable",
          detail: unavailableReason ?? "browser_host_closed",
        });
      }
      let result: { content?: { type?: unknown; text?: unknown }[]; isError?: unknown };
      try {
        result = (await client.request(
          "tools/call",
          { name: request.tool, arguments: request.arguments },
          REQUEST_TIMEOUT_MS,
        )) as typeof result;
      } catch (error) {
        return CallBrowserToolResultSchema.parse({
          outcome: "refused",
          tool: request.tool,
          reason: "browser_unavailable",
          detail: error instanceof Error ? error.message.slice(0, 500) : "browser_call_failed",
        });
      }
      const text = (result.content ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("\n");
      options.logger.info(
        { event: "browser.host.call", tool: request.tool, riskClass: grant.riskClass },
        "browser tool called",
      );
      return CallBrowserToolResultSchema.parse({
        outcome: "ok",
        tool: request.tool,
        content: text.slice(0, MAX_RESULT_CHARACTERS),
        isError: result.isError === true,
      });
    },

    close: () => client.close(),
  };
}
