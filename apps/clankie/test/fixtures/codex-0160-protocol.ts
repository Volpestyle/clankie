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
  options: {
    initialQuestion?: { callId: string; title: string };
    historicalQuestion?: { callId: string; title: string };
    /** Replay an observed thread identity across native RPC and host-proof goldens. */
    threadId?: string;
    threadName?: string;
    rejectName?: boolean;
  } = {},
) {
  const threadId = options.threadId ?? randomUUID();
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
  let threadName = options.threadName;
  let nextLoadedInventory: unknown;
  let closed = false;
  let silentInterrupt = false;
  let omitUserReceipt = false;
  let subscribed = false;
  let nextRead: { entered: () => void; release: Promise<void> } | undefined;
  let nextMutationReply: { entered: () => void; release: Promise<void> } | undefined;
  let ownerReply: Record<string, unknown> | undefined;
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
    name: threadName ?? null,
    status: active() ? { type: "active", activeFlags: [] } : { type: "idle" },
  });
  const recordReply = (turn: Turn, request: Rpc) => {
    if (typeof request.params.clientUserMessageId !== "string") return;
    // The owner input races at the real RPC receipt boundary: controller
    // guards have already run, and this reply precedes the lead's acceptance.
    if (ownerReply !== undefined) {
      const item = ownerReply;
      ownerReply = undefined;
      turn.items.push(item);
      notify("item/completed", { threadId, turnId: turn.id, item, completedAtMs: Date.now() });
    }
    if (!omitUserReceipt)
      turn.items.push({
        type: "userMessage",
        id: randomUUID(),
        clientId: request.params.clientUserMessageId,
        content: request.params.input,
      });
  };
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
            result = nextLoadedInventory ?? { data: loaded ? [threadId] : [], nextCursor: null };
            nextLoadedInventory = undefined;
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
          case "thread/name/set":
            if (
              request.params.threadId !== threadId ||
              typeof request.params.name !== "string" ||
              options.rejectName
            )
              throw new Error("Native thread name was rejected");
            threadName = request.params.name;
            result = {};
            notify("thread/name/updated", { threadId, threadName });
            break;
          case "thread/turns/list":
            if (
              request.params.threadId !== threadId ||
              request.params.limit !== 1 ||
              request.params.sortDirection !== "desc" ||
              request.params.itemsView !== "full"
            )
              throw new Error("Unexpected latest-turn page contract");
            result = { data: turns.slice(-1), nextCursor: null, backwardsCursor: null };
            break;
          case "thread/resume":
            if (turns.length === 0) {
              socket.send(
                JSON.stringify({ id: request.id, error: { code: -32000, message: "no rollout found" } }),
              );
              return;
            }
            result = {
              thread: request.params.excludeTurns === true ? { ...thread(), turns: [] } : thread(),
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
            if (turns.length === 0 && options.historicalQuestion)
              turns.push({
                id: "historical-turn",
                status: "completed",
                items: [questionItem(options.historicalQuestion.callId, options.historicalQuestion.title)],
              });
            const turn: Turn = { id: `turn-${turns.length + 1}`, status: "inProgress", items: [] };
            turns.push(turn);
            if (
              requests.filter(({ method }) => method === "turn/start").length === 1 &&
              options.initialQuestion
            ) {
              turn.items.push(questionItem(options.initialQuestion.callId, options.initialQuestion.title));
              turn.status = "completed";
            }
            recordReply(turn, request);
            result = { turn };
            break;
          }
          case "turn/interrupt": {
            const turn = active();
            if (!turn || request.params.threadId !== threadId || request.params.turnId !== turn.id)
              throw new Error("Wrong native turn was interrupted");
            result = {};
            if (!silentInterrupt) {
              turn.status = "interrupted";
              notify("turn/completed", { threadId, turn });
              notify("thread/status/changed", { threadId, status: { type: "idle" } });
            }
            silentInterrupt = false;
            break;
          }
          case "turn/steer": {
            const turn = active();
            if (!turn || request.params.expectedTurnId !== turn.id)
              throw new Error("Wrong active native turn was steered");
            recordReply(turn, request);
            result = { turnId: turn.id };
            break;
          }
          default:
            throw new Error(`Unexpected fixture RPC: ${request.method}`);
        }
        if (nextMutationReply && (request.method === "turn/start" || request.method === "turn/steer")) {
          const held = nextMutationReply;
          nextMutationReply = undefined;
          held.entered();
          void held.release.then(() => socket.send(JSON.stringify({ id: request.id, result })));
          return;
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
    nextLoadedInventory(value: unknown) {
      nextLoadedInventory = value;
    },
    holdNextMutationReply() {
      let entered!: () => void;
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        entered = resolve;
      });
      nextMutationReply = {
        entered,
        release: new Promise<void>((resolve) => {
          release = resolve;
        }),
      };
      return { pending, release };
    },
    omitAnswerReceipt: () => {
      omitUserReceipt = true;
    },
    ownerAnswerOnNextDispatch(reply: { questionItemId: string; question: string; answer: string }) {
      const clientId = randomUUID();
      ownerReply = {
        type: "userMessage",
        id: randomUUID(),
        clientId,
        content: [
          {
            type: "text",
            text: `<send_user_message_question_reply>\n${JSON.stringify([reply])}\n</send_user_message_question_reply>`,
            text_elements: [],
          },
        ],
      };
      return clientId;
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
    silenceNextInterrupt() {
      silentInterrupt = true;
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
