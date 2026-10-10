import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bundledSkills } from "@clankie/settings";
import { resolveOperatorCredential } from "@clankie/credential-broker";
import { readHerdrSeatTranscript, SeatTranscriptUploadSchema } from "@clankie/agent-transcript";
import {
  connectPrimeDaemon,
  discoverPrimeAgent,
  primeSessionState,
  PrimeSessionSummary,
  type PrimeDaemonConnection,
} from "../../../clankie/src/captain/prime-daemon.ts";
import { DeliveryFence, deliveryFingerprint } from "../../../clankie/src/captain/delivery-fence.ts";
import { clankieStateHome } from "../state-home.ts";
import { commandHost, outputJson } from "./io.ts";
import { fetchLaneText } from "./prompt.ts";
import { connectLaneUpstream, pumpSeatEvents } from "./mcp.ts";
import { resolveSeatContext } from "./seat-context.ts";
import type { SeatCommandOptions, SeatPlan } from "./seat.ts";

/**
 * `clankie prime` — Clankie's operator seat in Prime Agent (VUH-1557). The
 * session is a resident daemon session created with his context; the owner's
 * terminal runs `prime-agent attach` on it, and wakes reach it through the
 * daemon's `prompt`. Closing the TUI detaches; the session stays resident.
 */

interface Flags {
  resume: boolean;
  dryRun: boolean;
  conversationId?: string;
  newConversation?: boolean;
  pluginDir?: string;
  model?: string;
}
interface Record {
  activeSessionId: string;
  sessionId: string;
  sessionFile: string;
  cwd: string;
  conversationId?: string;
  socketPath: string;
  attached: boolean;
}
const recordPath = (env: NodeJS.ProcessEnv) => join(clankieStateHome(env), "clankie", "prime-seat.json");
/** Fixed so a resumed launch can replace its own servers on a session it configured earlier. */
const MCP_OWNER = "clankie-operator-seat";

export async function planPrimeSeat(
  flags: Flags,
  options: SeatCommandOptions,
): Promise<SeatPlan & { version: string; socketPath: string; model?: string }> {
  if (flags.pluginDir) throw new Error("Prime Agent seat does not accept Claude/OpenCode plugin directories");
  const env = options.env ?? process.env;
  const install = await discoverPrimeAgent(env);
  let previous: Record | undefined;
  if (flags.resume) {
    try {
      previous = JSON.parse(await readFile(recordPath(env), "utf8")) as Record;
    } catch {
      throw new Error("No exact Prime Agent operator session to resume");
    }
    if (previous.attached)
      throw new Error(
        `Previous Prime Agent seat exit is unconfirmed; check its terminal (prime-agent attach ${previous.activeSessionId}) before resuming`,
      );
    if (previous.socketPath !== install.socketPath)
      throw new Error("Prime Agent daemon socket changed since that session; no fallback");
    if (flags.conversationId && flags.conversationId !== previous.conversationId)
      throw new Error("Prime Agent resume cannot change its conversation");
    if (flags.model) throw new Error("A resumed Prime Agent session keeps its model; switch it in the TUI");
  }
  if (flags.model !== undefined && !/^[^/\s]+\/\S+$/u.test(flags.model))
    throw new Error("--model takes provider/model, e.g. anthropic/claude-haiku-4-5");
  const context = await resolveSeatContext(
    {
      conversationId: previous?.conversationId ?? flags.conversationId,
      fresh: previous !== undefined || flags.newConversation === true,
      cwd: previous?.cwd ?? process.cwd(),
      command: "prime",
      dryRun: true,
    },
    options,
  );
  return {
    command: install.launcher,
    version: install.version,
    socketPath: install.socketPath,
    cwd: context.cwd,
    args: ["attach", previous?.activeSessionId ?? "<created at launch>"],
    plugin: { source: "skill-paths", path: join(options.repoRoot, ".agents", "skills") },
    skills: bundledSkills(options.repoRoot),
    channel: true,
    sessionId: previous?.sessionId ?? "assigned by Prime Agent at launch",
    resumed: !!previous,
    ...(flags.model ? { model: flags.model } : {}),
    ...(context.conversationId ? { conversationId: context.conversationId } : {}),
    ...(context.newConversation ? { newConversation: context.newConversation } : {}),
  };
}

/** The recorded session if the daemon still hosts it, else its saved file reopened; never another session. */
async function openSession(
  daemon: PrimeDaemonConnection,
  previous: Record | undefined,
  create: Readonly<{ [key: string]: unknown }>,
): Promise<PrimeSessionSummary> {
  if (previous) {
    const live = await primeSessionState(daemon, previous.activeSessionId).catch(() => undefined);
    if (live) {
      if (live.sessionId !== previous.sessionId)
        throw new Error("Recorded Prime Agent session now hosts another conversation; nothing attached");
      return live;
    }
  }
  const created = PrimeSessionSummary.parse(
    await daemon.request(
      { type: "create", ...create, ...(previous ? { sessionPath: previous.sessionFile } : {}) },
      120_000,
    ),
  );
  if (previous && created.sessionId !== previous.sessionId)
    throw new Error(
      `Prime Agent reopened ${created.sessionId}, not ${previous.sessionId}; inspect it before resuming`,
    );
  return created;
}

