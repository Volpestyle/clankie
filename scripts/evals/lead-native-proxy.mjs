/** A deny-by-default native JSON-RPC boundary. No sockets or processes on import. */
import { nativePermissionProfile } from "./lead-native-policy.mjs";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chmodSync, lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";

const MAX_FRAME = 1024 * 1024;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some((key) => !allowed.includes(key)))
    throw Error("Unrecognized native protocol fields");
}
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const READS = {
  "account/read": ["refreshToken"],
  "account/rateLimits/read": ["excludeResetCreditDetails"],
  "model/list": ["cursor", "limit", "includeHidden"],
  "configRequirements/read": [],
  "collaborationMode/list": [],
  "thread/read": ["threadId", "includeTurns"],
};
const UX_CONFIG = ["model_reasoning_effort", "model_reasoning_summary", "model_verbosity", "personality"];
const THREAD_FIELDS = [
  "model",
  "modelProvider",
  "serviceTier",
  "cwd",
  "runtimeWorkspaceRoots",
  "approvalPolicy",
  "approvalsReviewer",
  "sandbox",
  "permissions",
  "config",
  "baseInstructions",
  "developerInstructions",
  "personality",
  "ephemeral",
  "historyMode",
  "sessionStartSource",
  "threadSource",
  "projectId",
  "environments",
  "dynamicTools",
  "selectedCapabilityRoots",
  "experimentalRawEvents",
  "allowProviderModelFallback",
  "multiAgentMode",
  "serviceName",
];
const TURN_FIELDS = [
  "threadId",
  "input",
  "clientUserMessageId",
  "cwd",
  "runtimeWorkspaceRoots",
  "approvalPolicy",
  "approvalsReviewer",
  "sandboxPolicy",
  "permissions",
  "model",
  "serviceTier",
  "serviceTierForTurn",
  "effort",
  "summary",
  "personality",
  "collaborationMode",
  "outputSchema",
  "environments",
  "additionalContext",
  "turnTrigger",
  "toolOutput",
  "responsesapiClientMetadata",
  "multiAgentMode",
  "cyberAccessProgram",
];

