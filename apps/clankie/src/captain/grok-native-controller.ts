import { createConnection, type Socket } from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SeatDelivery, SeatEvent, SeatStatus } from "@clankie/agent-hosts";
import { DeliveryFence, deliveryFingerprint } from "./delivery-fence.ts";

export const GROK_NATIVE_VERSION = "1.0.46";
export const GrokSessionId = z.string().uuid();
const exec = promisify(execFile);
const Birth = z.object({
  pid: z.number().int().min(2),
  uid: z.number(),
  birth: z.tuple([z.string(), z.string()]),
  executable: z.string(),
});
type Rpc = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};
type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
export interface GrokNativeOptions {
  socketPath: string;
  executable: string;
  cwd: string;
  processHelper: string;
  sessionId: string;
  receiptsPath: string;
  timeoutMs?: number;
  /** The original visible native process and its admitted conversation. */
  guard(): Promise<void>;
}

/** Attach to an existing TUI-owned leader. Never spawn ACP stdio/headless, reconnect, or replay. */
export async function connectGrokNative(options: GrokNativeOptions) {
  GrokSessionId.parse(options.sessionId);
  const timeout = options.timeoutMs ?? 20_000;
  const deadline = Date.now() + timeout;
  let socket: Socket | undefined;
  while (!socket) {
    await options.guard();
    try {
      socket = await new Promise<Socket>((resolve, reject) => {
        const peer = createConnection(options.socketPath);
        peer.once("connect", () => resolve(peer));
        peer.once("error", (error) => {
          peer.destroy();
          reject(error);
        });
      });
    } catch {
      if (Date.now() >= deadline)
        throw new Error("Grok native leader unavailable; inspect its TUI; no fallback launched");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const peer = socket;
  const pending = new Map<string | number, Pending>();
  const fence = new DeliveryFence(options.receiptsPath);
  const receiptKey = options.sessionId;
  let buffer = Buffer.alloc(0),
    closed = false;
  let state: SeatStatus = "idle";
  let lastMessageId: string | undefined;
  let registration: unknown;
  let ready = false;
  let socketIdentity: { dev: number; ino: number } | undefined;
  let leader: z.infer<typeof Birth> | undefined;
  const events = new Map<string, SeatEvent>();
  const texts = new Map<string, string>();
  const acknowledgments = new Map<string, () => void>();
  const tools = new Map<string, readonly string[]>();
  const fail = () => {
    if (closed) return;
    closed = true;
    state = "offline";
    peer.destroy();
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("Original Grok channel unavailable"));
    }
    pending.clear();
    acknowledgments.clear();
    texts.clear();
    tools.clear();
  };
  const write = (value: unknown) => {
    if (closed || peer.destroyed) throw new Error("Original Grok channel unavailable");
    const body = Buffer.from(JSON.stringify(value));
    if (body.length > 8 * 1024 * 1024) throw new Error("Grok IPC request too large");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length);
    peer.write(Buffer.concat([header, body]));
  };
  const call = (method: string, params: unknown, waitMs = timeout): Promise<unknown> => {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Grok ${method} acknowledgment unavailable; no retry`));
      }, waitMs);
      pending.set(id, { resolve, reject, timer });
      try {
        if (method === "leader-info")
          write({ type: "control", request_id: id, command: { type: "get_leader_info" } });
        else write({ type: "acp", payload: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  };
  const handle = (message: Rpc) => {
    if (message.id !== undefined && !message.method) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error !== undefined) waiter.reject(new Error("Native Grok request refused"));
      else waiter.resolve(message.result);
      return;
    }
    const params = message.params;
    if (!params || params.sessionId !== options.sessionId) return;
    if (message.id !== undefined) {
      // Grok broadcasts permission/question interactions to its TUI subscribers;
      // only the owner answers. This controller never manufactures approval.
      state = "blocked";
      return;
    }
    if (message.method === "_x.ai/mcp/server_status" && params.status === "ready") {
      if (typeof params.name === "string" && Array.isArray(params.tools))
        tools.set(
          params.name,
          params.tools.flatMap((tool: unknown) =>
            typeof tool === "object" && tool !== null && "name" in tool && typeof tool.name === "string"
              ? [tool.name]
              : [],
          ),
        );
    }
    if (message.method === "_x.ai/queue/changed") {
      state =
        typeof params.runningPromptId === "string" ||
        (Array.isArray(params.entries) && params.entries.length > 0)
          ? "working"
          : "idle";
      const ids = [
        params.runningPromptId,
        ...(Array.isArray(params.entries)
          ? params.entries.map((entry: unknown) =>
              typeof entry === "object" && entry !== null && "id" in entry ? entry.id : undefined,
            )
          : []),
      ];
      for (const id of ids) if (typeof id === "string") acknowledgments.get(id)?.();
    }
    if (message.method === "session/update") {
      const update = params.update as
        | { sessionUpdate?: string; content?: { type?: string; text?: string } }
        | undefined;
      const meta = params._meta as { promptId?: string } | undefined;
      if (
        meta?.promptId &&
        acknowledgments.has(meta.promptId) &&
        update?.sessionUpdate === "agent_message_chunk" &&
        update.content?.type === "text"
      )
        texts.set(
          meta.promptId,
          ((texts.get(meta.promptId) ?? "") + (update.content.text ?? "")).slice(-32_000),
        );
    }
  };
  peer.on("error", fail);
  peer.on("close", fail);
  peer.on("data", (chunk: Buffer) => {
    try {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length > 8 * 1024 * 1024) throw new Error("Grok IPC frame too large");
        if (buffer.length < length + 4) break;
        const frame = JSON.parse(buffer.subarray(4, length + 4).toString());
        buffer = buffer.subarray(length + 4);
        if (frame.type === "registered") {
          registration = frame;
          ready = frame.ready === true;
        } else if (frame.type === "leader_ready") ready = true;
        else if (frame.type === "acp") handle(JSON.parse(frame.payload));
        else if (frame.type === "control_result")
          handle({ id: frame.request_id, result: frame.result?.Ok, error: frame.result?.Err });
        else if (["error", "shutdown", "shutting_down"].includes(frame.type)) fail();
      }
    } catch {
      fail();
    }
  });
  const observe = async (pid: number) =>
    Birth.parse(
      JSON.parse(
        (await exec("/usr/bin/python3", ["-I", options.processHelper, String(pid)], { timeout: 5000 }))
          .stdout,
      ),
    );
  const checkLeader = async (requireConnection = true) => {
    if (!leader || (requireConnection && (closed || peer.destroyed)))
      throw new Error("Original Grok leader unavailable");
    const facts = await observe(leader.pid);
    const file = await stat(options.socketPath);
    const opened = (
      await exec("/usr/sbin/lsof", ["-a", "-p", String(leader.pid), "-U", "-Fn"], { timeout: 5000 })
    ).stdout;
    const cwd = (
      await exec("/usr/sbin/lsof", ["-a", "-p", String(leader.pid), "-d", "cwd", "-Fn"], { timeout: 5000 })
    ).stdout;
    if (
      JSON.stringify(facts) !== JSON.stringify(leader) ||
      !file.isSocket() ||
      file.dev !== socketIdentity?.dev ||
      file.ino !== socketIdentity.ino ||
      !opened.split("\n").includes(`n${options.socketPath}`) ||
      !cwd.split("\n").includes(`n${options.cwd}`)
    )
      throw new Error("Original Grok process lifetime or private socket changed");
  };
  const verify = async () => {
    await options.guard();
    await checkLeader();
    await options.guard();
  };
  try {
    const socketFile = await stat(options.socketPath);
    if (!socketFile.isSocket() || socketFile.uid !== process.getuid?.())
      throw new Error("Grok socket owner unavailable");
    socketIdentity = { dev: socketFile.dev, ino: socketFile.ino };
    write({
      type: "register",
      client_type: "clankie",
      mode: "stdio",
      capabilities: { client_version: GROK_NATIVE_VERSION },
    });
    while ((!registration || !ready) && !closed && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    const registered = z
      .object({
        ready: z.boolean(),
        leader_protocol_version: z.literal(1),
        leader_binary_version: z.literal(GROK_NATIVE_VERSION),
      })
      .parse(registration);
    void registered;
    if (!ready) throw new Error("Original Grok leader is not ready");
    const info = z
      .object({
        pid: z.number().int().min(2),
        socket_path: z.literal(options.socketPath),
        leader_protocol_version: z.literal(1),
        leader_binary_version: z.literal(GROK_NATIVE_VERSION),
      })
      .parse(await call("leader-info", {}));
    leader = await observe(info.pid);
    if (
      leader.uid !== process.getuid?.() ||
      (await realpath(leader.executable)) !== (await realpath(options.executable))
    )
      throw new Error("Grok native executable mismatch");
    await verify();
    const initialized = z
      .object({
        protocolVersion: z.literal(1),
        _meta: z.object({ agentVersion: z.literal(GROK_NATIVE_VERSION) }),
      })
      .parse(
        await call("initialize", {
          protocolVersion: 1,
          clientInfo: { name: "clankie", version: "0.2.0" },
          clientCapabilities: {},
        }),
      );
    void initialized;
    return {
      sessionId: options.sessionId,
      leaderPid: leader.pid,
      verify,
      verifyLeader: () => checkLeader(),
      async load(input: {
        mcpServers: readonly unknown[];
        systemPrompt?: string;
        model?: string;
        effort?: string;
      }) {
        await verify();
        const result = z
          .object({
            _meta: z.object({ sessionId: z.literal(options.sessionId) }),
            models: z.object({ currentModelId: z.string() }).optional(),
            configOptions: z
              .array(
                z.object({
                  id: z.string(),
                  category: z.string().optional(),
                  currentValue: z.string(),
                  options: z.array(z.object({ value: z.string() })).optional(),
                }),
              )
              .optional(),
          })
          .parse(
            await call("session/load", {
              sessionId: options.sessionId,
              cwd: options.cwd,
              mcpServers: input.mcpServers,
              _meta: {
                "x.ai/restore_code": false,
                ...(input.systemPrompt ? { systemPromptOverride: input.systemPrompt } : {}),
              },
            }),
          );
        for (const [category, requested] of [
          ["model", input.model],
          ["thought_level", input.effort],
        ] as const) {
          if (requested === undefined) continue;
          const option = result.configOptions?.find((entry) => entry.category === category);
          if (!option?.options?.some((entry) => entry.value === requested))
            throw new Error(`Grok ${category} unavailable; no default substituted`);
          await verify();
          const selected = z
            .object({ configOptions: z.array(z.object({ id: z.string(), currentValue: z.string() })) })
            .parse(
              await call("session/set_config_option", {
                sessionId: options.sessionId,
                configId: option.id,
                value: requested,
              }),
            );
          if (selected.configOptions.find((entry) => entry.id === option.id)?.currentValue !== requested)
            throw new Error("Grok selection not confirmed");
        }
        await verify();
      },
      async waitTools(server: string, expected: readonly string[]) {
        const until = Date.now() + timeout;
        let observed: unknown;
        while (true) {
          if (closed || Date.now() >= until)
            throw new Error(
              `Grok MCP catalog unavailable; no brief sent. Observed: ${JSON.stringify(observed)}`,
            );
          const extension = z
            .object({ result: z.unknown() })
            .parse(await call("_x.ai/mcp/list", { sessionId: options.sessionId }));
          const catalog = z
            .object({
              servers: z.array(
                z.object({
                  name: z.string(),
                  url: z.string().optional(),
                  args: z.array(z.string()).optional(),
                  session: z
                    .object({
                      enabled: z.boolean(),
                      status: z.string().optional(),
                      tools: z.array(z.object({ name: z.string(), enabled: z.boolean() })).optional(),
                    })
                    .optional(),
                }),
              ),
            })
            .parse(extension.result);
          // Leader mode ignores --deny/--allow. Refuse an observed direct
          // Linear endpoint rather than pretending those flags isolate it.
          if (
            catalog.servers.some(
              (item) =>
                item.name !== server &&
                item.session?.enabled &&
                [item.url, ...(item.args ?? [])].some((value) => {
                  try {
                    return value !== undefined && new URL(value).hostname === "mcp.linear.app";
                  } catch {
                    return false;
                  }
                }),
            )
          )
            throw new Error(
              "Grok has an enabled direct Linear MCP endpoint. Disable it in this Grok profile, then start a fresh seat; no brief was sent and no configuration changed.",
            );
          observed = catalog.servers
            .filter((item) => item.name === server)
            .map((item) => ({
              name: item.name,
              status: item.session?.status,
              tools: item.session?.tools?.map((tool) => tool.name),
            }));
          const current = catalog.servers.find((item) => item.name === server)?.session;
          const enabled = current?.tools?.filter((tool) => tool.enabled).map((tool) => tool.name) ?? [];
          const ready =
            current?.enabled &&
            (current.status === "ready" ||
              (current.status === undefined && expected.every((name) => tools.get(server)?.includes(name))));
          if (ready && expected.every((name) => enabled.includes(name))) return enabled;
          if (!current?.enabled || (current.status !== undefined && current.status !== "ready"))
            tools.delete(server);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      },
      async send(
        text: string,
        beforeDispatch?: () => Promise<boolean>,
        waitMs = timeout,
      ): Promise<SeatDelivery> {
        const unresolved = fence.pending(receiptKey);
        if (unresolved)
          return {
            outcome: "unconfirmed",
            messageId: unresolved.messageId,
            detail: "Original Grok dispatch remains uncertain; no resend",
            deliveryStage: "uncertain",
          };
        const messageId = randomUUID();
        await verify();
        if (beforeDispatch && !(await beforeDispatch()))
          return {
            outcome: "offline",
            detail: "Grok dispatch authority changed",
            deliveryStage: "unavailable",
          };
        const receipt = fence.begin(receiptKey, {
          messageId,
          fingerprint: deliveryFingerprint(text),
          sessionId: options.sessionId,
        });
        lastMessageId = messageId;
        // Late evidence settles this original receipt; it never dispatches another prompt.
        const acknowledge = async () => {
          await verify();
          fence.reconcile(receiptKey, messageId);
        };
        let resolveAck!: () => void;
        const accepted = new Promise<void>((resolve) => {
          resolveAck = resolve;
        });
        acknowledgments.set(messageId, () => {
          void acknowledge()
            .then(resolveAck)
            .catch(() => {});
        });
        const completion = call(
          "session/prompt",
          {
            sessionId: options.sessionId,
            prompt: [{ type: "text", text }],
            _meta: { promptId: messageId, clientIdentifier: "clankie" },
          },
          24 * 60 * 60 * 1000,
        )
          .then(async (value) => {
            const result = z
              .object({
                stopReason: z.string(),
                _meta: z.object({ sessionId: z.literal(options.sessionId), promptId: z.literal(messageId) }),
              })
              .parse(value);
            events.set(messageId, {
              type: "turn_completed",
              at: new Date().toISOString(),
              messageId,
              ok: result.stopReason === "end_turn",
              text: texts.get(messageId) ?? "",
              stopReason: result.stopReason,
            });
            if (events.size > 100) events.delete(events.keys().next().value!);
            texts.delete(messageId);
            await acknowledge();
            resolveAck();
            acknowledgments.delete(messageId);
          })
          .catch(() => {
            acknowledgments.delete(messageId);
            texts.delete(messageId);
            state = closed ? "offline" : "blocked";
          });
        void completion;
        let ackTimer: ReturnType<typeof setTimeout> | undefined;
        const ack = await Promise.race([
          accepted.then(() => true),
          new Promise<false>((resolve) => {
            ackTimer = setTimeout(() => resolve(false), waitMs);
          }),
        ]);
        clearTimeout(ackTimer);
        if (!ack)
          return {
            outcome: "unconfirmed",
            messageId: receipt.messageId,
            detail: "Grok native queue acknowledgment unavailable; inspect original session before retrying",
            deliveryStage: "uncertain",
          };
        return { outcome: "accepted", messageId, state: "queued", deliveryStage: "consumed" };
      },
      status: (): SeatStatus => state,
      async settled(signal?: AbortSignal): Promise<SeatEvent> {
        while (true) {
          signal?.throwIfAborted();
          const completed = lastMessageId ? events.get(lastMessageId) : undefined;
          if (completed) return completed;
          if (state === "offline") return { type: "released", at: new Date().toISOString() };
          if (state === "blocked")
            return {
              type: "blocked",
              at: new Date().toISOString(),
              reason: "Grok native permission or question requires the owner",
            };
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      },
      async interrupt() {
        await verify();
        write({
          type: "acp",
          payload: JSON.stringify({
            jsonrpc: "2.0",
            method: "session/cancel",
            params: { sessionId: options.sessionId },
          }),
        });
        return true;
      },
      close: async () => fail(),
      /** Only after the launcher's TUI has exited. Never kill by saved PID alone. */
      async stopOwnedLeader() {
        await checkLeader(false);
        process.kill(leader!.pid, "SIGTERM");
        fail();
      },
    };
  } catch (error) {
    fail();
    throw error;
  }
}
export type GrokNativeController = Awaited<ReturnType<typeof connectGrokNative>>;
