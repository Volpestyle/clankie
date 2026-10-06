import { OpenCodeReceiptFence } from "./opencode-receipts.ts";
import { openCodeDeliveryStage } from "@clankie/protocol";
import { execFile as execCallback, spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { bundledSkills } from "@clankie/settings";
import { resolveOperatorCredential } from "@clankie/credential-broker";
import { SeatTranscriptUploadSchema } from "@clankie/agent-transcript";
import { clankieStateHome } from "../state-home.ts";
import { commandHost, outputJson } from "./io.ts";
import { fetchLaneText } from "./prompt.ts";
import { connectLaneUpstream, pumpSeatEvents } from "./mcp.ts";
import type { SeatCommandOptions, SeatPlan } from "./seat.ts";
import { resolveSeatContext } from "./seat-context.ts";

const exec = promisify(execCallback);
const SESSION = /^ses_[A-Za-z0-9]{8,128}$/u;
type Flags = {
  resume: boolean;
  dryRun: boolean;
  conversationId?: string;
  newConversation?: boolean;
  pluginDir?: string;
};
type Binding = { sessionId: string; conversationId?: string; cwd: string };
type Event = { id: string; content: string; meta: unknown };
const recordPath = (env: NodeJS.ProcessEnv) => join(clankieStateHome(env), "clankie", "opencode-seat.json");

/** Read-only capability/launch API shared with the CLI. No owner config writes. */
export async function planOpenCodeSeat(
  flags: Flags,
  options: SeatCommandOptions,
): Promise<SeatPlan & { version: string; delivery: string }> {
  const env = options.env ?? process.env;
  const command = env.CLANKIE_OPENCODE_BIN ?? "opencode";
  const run = options.execFileImpl ?? ((cmd, args) => exec(cmd, [...args], { env, timeout: 15000 }));
  let version: string, help: string;
  try {
    version = (await run(command, ["--version"])).stdout.trim();
    const usage = await run(command, ["--help"]);
    help = usage.stdout + usage.stderr;
  } catch {
    throw new Error("OpenCode is unavailable; install OpenCode CLI or set CLANKIE_OPENCODE_BIN.");
  }
  if (
    !version.startsWith("1.18.") ||
    !["--session", "--hostname", "--port"].every((flag) => help.includes(flag))
  )
    throw new Error(
      `Unsupported OpenCode ${version}; clankie opencode requires the verified 1.18.x plugin/server contract.`,
    );
  const source = resolve(flags.pluginDir ?? join(options.repoRoot, "integrations/opencode-plugin"));
  if (!existsSync(join(source, "plugin.mjs")))
    throw new Error(`Clankie's OpenCode plugin is missing at ${source}`);
  let previous: Binding | undefined;
  if (flags.resume) {
    try {
      previous = JSON.parse(readFileSync(recordPath(env), "utf8")) as Binding;
    } catch {
      /* no prior seat */
    }
    if (!previous || !SESSION.test(previous.sessionId) || typeof previous.cwd !== "string")
      throw new Error(
        "No exact OpenCode chat to resume; run `clankie opencode` and create its native session first.",
      );
    if (
      flags.conversationId !== undefined &&
      flags.conversationId !== (previous.conversationId ?? "global-default")
    )
      throw new Error("Exact-session resume cannot change its conversation.");
  }
  const context = await resolveSeatContext(
    {
      conversationId:
        previous === undefined ? flags.conversationId : (previous.conversationId ?? "global-default"),
      fresh: flags.newConversation === true,
      cwd: previous?.cwd ?? process.cwd(),
      command: "opencode",
      dryRun: true,
    },
    options,
  );
  const { conversationId, cwd } = context;
  if (previous && cwd !== previous.cwd)
    throw new Error("Resume workspace changed; refusing to redirect native session");
  return {
    command,
    args: [
      cwd,
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
      ...(previous ? ["--session", previous.sessionId] : []),
    ],
    plugin: { source: "plugin-dir", path: source },
    skills: bundledSkills(options.repoRoot),
    channel: true,
    sessionId: previous?.sessionId ?? "pending-native-session",
    resumed: !!previous,
    cwd,
    ...(conversationId ? { conversationId } : {}),
    ...(context.newConversation ? { newConversation: context.newConversation } : {}),
    version,
    delivery: "Native session API; idle dispatch, busy waits, uncertain dispatch stops without retry.",
  };
}

export async function runOpenCodeSeat(flags: Flags, options: SeatCommandOptions): Promise<number> {
  let plan = await planOpenCodeSeat(flags, options);
  const stdout = options.stdout ?? process.stdout,
    stderr = options.stderr ?? process.stderr;
  if (flags.dryRun) {
    outputJson(stdout, {
      ok: true,
      ...plan,
      ownerSteps: [
        "Native permissions remain owner decisions.",
        "Native session creation or exact resume triggers read-only identity/context preflight; no bootstrap model turn.",
      ],
      configuration:
        "Per-launch plugin and autoupdate:false; inherited Linear MCP connections disabled in memory, broker-backed clankie MCP enabled. No config file edits.",
    });
    return 0;
  }
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
  });
  if (!credential) throw new Error("clankie opencode needs the operator credential in the broker");
  const host = commandHost({ ...options, env });
  const nativeFence = new OpenCodeReceiptFence(
    join(
      clankieStateHome(env),
      "clankie",
      "opencode-seat-receipts",
      `${createHash("sha256")
        .update(JSON.stringify([host, plan.conversationId ?? "global-default"]))
        .digest("hex")}.json`,
    ),
  );
  const unresolved = nativeFence.pending();
  if (unresolved !== undefined && (!plan.resumed || plan.sessionId !== unresolved.sessionId))
    throw new Error(
      "Uncertain native delivery requires the original exact resumed session for reconciliation; no new launcher was started",
    );
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
    plugin?: unknown[];
    skills?: { paths?: string[] };
    autoupdate?: boolean;
  };
  config.autoupdate = false;
  if (plan.newConversation !== undefined) {
    const context = await resolveSeatContext(
      { cwd: plan.cwd, command: "opencode", fresh: true, dryRun: false },
      options,
    );
    plan = { ...plan, ...context, args: [context.cwd, ...plan.args.slice(1)] };
  }
  const stop = new AbortController();
  const token = randomBytes(32).toString("hex");
  const directory = join(clankieStateHome(env), "clankie", "opencode-seat-launches", randomUUID());
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let sessionId = plan.resumed ? plan.sessionId : undefined;
  let contextLoaded = false;
  let ready = false,
    failure: string | undefined;
  let queue: Event[] = [];
  const warnings = new Set<string>();
  const receipts: Record<string, string> = {};
  let controlStatus = "waiting_for_context";
  let upstream: Awaited<ReturnType<typeof connectLaneUpstream>> | undefined;
  let delivery: Promise<void> | undefined;
  const persist = () => {
    const file = join(directory, "delivery.json");
    writeFileSync(
      `${file}.tmp`,
      JSON.stringify({
        sessionId,
        receipts,
        failure,
        controlStatus,
        deliveryStage: ["pending", "busy", "delivered", "uncertain", "unbound", "ready"].includes(
          controlStatus,
        )
          ? openCodeDeliveryStage(controlStatus as Parameters<typeof openCodeDeliveryStage>[0])
          : undefined,
        warnings: [...warnings],
        pending: queue,
      }),
      {
        mode: 0o600,
      },
    );
    renameSync(`${file}.tmp`, file);
  };
  let starting: Promise<void> | undefined;
  const begin = async () => {
    if (starting) return starting;
    if (upstream || failure) return;
    starting = (async () => {
      upstream = await connectLaneUpstream({
        host,
        bearer: credential.token,
        ...(plan.conversationId ? { conversationId: plan.conversationId } : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      delivery = pumpSeatEvents(
        {
          notification: async (event) => {
            if (failure) throw new Error(failure);
            const params = event.params as { content: string; meta: { event_id: string } };
            if (!receipts[params.meta.event_id] && !queue.some((item) => item.id === params.meta.event_id)) {
              queue.push({ id: params.meta.event_id, content: params.content, meta: params.meta });
              persist();
            }
          },
        },
        upstream,
        stop.signal,
        {
          onError: (error) => {
            warnings.add(`outbox: ${String(error)}`);
            persist();
          },
        },
      ).catch((error) => {
        failure = String(error);
        persist();
      });
    })();
    return starting;
  };
  const server = createServer(async (request, response) => {
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (
      request.method !== "POST" ||
      request.headers.authorization !== `Bearer ${token}` ||
      request.headers.origin
    ) {
      reply(403, { error: "forbidden" });
      return;
    }
    try {
      let raw = "";
      for await (const chunk of request) {
        raw += String(chunk);
        if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error("Payload too large");
      }
      const body = JSON.parse(raw) as {
        sessionId?: string;
        eventId?: string;
        status?: string;
        detail?: string;
      };
      if (!body.sessionId || !SESSION.test(body.sessionId)) throw new Error("Invalid native session");
      if (sessionId && sessionId !== body.sessionId) throw new Error("Native session mismatch");
      const action = request.url;
      if (action === "/bind") {
        if (failure) throw new Error(failure);
        const pending = nativeFence.pending();
        if (pending !== undefined && pending.sessionId !== body.sessionId)
          throw new Error("Uncertain receipt belongs to another native session");
        sessionId = body.sessionId;
        writeFileSync(
          recordPath(env),
          JSON.stringify({
            sessionId,
            cwd: plan.cwd,
            ...(plan.conversationId ? { conversationId: plan.conversationId } : {}),
          }),
          { mode: 0o600 },
        );
        // The original in-flight turn needs fresh context before its own message
        // appears in history. Only inherited claims require bootstrap reconciliation.
        reply(200, {
          ok: true,
          uncertain:
            pending !== undefined && receipts[pending.event.id] !== "uncertain" ? pending : undefined,
        });
        return;
      } else {
        if (!sessionId) throw new Error("Native session not bound");
        if (action === "/failure") {
          failure = body.detail ?? "native_control_failed";
          ready = false;
          persist();
        } else if (action === "/reconcile") {
          const pending = nativeFence.pending();
          if (
            !pending ||
            pending.sessionId !== sessionId ||
            pending.event.id !== body.eventId ||
            body.detail !== `<clankie-seat-event>\n${JSON.stringify(pending.event)}\n</clankie-seat-event>`
          )
            throw new Error("Native receipt does not match the original session and complete event");
          nativeFence.acknowledge(sessionId, pending.event.id);
          reply(200, { ok: true, deliveryStage: "consumed" });
          return;
        } else if (failure) throw new Error(failure);
        else if (action === "/context") {
          contextLoaded = false;
          const query = {
            lane: "operator",
            ...(plan.conversationId ? { conversationId: plan.conversationId } : {}),
          };
          const text = await fetchLaneText("/v1/captain/prompt", query, options);
          const memory = await fetchLaneText("/v1/captain/memory-card", query, options);
          if (!text.trim()) throw new Error("Operator context unavailable");
          contextLoaded = true;
          reply(200, { text: `${text}\n\n${memory}` });
          return;
        } else if (action === "/ready") {
          if (nativeFence.pending())
            throw new Error("Uncertain native delivery must be reconciled before any new dispatch");
          if (!contextLoaded) throw new Error("Native context preflight required");
          await begin();
          ready = true;
        } else if (action === "/poll") {
          reply(200, {
            event: ready && contextLoaded ? queue[0] : undefined,
            ...(ready && contextLoaded && queue[0] ? { deliveryStage: "stored" } : {}),
          });
          return;
        } else if (action === "/claim") {
          if (
            !ready ||
            !contextLoaded ||
            !body.eventId ||
            queue[0]?.id !== body.eventId ||
            receipts[body.eventId]
          )
            throw new Error("Duplicate or unbound dispatch");
          nativeFence.claim({ sessionId, event: queue[0]! });
          receipts[body.eventId] = "uncertain";
          queue = queue.slice(1);
          persist();
        } else if (action === "/receipt") {
          if (
            !body.eventId ||
            receipts[body.eventId] !== "uncertain" ||
            !["delivered", "uncertain"].includes(body.status ?? "")
          )
            throw new Error("Invalid dispatch receipt");
          if (body.status === "delivered" && !nativeFence.acknowledge(sessionId, body.eventId))
            throw new Error("Missing original native receipt");
          receipts[body.eventId] = body.status!;
          persist();
          controlStatus = body.status!;
          persist();
        } else if (action === "/warning") {
          const detail = body.detail ?? "transcript_failed";
          if (!warnings.has(detail)) {
            warnings.add(detail);
            persist();
          }
        } else if (action === "/status") {
          if (controlStatus !== body.status) {
            controlStatus = body.status ?? "unknown";
            persist();
          }
        } else if (action === "/transcript") {
          const upload = SeatTranscriptUploadSchema.parse(body);
          const url = new URL("/v1/seat/transcript", host);
          if (plan.conversationId) url.searchParams.set("conversationId", plan.conversationId);
          const result = await (options.fetchImpl ?? fetch)(url, {
            method: "POST",
            headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
            body: JSON.stringify(upload),
            signal: AbortSignal.timeout(10000),
          });
          await result.body?.cancel();
          if (!result.ok) throw new Error(`Transcript upload refused (${result.status})`);
        } else throw new Error("Unknown bridge action");
      }
      reply(200, {
        ok: true,
        ...(action === "/receipt"
          ? { deliveryStage: openCodeDeliveryStage(body.status as "delivered" | "uncertain") }
          : {}),
      });
    } catch (error) {
      reply(409, { error: String(error) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Bridge failed to bind");
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) if (/^(?:SWARM_|CLANKIE_SWARM_)/u.test(key)) delete childEnv[key];
  delete childEnv.CLANKIE_OPERATOR_TOKEN;
  delete childEnv.CLANKIE_CODEX_SEAT_BINDING;
  delete childEnv.CLANKIE_SEAT_SESSION_ID;
  delete childEnv.CLANKIE_CONVERSATION_ID;
  if (plan.conversationId) childEnv.CLANKIE_CONVERSATION_ID = plan.conversationId;
  childEnv.CLANKIE_CONTROL_PLANE_URL = host;
  childEnv.CLANKIE_SEAT_HARNESS = "opencode";
  childEnv.CLANKIE_OPENCODE_BRIDGE = `http://127.0.0.1:${address.port}`;
  childEnv.CLANKIE_OPENCODE_BRIDGE_TOKEN = token;
  if (plan.resumed) childEnv.CLANKIE_OPENCODE_SESSION = plan.sessionId;
  else delete childEnv.CLANKIE_OPENCODE_SESSION;
  // Merge the owner's inline config as OpenCode merges its other configuration.
  config.plugin = [...(config.plugin ?? []), pathToFileURL(join(plan.plugin.path, "plugin.mjs")).href];
  config.skills = {
    ...config.skills,
    paths: [...(config.skills?.paths ?? []), ...plan.skills.map((skill) => skill.path)],
  };
  childEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  stderr.write(`clankie opencode: waiting for native context; ${plan.delivery} Receipts: ${directory}\n`);
  try {
    const launch =
      options.spawnImpl ??
      ((command, args, cwd, env) =>
        new Promise<number>((resolve, reject) => {
          const child = spawn(command, [...args], { cwd, env, stdio: "inherit" });
          child.once("error", reject);
          child.once("exit", (code) => resolve(code ?? 1));
        }));
    return await launch(plan.command, plan.args, plan.cwd, childEnv);
  } finally {
    stop.abort();
    ready = false;
    failure ??= "disconnected: native TUI exited; resume requires a fresh plugin binding";
    persist();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await starting?.catch(() => undefined);
    await delivery;
    await upstream?.close();
    stderr.write(
      `clankie opencode closed: ${failure}. Receipts and ${warnings.size} warning(s): ${directory}\n`,
    );
  }
}