/** Explicit canonicalization is confined to this eval policy, never normal native seats. */
export class NativeRequestPolicy {
  #started = false;
  constructor({ allocationId, cwd, profile, model, effort }) {
    if (!/^[a-z0-9-]+$/u.test(allocationId) || cwd !== `/eval/tasks/${allocationId}`)
      throw Error("Exact allocated protocol workspace required");
    if (
      typeof model !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/u.test(model) ||
      !["low", "medium", "high", "xhigh"].includes(effort)
    )
      throw Error("Pinned native model and effort required");
    this.model = model;
    this.effort = effort;
    this.allocationId = allocationId;
    this.cwd = cwd;
    const expected = nativePermissionProfile(cwd);
    if (!isDeepStrictEqual(profile, expected)) throw Error("Pinned native permission profile required");
    this.profile = structuredClone(profile);
  }
  prepare(message) {
    keys(message, ["id", "method", "params", "jsonrpc"]);
    if (message.jsonrpc !== undefined && message.jsonrpc !== "2.0") throw Error("Invalid JSON-RPC version");
    if (typeof message.method !== "string") throw Error("Client responses are not admitted");
    if (message.method === "initialized") {
      if (message.id !== undefined || (message.params != null && Object.keys(message.params).length))
        throw Error("Invalid initialized notification");
      return { message, kind: "notification" };
    }
    if (!(typeof message.id === "string" || Number.isSafeInteger(message.id)))
      throw Error("Native request identity required");
    const params = message.params == null ? {} : structuredClone(message.params);
    if (message.method === "initialize") {
      keys(params, ["clientInfo", "capabilities"]);
      keys(params.clientInfo, ["name", "title", "version"]);
      if (params.clientInfo.name !== "codex-tui" || typeof params.clientInfo.version !== "string")
        throw Error("Only the pinned native TUI client is supported");
      keys(params.capabilities, [
        "experimentalApi",
        "requestAttestation",
        "optOutNotificationMethods",
        "extensions",
      ]);
      if (
        params.capabilities.experimentalApi !== true ||
        params.capabilities.requestAttestation === true ||
        params.capabilities.optOutNotificationMethods != null ||
        params.capabilities.extensions != null
      )
        throw Error("Unsupported native initialization capabilities");
      return { message: { ...message, params }, kind: "initialize" };
    }
    if (Object.hasOwn(READS, message.method)) {
      keys(params, READS[message.method]);
      if (message.method === "account/read" && params.refreshToken !== false)
        throw Error("Account refresh is not an admitted native read");
      return { message, kind: "read" };
    }
    if (message.method === "thread/start") {
      if (this.#started) throw Error("One fresh native root per allocation");
      keys(params, THREAD_FIELDS);
      if (params.model != null && params.model !== this.model) throw Error("Native model override refused");
      params.model = this.model;
      this.#permissions(params, "sandbox");
      for (const field of [
        "environments",
        "dynamicTools",
        "selectedCapabilityRoots",
        "multiAgentMode",
        "serviceName",
        "projectId",
      ])
        if (params[field] != null) throw Error(`Unsupported native thread field: ${field}`);
      if (params.modelProvider != null && params.modelProvider !== "openai")
        throw Error("Native provider override refused");
      params.modelProvider = "openai";
      const config = params.config ?? {};
      keys(config, ["default_permissions", "features", "permissions", "web_search", ...UX_CONFIG]);
      const trusted = {
        default_permissions: "lead_eval",
        features: { multi_agent: false },
        permissions: { lead_eval: this.profile },
        web_search: "disabled",
      };
      for (const key of ["default_permissions", "features", "permissions", "web_search"])
        if (config[key] !== undefined && !isDeepStrictEqual(config[key], trusted[key]))
          throw Error(`Native config override refused: ${key}`);
      for (const key of UX_CONFIG) {
        if (config[key] != null && typeof config[key] !== "string")
          throw Error("Invalid native presentation config");
        if (config[key] !== undefined) trusted[key] = config[key];
      }
      // CLI flags alone are not a lock: the server applies request config afterward.
      if (trusted.model_reasoning_effort != null && trusted.model_reasoning_effort !== this.effort)
        throw Error("Native effort override refused");
      params.config = {
        ...trusted,
        model_reasoning_effort: this.effort,
        mcp_servers: {},
        approval_policy: "never",
      };
      this.#started = true;
      return { message: { ...message, params }, kind: "start" };
    }
    if (message.method === "turn/start") {
      keys(params, TURN_FIELDS);
      this.#permissions(params, "sandboxPolicy");
      for (const field of [
        "environments",
        "additionalContext",
        "toolOutput",
        "responsesapiClientMetadata",
        "turnTrigger",
        "multiAgentMode",
        "cyberAccessProgram",
        "outputSchema",
      ])
        if (params[field] != null) throw Error(`Unsupported native turn field: ${field}`);
      if (
        (params.model != null && params.model !== this.model) ||
        (params.effort != null && params.effort !== this.effort)
      )
        throw Error("Native model/effort override refused");
      params.model = this.model;
      params.effort = this.effort;
      if (params.collaborationMode != null) {
        keys(params.collaborationMode, ["mode", "settings"]);
        const settings = params.collaborationMode.settings;
        keys(settings, ["model", "reasoning_effort", "developer_instructions"]);
        if (
          params.collaborationMode.mode !== "default" ||
          settings.developer_instructions != null ||
          settings.model !== params.model ||
          settings.reasoning_effort !== params.effort
        )
          throw Error("Unsupported native collaboration override");
      }
      this.#input(params.input);
      return { message: { ...message, params }, kind: "turn" };
    }
    if (message.method === "turn/steer") {
      keys(params, ["threadId", "input", "expectedTurnId"]);
      this.#input(params.input);
      if (typeof params.expectedTurnId !== "string") throw Error("Invalid native steer");
      return { message: { ...message, params }, kind: "turn" };
    }
    if (message.method === "turn/interrupt") {
      keys(params, ["threadId", "turnId"]);
      return { message: { ...message, params }, kind: "interrupt" };
    }
    // Includes process/spawn (unsandboxed), command/exec, shellCommand, compact,
    // review, realtime, queues, MCP, config writes, resume/fork and future methods.
    throw Error(`Native RPC is not admitted: ${message.method}`);
  }
  #input(input) {
    if (!Array.isArray(input) || input.length < 1 || input.length > 16)
      throw Error("Bounded native text input required");
    for (const part of input) {
      keys(part, ["type", "text", "text_elements"]);
      if (
        part.type !== "text" ||
        typeof part.text !== "string" ||
        part.text.length > 65536 ||
        (part.text_elements != null && (!Array.isArray(part.text_elements) || part.text_elements.length))
      )
        throw Error("Only plain native text input is admitted; path attachments are refused");
    }
  }
  #permissions(params, sandboxKey) {
    if (params.cwd != null && params.cwd !== this.cwd) throw Error("Native cwd override refused");
    if (
      params.runtimeWorkspaceRoots != null &&
      !isDeepStrictEqual(params.runtimeWorkspaceRoots, [this.cwd]) &&
      !isDeepStrictEqual(params.runtimeWorkspaceRoots, [])
    )
      throw Error("Native workspace root override refused");
    if (params.approvalPolicy != null && params.approvalPolicy !== "never")
      throw Error("Native approval override refused");
    if (params.approvalsReviewer != null && params.approvalsReviewer !== "user")
      throw Error("Native reviewer override refused");
    if (params.permissions != null && params.permissions !== "lead_eval")
      throw Error("Native permission override refused");
    if (params[sandboxKey] != null && !(sandboxKey === "sandbox" && params[sandboxKey] === "workspace-write"))
      throw Error("Native sandbox override refused");
    // Remote TUI projects a custom profile to legacy workspace-write at startup.
    // Replace that lossy projection with the controller's exact named profile.
    params.cwd = this.cwd;
    params.runtimeWorkspaceRoots = [this.cwd];
    params.approvalPolicy = "never";
    params.approvalsReviewer = "user";
    params.permissions = "lead_eval";
    params[sandboxKey] = null;
  }
}