export async function runPrimeSeat(flags: Flags, options: SeatCommandOptions): Promise<number> {
  const env = options.env ?? process.env;
  const stderr = options.stderr ?? process.stderr;
  let plan = await planPrimeSeat(flags, options);
  if (flags.dryRun) {
    outputJson(options.stdout ?? process.stdout, {
      ok: true,
      ...plan,
      delivery:
        "A resident Prime Agent daemon session: context via create appendSystemPrompt and skills, operator tools via replace_acp_mcp_servers, wakes via daemon prompt (followUp; owner turns and escalations steer). The terminal runs prime-agent attach on that exact session; no terminal input.",
      ownerSteps: [
        "Sign in to a model provider in Prime Agent first.",
        "Prime Agent asks no tool approvals by default; its own settings govern what runs.",
      ],
    });
    return 0;
  }
  if (options.spawnImpl)
    throw new Error("Prime Agent operator requires a directly observed native TUI process");
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
  });
  if (!credential) throw new Error("Prime Agent operator needs Clankie's operator credential in the broker");
  const install = await discoverPrimeAgent(env);
  const previous = plan.resumed ? (JSON.parse(await readFile(recordPath(env), "utf8")) as Record) : undefined;
  if (plan.newConversation) {
    const context = await resolveSeatContext(
      { cwd: plan.cwd, command: "prime", fresh: true, dryRun: false },
      options,
    );
    plan = { ...plan, ...context };
  }
  const query = { lane: "operator", ...(plan.conversationId ? { conversationId: plan.conversationId } : {}) };
  const prompt = await fetchLaneText("/v1/captain/prompt", query, options);
  const memory = await fetchLaneText("/v1/captain/memory-card", query, options);
  if (!prompt.trim()) throw new Error("Prime Agent operator context unavailable; nothing launched");

  const daemon = await connectPrimeDaemon(install);
  const stop = new AbortController();
  let upstream: Awaited<ReturnType<typeof connectLaneUpstream>> | undefined;
  let pump: Promise<void> | undefined;
  let transcriptPump: Promise<void> | undefined;
  let record: Record | undefined;
  const persist = async () => {
    await mkdir(join(recordPath(env), ".."), { recursive: true, mode: 0o700 });
    await writeFile(recordPath(env), JSON.stringify(record), { mode: 0o600 });
  };
  try {
    const model = plan.model?.split("/");
    const session = await openSession(daemon, previous, {
      name: "Clankie",
      config: {
        cwd: plan.cwd,
        appendSystemPrompt: [`${prompt}\n\n${memory}`],
        skills: plan.skills.map((skill) => skill.path),
        ...(model ? { provider: model[0], model: model.slice(1).join("/") } : {}),
      },
      // Prime's own Herdr reporter binds this pane to the session.
      env: Object.fromEntries(
        Object.entries(env).filter(
          (entry): entry is [string, string] => entry[0].startsWith("HERDR_") && !!entry[1],
        ),
      ),
    });
    const id = session.activeSessionId;
    const sessionFile = session.sessionFile;
    if (!sessionFile) throw new Error("Prime Agent did not report the session file; nothing attached");
    record = {
      activeSessionId: id,
      sessionId: session.sessionId,
      sessionFile,
      cwd: plan.cwd,
      ...(plan.conversationId ? { conversationId: plan.conversationId } : {}),
      socketPath: install.socketPath,
      attached: true,
    };
    await persist();
    /** Every daemon delivery re-proves the session it is aimed at. */
    const verify = async () => {
      const state = await primeSessionState(daemon, id);
      if (state.sessionId !== session.sessionId)
        throw new Error("Prime Agent session changed; no retargeting");
      return state;
    };
    // Prime's own worker shape (`AcpMcpServerConfig`), not the ACP wire shape: the
    // worker silently drops a list it cannot parse.
    await daemon.request({
      type: "replace_acp_mcp_servers",
      activeSessionId: id,
      ownerId: MCP_OWNER,
      servers: [
        {
          type: "stdio",
          name: "clankie",
          cwd: plan.cwd,
          command: process.execPath,
          args: [
            join(options.repoRoot, "apps", "tui", "bin", "clankie.ts"),
            "mcp",
            "--lane",
            "operator",
            ...(plan.conversationId ? ["--conversation", plan.conversationId] : []),
          ],
          // The bridge's parent is Prime's Python kernel, which also runs model code, so
          // the bearer is handed over explicitly (as the Grok seat does). Prime keeps
          // this list in worker memory only.
          env: {
            CLANKIE_CONTROL_PLANE_URL: commandHost(options),
            CLANKIE_OPERATOR_TOKEN: credential.token,
          },
        },
      ],
    });
    const state = join(clankieStateHome(env), "clankie", "prime-seat-receipts", session.sessionId);
    await mkdir(state, { recursive: true, mode: 0o700 });
    const fence = new DeliveryFence(join(state, "events.json"));
    if (fence.entries().length)
      throw new Error(
        `Uncertain Prime Agent operator event retained in ${state}; inspect the session before attaching again`,
      );
    // The TUI owns the terminal; diagnostics go beside the receipts instead of over it.
    const log = (line: string) =>
      void appendFile(join(state, "seat.log"), `${new Date().toISOString()} ${line}\n`).catch(() => {});
    const child = spawn(install.launcher, ["attach", id], {
      cwd: plan.cwd,
      env: { ...env, ...install.env },
      stdio: "inherit",
    });
    const exited = new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => {
        stop.abort();
        resolve(code ?? 1);
      });
    });
    void exited.catch(() => {});
    upstream = await connectLaneUpstream({
      host: commandHost(options),
      bearer: credential.token,
      ...(plan.conversationId ? { conversationId: plan.conversationId } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    transcriptPump = (async () => {
      while (!stop.signal.aborted) {
        try {
          const live = await verify();
          const transcript = readHerdrSeatTranscript("pi", {
            source: "herdr:pi",
            kind: "path",
            value: sessionFile,
          });
          const entries =
            transcript?.entries
              .filter(
                (entry) => entry.type !== "viewed_image" && !(entry.type === "message" && entry.internal),
              )
              .map((entry) => {
                if (entry.type === "message") {
                  const { internal: _internal, ...display } = entry;
                  return display;
                }
                return entry;
              }) ?? [];
          for (let index = 0; index < entries.length; index += 100) {
            const upload = SeatTranscriptUploadSchema.parse({
              sessionId: session.sessionId,
              entries: entries.slice(index, index + 100),
              activity: live.activity === "idle" ? "waiting" : "responding",
            });
            const url = new URL("/v1/seat/transcript", commandHost(options));
            if (plan.conversationId) url.searchParams.set("conversationId", plan.conversationId);
            const response = await (options.fetchImpl ?? fetch)(url, {
              method: "POST",
              headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
              body: JSON.stringify(upload),
              signal: AbortSignal.any([stop.signal, AbortSignal.timeout(10_000)]),
            });
            await response.body?.cancel();
            if (response.status === 409) {
              stop.abort();
              throw new Error("Original conversation/session retired; no transcript retargeting");
            }
            if (!response.ok) throw new Error(`Prime Agent transcript upload refused (${response.status})`);
          }
        } catch (error) {
          if (!stop.signal.aborted) log(`transcript: ${String(error)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    })();
    pump = pumpSeatEvents(
      {
        notification: async (event) => {
          const params = event.params as { content: string; meta: { event_id: string; kind: string } };
          const eventId = params.meta.event_id;
          const completed = fence.completed(eventId);
          if (completed) {
            if (completed.sessionId !== session.sessionId)
              throw new Error("Prime Agent event belongs to its original session");
            return;
          }
          if (fence.pending(eventId)) throw new Error("Original Prime Agent event is uncertain; no replay");
          const live = await verify();
          // The owner and rooms speaking to him now steer a running turn; his own
          // wakes and watches wait for it to finish. An idle session runs either at once.
          const streamingBehavior = ["turn", "escalation"].includes(params.meta.kind) ? "steer" : "followUp";
          const receipt = fence.begin(eventId, {
            sessionId: session.sessionId,
            fingerprint: deliveryFingerprint(params.content),
          });
          // Any failure from here leaves the receipt pending: never resent.
          await daemon.request({
            type: "prompt",
            activeSessionId: id,
            message: `<clankie-seat-event>\n${JSON.stringify(params)}\n</clankie-seat-event>`,
            streamingBehavior,
          });
          fence.complete(eventId, receipt.messageId, {
            state:
              live.activity === "idle" ? "started" : streamingBehavior === "steer" ? "steered" : "queued",
            deliveryStage: "delivered",
          });
        },
      },
      upstream,
      stop.signal,
      { onError: (error) => log(`outbox: ${String(error)}`) },
    );
    void pump.catch((error) => log(`delivery stopped: ${String(error)}`));
    log(`attached ${session.sessionId} (${id})`);
    const code = await exited;
    record = { ...record, attached: false };
    await persist();
    stderr.write(
      `Detached; Prime Agent session ${id} stays resident. clankie prime --resume reattaches. Log: ${join(state, "seat.log")}\n`,
    );
    return code;
  } finally {
    stop.abort();
    await pump?.catch(() => {});
    await transcriptPump?.catch(() => {});
    await upstream?.close();
    daemon.close();
  }
}
