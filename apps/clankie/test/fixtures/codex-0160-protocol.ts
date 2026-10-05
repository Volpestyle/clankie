import { randomUUID } from "node:crypto";
import { appendFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { openCodexSocket, type CodexServerLauncher } from "../../src/captain/codex-app-server.ts";

type Rpc = { id?: number | string; method: string; params: Record<string, unknown> };
type Turn = {
  id: string;
  status: "inProgress" | "completed" | "interrupted";
  items: Record<string, unknown>[];
};

/**
 * Wire shapes: installed Codex 0.160.0 generated v2 JSON schema, and tag
 * rust-v0.160.0: codex-rs/core/src/tools/handlers/request_user_input_async.rs,
 * codex-rs/tui/src/bottom_pane/async_questions/state.rs,
 * codex-rs/context-fragments/src/answered_question.rs,
 * codex-rs/tui/src/app_server_session.rs and
 * codex-rs/app-server-protocol/src/protocol/thread_history.rs.
 * Only the external server/native view is controlled; all Clankie transport is real.
 */
export async function codex0160Protocol(
  directory: string,
  options: { initialQuestion?: { callId: string; title: string } } = {},
) {
  const threadId = randomUUID();
  const rolloutPath = join(directory, `rollout-2026-10-05T12-00-00-${threadId}.jsonl`);
  await writeFile(
    rolloutPath,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "session_meta",
      payload: { id: threadId, cwd: directory, cli_version: "0.160.0", source: "cli" },
    }) + "\n",
  );
  const http = createServer();
  const server = new WebSocketServer({ server: http });
  let peer: WebSocket | undefined;
  let loaded = false;
  let closed = false;
  let omitUserReceipt = false;
  let subscribed = false;
  let nextRead: { entered: () => void; release: Promise<void> } | undefined;
  const turns: Turn[] = [];
  const requests: Rpc[] = [];
  const errors: Error[] = [];
  const notify = (method: string, params: Record<string, unknown>) => {
    // App-server notifications are delivered only after thread/resume subscribes
    // this connection. Fast initial turns must be recovered from native history.
    if (subscribed) peer!.send(JSON.stringify({ method, params }));
  };
  const questionItem = (callId: string, title: string) => ({
    type: "agentMessage",
    id: callId,
    text: title,
    phase: "final_answer",
    delivery: "async",
    questions: [{ title, options: ["Task worktree", "Main checkout"] }],
  });
  const active = () => turns.findLast((turn) => turn.status === "inProgress");
  const thread = () => ({
    id: threadId,
    sessionId: threadId,
    turns,
    path: rolloutPath,
    cwd: directory,
    cliVersion: "0.160.0",
    createdAt: 1_791_201_600,
    updatedAt: 1_791_201_600,
    ephemeral: false,
    modelProvider: "fixture",
    preview: "",
    projectId: null,
    source: "cli",
    status: active() ? { type: "active", activeFlags: [] } : { type: "idle" },
  });
  server.on("connection", (socket) => {
    peer = socket;
    socket.on("message", (bytes) => {
      const request = JSON.parse(bytes.toString()) as Rpc;
      requests.push(request);
      if (request.id === undefined) return;
      let result: unknown;
      try {
        switch (request.method) {
          case "initialize":
            result = { userAgent: "codex/0.160.0", codexHome: directory };
            break;
          case "thread/loaded/list":
            result = { data: loaded ? [threadId] : [], nextCursor: null };
            break;
          case "thread/read":
            if (nextRead) {
              const held = nextRead;
              nextRead = undefined;
              held.entered();
              void held.release.then(() =>
                socket.send(JSON.stringify({ id: request.id, result: { thread: thread() } })),
              );
              return;
            }
            result = { thread: thread() };
            break;
          case "thread/resume":
            if (turns.length === 0) {
              socket.send(
                JSON.stringify({ id: request.id, error: { code: -32000, message: "no rollout found" } }),
              );
              return;
            }
            result = {
              thread: thread(),
              approvalPolicy: "never",
              approvalsReviewer: "user",
              cwd: directory,
              model: "fixture-model",
              modelProvider: "fixture",
              sandbox: { type: "readOnly" },
            };
            subscribed = true;
            break;
          case "turn/start": {
            if (active()) throw new Error("A second turn started before native idle");
            const turn: Turn = { id: `turn-${turns.length + 1}`, status: "inProgress", items: [] };
            turns.push(turn);
            if (turns.length === 1 && options.initialQuestion) {
              turn.items.push(questionItem(options.initialQuestion.callId, options.initialQuestion.title));
              turn.status = "completed";
            }
            if (!omitUserReceipt && typeof request.params.clientUserMessageId === "string")
              turn.items.push({
                type: "userMessage",
                id: randomUUID(),
                clientId: request.params.clientUserMessageId,
                content: request.params.input,
              });
            result = { turn };
            break;
          }
          case "turn/steer": {
            const turn = active();
            if (!turn || request.params.expectedTurnId !== turn.id)
              throw new Error("Wrong active native turn was steered");
            if (!omitUserReceipt && typeof request.params.clientUserMessageId === "string")
              turn.items.push({
                type: "userMessage",
                id: randomUUID(),
                clientId: request.params.clientUserMessageId,
                content: request.params.input,
              });
            result = { turnId: turn.id };
            break;
          }
          default:
            throw new Error(`Unexpected fixture RPC: ${request.method}`);
        }
        socket.send(JSON.stringify({ id: request.id, result }));
        if (request.method === "turn/start" && active())
          notify("turn/started", { threadId, turn: active()! });
      } catch (error) {
        errors.push(error as Error);
        socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: String(error) } }));
      }
    });
  });
  http.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    http.once("listening", resolve);
    http.once("error", reject);
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture socket address");
  const endpoint = `ws://127.0.0.1:${address.port}`;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  };
  const launch: CodexServerLauncher = async () => ({
    endpoint,
    connect: () => openCodexSocket(endpoint),
    failure: () => undefined,
    output: () => "",
    close,
  });
  return {
    threadId,
    rolloutPath,
    launch,
    endpoint,
    requests,
    errors,
    turns,
    notify,
    close,
    startView: () => {
      loaded = true;
    },
    omitAnswerReceipt: () => {
      omitUserReceipt = true;
    },
    holdNextRead() {
      let entered!: () => void;
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        entered = resolve;
      });
      nextRead = {
        entered,
        release: new Promise<void>((resolve) => {
          release = resolve;
        }),
      };
      return { pending, release };
    },
    async ask(callId: string, title = "Which worktree should I use?", targetThread: string = threadId) {
      const turn = active()!;
      const item = questionItem(callId, title);
      await appendFile(
        rolloutPath,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "response_item",
          payload: { type: "function_call_output", call_id: callId, output: '{"accepted":true}' },
        }) + "\n",
      );
      if (targetThread === threadId) turn.items.push(item);
      notify("item/started", { threadId: targetThread, turnId: turn.id, item, startedAtMs: Date.now() });
      notify("item/completed", { threadId: targetThread, turnId: turn.id, item, completedAtMs: Date.now() });
    },
    finish(status: "completed" | "interrupted", text: string, terminalEvent = true) {
      const turn = active()!;
      turn.status = status;
      turn.items.push({ type: "agentMessage", id: randomUUID(), text, phase: "final_answer" });
      if (terminalEvent) notify("turn/completed", { threadId, turn });
      notify("thread/status/changed", { threadId, status: { type: "idle" } });
    },
  };
}