/** Private controller pipe. Each decision binds one exact frame, nonce and allocation. */
export class NativeDecisionPipe {
  #pending = new Map();
  #buffer = "";
  #decoder = new StringDecoder("utf8");
  #failed;
  constructor({ readable, writable, allocationId, failed, timeoutMs = 2000 }) {
    this.writable = writable;
    this.allocationId = allocationId;
    this.failed = failed;
    this.timeoutMs = timeoutMs;
    readable.on("data", (chunk) => this.#data(chunk));
    for (const event of ["end", "close", "error"])
      readable.once(event, () => this.close(Error("Native controller pipe lost")));
    writable.once("error", () => this.close(Error("Native controller output lost")));
  }
  async decide(frame) {
    if (this.#failed) throw this.#failed;
    if (this.#pending.size >= 64) throw Error("Too many pending native decisions");
    const request = { allocationId: this.allocationId, nonce: randomUUID(), digest: digest(frame), frame };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(Error("Native controller decision expired")), this.timeoutMs);
      this.#pending.set(request.nonce, { request, resolve, reject, timer });
      this.writable.write(`${JSON.stringify(request)}\n`);
    });
  }
  #data(chunk) {
    this.#buffer += this.#decoder.write(chunk);
    if (Buffer.byteLength(this.#buffer) > MAX_FRAME)
      return this.close(Error("Oversized native controller frame"));
    let end;
    while ((end = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 1);
      try {
        const response = JSON.parse(line);
        keys(response, ["allocationId", "nonce", "digest", "allow"]);
        const pending = this.#pending.get(response.nonce);
        if (
          !pending ||
          response.allocationId !== this.allocationId ||
          response.digest !== pending.request.digest ||
          response.allow !== true
        )
          throw Error("Invalid, denied or replayed native controller decision");
        this.#pending.delete(response.nonce);
        clearTimeout(pending.timer);
        pending.resolve();
      } catch (error) {
        this.close(error);
        return;
      }
    }
  }
  close(error) {
    if (this.#failed) return;
    this.#failed = error;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    // Failure is retained; callers await settled() before completing boundary teardown.
    this.stopping = Promise.resolve()
      .then(() => this.failed(error))
      .catch((stopError) => {
        this.stopError = stopError;
      });
  }
  async settled() {
    await this.stopping;
    if (this.stopError) throw this.stopError;
  }
}

/** Real WS framing supplied by the pinned installed ws library when bundled. */
export async function serveNativeProxy({ WebSocketServer, connect, socketPath, policy, decisions, failed }) {
  const parent = dirname(socketPath),
    stat = lstatSync(parent);
  if (
    realpathSync(parent) !== parent ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o077
  )
    throw Error("Private controller proxy directory required");
  const server = createServer();
  const sockets = new Set();
  const ws = new WebSocketServer({ server, maxPayload: MAX_FRAME });
  let stopping;
  const stop = (error) => {
    stopping ??= Promise.resolve().then(async () => {
      for (const socket of sockets) socket.terminate();
      server.close();
      ws.close();
      await failed(error);
    });
    // Retain rejection for close() without an unhandled rejection from event callbacks.
    void stopping.catch(() => {});
    return stopping;
  };
  let accepted = false;
  ws.on("connection", async (client) => {
    if (accepted) {
      client.terminate();
      void stop(Error("Duplicate native TUI connection")).catch(() => {});
      return;
    }
    accepted = true;
    sockets.add(client);
    let upstream;
    let queue = Promise.resolve();
    let initialized = false;
    const pending = new Map();
    const enqueue = (action) => {
      queue = queue.then(action).catch(stop);
      void queue.catch(() => {});
    };
    client.on("close", () => {
      void stop(Error("Native TUI connection lost")).catch(() => {});
    });
    client.on("error", () => {
      void stop(Error("Native TUI transport error")).catch(() => {});
    });
    // Register before opening upstream so a fast genuine initialize cannot be dropped.
    const ready = Promise.resolve()
      .then(connect)
      .then((socket) => {
        upstream = socket;
        sockets.add(socket);
        socket.on("close", () => {
          void stop(Error("Native upstream audit connection lost")).catch(() => {});
        });
        socket.on("error", () => {
          void stop(Error("Native upstream transport error")).catch(() => {});
        });
        socket.on("message", (bytes, binary) =>
          enqueue(async () => {
            if (binary) throw Error("Binary native protocol frame refused");
            const message = JSON.parse(bytes.toString());
            if (!object(message)) throw Error("Native batch response refused");
            if (message.method && message.id !== undefined)
              throw Error("Unexpected native server approval/request");
            if (message.id !== undefined) {
              if (!pending.has(message.id)) throw Error("Uncorrelated native server response");
              pending.delete(message.id);
            }
            await decisions.decide({ direction: "server", message });
            if (stopping) throw Error("Native proxy stopped");
            client.send(JSON.stringify(message));
          }),
        );
      });
    client.on("message", (bytes, binary) =>
      enqueue(async () => {
        if (binary || bytes.length > MAX_FRAME) throw Error("Invalid native protocol frame");
        const prepared = policy.prepare(JSON.parse(bytes.toString()));
        if (!initialized && prepared.kind !== "initialize") throw Error("Native initialize required");
        if (prepared.kind === "initialize") {
          if (initialized) throw Error("Duplicate native initialize");
          initialized = true;
        }
        const { message } = prepared;
        if (message.id !== undefined) {
          if (pending.has(message.id)) throw Error("Duplicate native request ID");
          pending.set(message.id, message.method);
        }
        await ready;
        await decisions.decide({ direction: "client", kind: prepared.kind, message });
        if (stopping) throw Error("Native proxy stopped");
        upstream.send(JSON.stringify(message));
      }),
    );
    try {
      await ready;
    } catch (error) {
      void stop(error).catch(() => {});
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
  return { close: () => stop(Error("Native proxy closed")), socketPath };
}

/** Host half of the private pipe, owning approval and all failure handling. */
export class NativeProxyController {
  #buffer = "";
  #decoder = new StringDecoder("utf8");
  #seen = new Set();
  #closed = false;
  #queue = Promise.resolve();
  #readyResolve;
  #readyReject;
  #timer;
  constructor({ child, allocationId, socketPath, handle, failed, readyTimeoutMs = 5000 }) {
    this.child = child;
    this.ready = new Promise((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    // The caller awaits ready; event-loop failures before that await stay handled.
    void this.ready.catch(() => {});
    this.failed = failed;
    this.#timer = setTimeout(() => this.close(Error("Native proxy startup expired")), readyTimeoutMs);
    child.stdout.on("data", (bytes) => {
      this.#buffer += this.#decoder.write(bytes);
      if (Buffer.byteLength(this.#buffer) > MAX_FRAME) {
        this.close(Error("Oversized proxy control frame"));
        return;
      }
      let end;
      while ((end = this.#buffer.indexOf("\n")) >= 0) {
        const line = this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end + 1);
        this.#queue = this.#queue
          .then(async () => {
            if (this.#closed) return;
            const request = JSON.parse(line);
            if (request.ready === true) {
              keys(request, ["ready", "allocationId", "socketPath"]);
              if (
                !this.#readyResolve ||
                request.allocationId !== allocationId ||
                request.socketPath !== socketPath
              )
                throw Error("Unbound/replayed native proxy readiness");
              clearTimeout(this.#timer);
              this.#readyResolve();
              this.#readyResolve = undefined;
              return;
            }
            keys(request, ["allocationId", "nonce", "digest", "frame"]);
            if (
              this.#readyResolve ||
              request.allocationId !== allocationId ||
              typeof request.nonce !== "string" ||
              this.#seen.has(request.nonce) ||
              request.digest !== digest(request.frame)
            )
              throw Error("Unbound/replayed native proxy request");
            // One run is finite. Refuse rather than discard replay history.
            if (this.#seen.size >= 100_000) throw Error("Native control replay ledger full");
            this.#seen.add(request.nonce);
            await handle(structuredClone(request.frame));
            if (this.#closed) return;
            child.stdin.write(
              JSON.stringify({ allocationId, nonce: request.nonce, digest: request.digest, allow: true }) +
                "\n",
            );
          })
          .catch((error) => this.close(error));
      }
    });
    for (const event of ["exit", "error"])
      child.once(event, () => this.close(Error("Native proxy process lost")));
    for (const event of ["end", "error", "close"])
      child.stdout.once(event, () => this.close(Error("Native proxy audit pipe lost")));
    child.stdin.once("error", () => this.close(Error("Native proxy control pipe lost")));
  }
  close(error) {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#readyReject(error);
    this.stopping = Promise.resolve()
      .then(() => this.failed(error))
      .catch((stopError) => {
        this.stopError = stopError;
      });
  }
  async settled() {
    await this.stopping;
    if (this.stopError) throw this.stopError;
  }
}
