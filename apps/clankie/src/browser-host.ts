/**
 * Clankie's own browser ([ADR 0082](../../../docs/adr/0082-clankie-holds-the-browser.md)).
 *
 * The service owns the `agent-browser` MCP server process: the captain never
 * spawns it and never holds its socket.
 *
 * - **The full action set.** Every tool the server advertises is projected,
 *   minus an optional operator blocklist (default empty).
 * - **A persistent profile.** He logs into a site once and stays logged in.
 *   The profile is service-private and is his, never the operator's browser.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discordAttachmentRoot } from "@clankie/settings";
import {
  BrowserToolCatalogSchema,
  CallBrowserToolResultSchema,
  type BrowserToolCatalog,
  type BrowserToolDescriptor,
  type CallBrowserToolRequest,
  type BrowserArtifact,
  type CallBrowserToolResult,
} from "@clankie/protocol";

/** The stdio MCP server this host drives, verbatim from the old registry entry. */
export const BROWSER_SERVER_NAME = "agent_browser";
const DEFAULT_BROWSER_COMMAND = "agent-browser";
const DEFAULT_BROWSER_ARGS = ["mcp", "--tools", "all"] as const;

/**
 * Whether the browser is switched on, defaulting to **yes**.
 *
 * Opt-in was the wrong default: a browser nobody remembers to enable is a
 * capability Clankie truthfully denies having. A missing binary degrades to a
 * logged unavailability rather than a boot failure. Only an explicit falsey
 * value turns it off.
 */
export function browserEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) return true;
  return !["0", "false", "no", "off"].includes(normalized);
}

/** Pi's own tool-output ceiling; the captain wrapper applies the byte/line check too. */
const MAX_RESULT_CHARACTERS = 50_000;
/** Matches the Discord attachment ceiling; a larger image could never be sent anyway. */
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const ARTIFACT_SUBDIRECTORY = "browser";
const REQUEST_TIMEOUT_MS = 60_000;
const STARTUP_TIMEOUT_MS = 30_000;

