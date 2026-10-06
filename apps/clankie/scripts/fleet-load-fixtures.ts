import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/** Minimized native shapes in test/fixtures/codex-subagents.json, expanded with deterministic tool output. */
export async function seedCodex(root: string, workspace: string, workers: number, largeMb: number) {
  const directory = join(root, "sessions", "2026", "10", "05");
  await mkdir(directory, { recursive: true });
  const now = new Date().toISOString();
  const line = (type: string, payload: unknown) => `${JSON.stringify({ timestamp: now, type, payload })}\n`;
  const ids: string[] = Array.from({ length: workers }, () => randomUUID());
  const db = new DatabaseSync(join(root, "goals_1.sqlite"));
  db.exec(
    "CREATE TABLE thread_goals (thread_id TEXT PRIMARY KEY, objective TEXT, status TEXT, token_budget INTEGER, tokens_used INTEGER, time_used_seconds REAL, created_at_ms INTEGER, updated_at_ms INTEGER)",
  );
  const insert = db.prepare("INSERT INTO thread_goals VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  let bytes = 0;
  for (const [index, id] of ids.entries()) {
    const header = line("session_meta", {
      id,
      cwd: workspace,
      cli_version: "0.160.0",
      thread_source: "user",
      timestamp: now,
    });
    const call = line("response_item", {
      type: "function_call",
      name: "exec_command",
      call_id: "build",
      arguments: JSON.stringify({ cmd: "pnpm typecheck" }),
    });
    const output = line("response_item", {
      type: "function_call_output",
      call_id: "build",
      output: "Build output " + "x".repeat(32 * 1024),
    });
    const target = (index < 2 ? largeMb : 1) * 1024 * 1024;
    const text = header + call + output.repeat(Math.ceil(target / Buffer.byteLength(output)));
    await writeFile(join(directory, `rollout-2026-10-05T00-00-${id}.jsonl`), text);
    bytes += Buffer.byteLength(text);
    insert.run(
      id,
      `Complete worker ${index + 1}'s authorized build`,
      "active",
      20_000,
      1000,
      60,
      Date.now(),
      Date.now(),
    );
    const child = randomUUID();
    await writeFile(
      join(directory, `rollout-2026-10-05T00-01-${child}.jsonl`),
      line("session_meta", {
        id: child,
        parent_thread_id: id,
        cwd: workspace,
        thread_source: "subagent",
        agent_nickname: "Fixture child",
        agent_path: `/root/worker_${index}`,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: id,
              depth: 1,
              agent_path: `/root/worker_${index}`,
              agent_nickname: "Fixture child",
              agent_role: "worker",
            },
          },
        },
      }) + line("event_msg", { type: "task_started", turn_id: randomUUID() }),
    );
  }
  db.close();
  // A real account has accumulated unrelated sessions. Header discovery must
  // walk this tree, while the addressed parents include two long sessions.
  for (let index = 0; index < 512; index++) {
    const id = randomUUID();
    await writeFile(
      join(directory, `rollout-2026-10-04T00-${index}-${id}.jsonl`),
      line("session_meta", { id, cwd: workspace, thread_source: "user", cli_version: "0.160.0" }),
    );
  }
  return { ids, bytes, files: workers * 2 + 512, largeParents: Math.min(2, workers), largeMb };
}

/** A controlled external Linear MCP provider, reached through the native SDK HTTP transport. */
export async function startLinearFixture() {
  const calls: Array<{ at: number; tool: string }> = [];
  const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>();
  const http = createServer(async (req, res) => {
    try {
      const session = req.headers["mcp-session-id"];
      let entry = typeof session === "string" ? sessions.get(session) : undefined;
      if (!entry) {
        const server = new Server(
          { name: "fleet-load-linear", version: "1" },
          { capabilities: { tools: {} } },
        );
        server.setRequestHandler(ListToolsRequestSchema, async () => ({
          tools: [
            {
              name: "get_issue",
              description: "Read an issue",
              inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
            },
            {
              name: "list_issues",
              description: "Read project issues",
              inputSchema: { type: "object", additionalProperties: true },
            },
          ],
        }));
        server.setRequestHandler(CallToolRequestSchema, async (request) => {
          calls.push({ at: Date.now(), tool: request.params.name });
          const issue = {
            id: "c6c44501-b294-42cd-b3a0-f191308f6bcc",
            identifier: "LOAD-1",
            title: "Fixture build",
            priority: 2,
            description: "Fixture issue",
            status: "In Progress",
            statusType: "started",
            updatedAt: new Date().toISOString(),
            url: "https://linear.app/fixture/issue/LOAD-1",
            labels: [],
          };
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  request.params.name === "list_issues" ? { issues: [issue], hasNextPage: false } : issue,
                ),
              },
            ],
          };
        });
        const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          onsessioninitialized: (id): void => {
            sessions.set(id, { server, transport });
          },
        });
        entry = { server, transport };
        await server.connect(transport as Transport);
      }
      await entry.transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    }
  });
  const url = await listen(http);
  return {
    url,
    calls,
    async close() {
      await Promise.all([...sessions.values()].map((entry) => entry.server.close()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

async function listen(server: HttpServer) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture listener has no address");
  return `http://127.0.0.1:${address.port}`;
}