export interface BrowserHostLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export interface BrowserHostOptions {
  runnerStateRoot: string;
  /**
   * Where a screenshot is written so the Discord bridge can serve it back.
   * Supplied by the composition root, which derives it once for every process
   * that touches an artifact; defaulted here only so a test can point it at a
   * temporary directory.
   */
  attachmentRoot?: string;
  logger: BrowserHostLogger;
  environment?: NodeJS.ProcessEnv;
  /** Injected in tests so the suite never launches a browser. */
  spawnImpl?: typeof spawn;
  /** Tool names never projected or callable. Defaults to empty: the full catalog is allowed. */
  blockedTools?: readonly string[];
  /** Server launch command; `CLANKIE_AGENT_BROWSER_EXECUTABLE` still overrides it. */
  command?: string;
  args?: readonly string[];
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

/** Extensions the resolver can label; anything else lands as a generic blob. */
const ARTIFACT_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

export async function createBrowserHost(options: BrowserHostOptions): Promise<BrowserHost> {
  const environment = options.environment ?? process.env;
  const blockedTools = new Set(options.blockedTools ?? []);

  // Persistent and runner-private. `RESTORE_SAVE` is deliberately the opposite
  // of the Codex projection's `never`: staying logged in is the point.
  const profileDirectory = join(options.runnerStateRoot, "browser", "profile");
  const socketDirectory = join(options.runnerStateRoot, "browser", "run");
  const homeDirectory = join(options.runnerStateRoot, "browser", "home");
  const tempDirectory = join(options.runnerStateRoot, "browser", "tmp");
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  await mkdir(socketDirectory, { recursive: true, mode: 0o700 });
  await mkdir(homeDirectory, { recursive: true, mode: 0o700 });
  await mkdir(tempDirectory, { recursive: true, mode: 0o700 });

  // Artifacts land under the root the Discord attachment resolver already
  // serves, so a screenshot is attachable without a second copy or a second
  // trust boundary. The root is shared with the bridge by derivation rather
  // than by both processes happening to read the same variable: a screenshot
  // written somewhere the resolver does not serve is a reply that dies whole.
  const artifactRoot = options.attachmentRoot ?? discordAttachmentRoot(environment);
  await mkdir(join(artifactRoot, ARTIFACT_SUBDIRECTORY), { recursive: true, mode: 0o700 });

  const command =
    environment.CLANKIE_AGENT_BROWSER_EXECUTABLE?.trim() || options.command || DEFAULT_BROWSER_COMMAND;
  const child = (options.spawnImpl ?? spawn)(command, [...(options.args ?? DEFAULT_BROWSER_ARGS)], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: environment.PATH,
      LANG: environment.LANG,
      HOME: homeDirectory,
      TMPDIR: tempDirectory,
      AGENT_BROWSER_SOCKET_DIR: socketDirectory,
      AGENT_BROWSER_PROFILE: profileDirectory,
      AGENT_BROWSER_NAMESPACE: "clankie",
      AGENT_BROWSER_SESSION: "clankie",
      AGENT_BROWSER_CONTENT_BOUNDARIES: "1",
      AGENT_BROWSER_MAX_OUTPUT: String(MAX_RESULT_CHARACTERS),
    },
  }) as ChildProcessWithoutNullStreams;
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    options.logger.warn({ event: "browser.host.stderr", detail: chunk.slice(0, 500) }, "browser host stderr");
  });

  const client = new StdioMcpClient(child);
  let descriptors: BrowserToolDescriptor[] | undefined;
  let descriptorsLoading: Promise<BrowserToolDescriptor[]> | undefined;
  let unavailableReason: string | undefined;
  let callTail = Promise.resolve();

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
      { event: "browser.host.ready", command, profileDirectory, blocked: blockedTools.size },
      "browser host ready",
    );
  } catch (error) {
    unavailableReason = error instanceof Error ? error.message : "browser_host_unavailable";
    options.logger.warn(
      { event: "browser.host.unavailable", reason: unavailableReason },
      "browser host unavailable",
    );
  }

  async function loadDescriptors(): Promise<BrowserToolDescriptor[]> {
    if (descriptors !== undefined) return descriptors;
    if (descriptorsLoading !== undefined) return descriptorsLoading;
    descriptorsLoading = (async () => {
      const projected: BrowserToolDescriptor[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const result = (await client.request(
          "tools/list",
          cursor === undefined ? {} : { cursor },
          REQUEST_TIMEOUT_MS,
        )) as {
          tools?: { name?: unknown; description?: unknown; inputSchema?: unknown }[];
          nextCursor?: unknown;
        };
        for (const tool of result.tools ?? []) {
          if (typeof tool.name !== "string" || blockedTools.has(tool.name)) continue;
          projected.push({
            name: tool.name,
            description: typeof tool.description === "string" ? tool.description.slice(0, 4_000) : tool.name,
            inputSchema:
              tool.inputSchema !== null && typeof tool.inputSchema === "object"
                ? (tool.inputSchema as Record<string, unknown>)
                : { type: "object" },
            riskClass: "read",
            requiresApproval: false,
          });
        }
        const next =
          typeof result.nextCursor === "string" && result.nextCursor.length > 0
            ? result.nextCursor
            : undefined;
        if (next !== undefined && seenCursors.has(next)) throw new Error("browser_catalog_cursor_repeated");
        if (next !== undefined) seenCursors.add(next);
        cursor = next;
      } while (cursor !== undefined);
      descriptors = projected;
      return projected;
    })();
    try {
      return await descriptorsLoading;
    } finally {
      descriptorsLoading = undefined;
    }
  }

  async function call(request: CallBrowserToolRequest): Promise<CallBrowserToolResult> {
    if (Object.hasOwn(request.arguments, "extraArgs")) {
      return CallBrowserToolResultSchema.parse({
        outcome: "refused",
        tool: request.tool,
        reason: "unknown_tool",
        detail: "Raw agent-browser CLI arguments are not available through Clankie",
      });
    }
    if (blockedTools.has(request.tool)) {
      return CallBrowserToolResultSchema.parse({
        outcome: "refused",
        tool: request.tool,
        reason: "unknown_tool",
        detail: `${request.tool} is on this deployment's browser blocklist`,
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
    let result: {
      content?: { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown }[];
      isError?: unknown;
    };
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
    // Screenshots return a text path *and* an image block. Keeping only the
    // text is what let a screenshot look successful while no pixels existed
    // anywhere he could reach: he was handed a path on the runner's disk and
    // rendered it as though it were an attachment.
    const artifacts: BrowserArtifact[] = [];
    for (const block of result.content ?? []) {
      if (block.type !== "image" || typeof block.data !== "string") continue;
      const mimeType = typeof block.mimeType === "string" ? block.mimeType : "application/octet-stream";
      const bytes = Buffer.from(block.data, "base64");
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_ARTIFACT_BYTES) continue;
      const digest = createHash("sha256").update(bytes).digest("hex");
      const extension = ARTIFACT_EXTENSIONS[mimeType] ?? "bin";
      const relativePath = join(ARTIFACT_SUBDIRECTORY, `${digest}.${extension}`);
      await writeFile(join(artifactRoot, relativePath), bytes, { mode: 0o600 });
      artifacts.push({
        artifactRef: `sha256:${digest}:${relativePath}`,
        filename: `${request.tool.replace(/^agent_browser_/u, "")}-${digest.slice(0, 8)}.${extension}`,
        mimeType,
        byteLength: bytes.byteLength,
      });
    }
    options.logger.info({ event: "browser.host.call", tool: request.tool }, "browser tool called");
    return CallBrowserToolResultSchema.parse({
      outcome: "ok",
      tool: request.tool,
      content: text.slice(0, MAX_RESULT_CHARACTERS),
      isError: result.isError === true,
      artifacts,
    });
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

    call(request: CallBrowserToolRequest): Promise<CallBrowserToolResult> {
      const queued = callTail.then(() => call(request));
      callTail = queued.then(
        () => undefined,
        () => undefined,
      );
      return queued;
    },

    close: () => client.close(),
  };
}
