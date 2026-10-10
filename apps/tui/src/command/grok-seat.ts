import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { globSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bundledSkills } from "@clankie/settings";
import { resolveOperatorCredential } from "@clankie/credential-broker";
import { readHerdrSeatTranscript, SeatTranscriptUploadSchema } from "@clankie/agent-transcript";
import {
  discoverGrok,
  grokTuiOwnsSession,
  waitForGrokTuiSession,
} from "../../../clankie/src/captain/grok-seat-adapter.ts";
import {
  connectGrokNative,
  GROK_NATIVE_VERSION,
  GrokSessionId,
  type GrokNativeController,
} from "../../../clankie/src/captain/grok-native-controller.ts";
import { DeliveryFence, deliveryFingerprint } from "../../../clankie/src/captain/delivery-fence.ts";
import { clankieStateHome } from "../state-home.ts";
import { commandHost, outputJson } from "./io.ts";
import { fetchLaneText } from "./prompt.ts";
import { connectLaneUpstream, pumpSeatEvents } from "./mcp.ts";
import { resolveSeatContext } from "./seat-context.ts";
import { MAXIMUM_TRUST_HARNESS_ARGS } from "@clankie/protocol/owner-settings";
import { readSeatMaximumTrust, type SeatCommandOptions, type SeatPlan } from "./seat.ts";

interface Flags {
  resume: boolean;
  dryRun: boolean;
  conversationId?: string;
  newConversation?: boolean;
  pluginDir?: string;
}
interface Record {
  sessionId: string;
  cwd: string;
  conversationId?: string;
  grokHome: string;
  active: boolean;
}
const recordPath = (env: NodeJS.ProcessEnv) => join(clankieStateHome(env), "clankie", "grok-seat.json");
export async function planGrokSeat(
  flags: Flags,
  options: SeatCommandOptions,
): Promise<SeatPlan & { version: string; grokHome: string }> {
  if (flags.pluginDir) throw new Error("Grok seat does not accept Claude/OpenCode plugin directories");
  const env = options.env ?? process.env;
  const command = await discoverGrok(env);
  const grokHome = await realpath(env.GROK_HOME ?? join(env.HOME ?? process.env.HOME!, ".grok"));
  let previous: Record | undefined;
  if (flags.resume) {
    try {
      previous = JSON.parse(await readFile(recordPath(env), "utf8")) as Record;
    } catch {
      throw new Error("No exact Grok operator session to resume");
    }
    GrokSessionId.parse(previous.sessionId);
    if (previous.active)
      throw new Error("Previous Grok exit is unconfirmed; inspect its original TUI before resuming");
    if (previous.grokHome !== grokHome)
      throw new Error("Grok resume account/profile home changed; no fallback");
    if (flags.conversationId && flags.conversationId !== previous.conversationId)
      throw new Error("Grok resume cannot change its conversation");
  }
  const context = await resolveSeatContext(
    {
      conversationId: previous?.conversationId ?? flags.conversationId,
      fresh: previous !== undefined || flags.newConversation === true,
      cwd: previous?.cwd ?? process.cwd(),
      command: "grok",
      dryRun: true,
    },
    options,
  );
  const sessionId = previous?.sessionId ?? randomUUID();
  const trust = await readSeatMaximumTrust(options);
  return {
    command,
    version: GROK_NATIVE_VERSION,
    grokHome,
    cwd: context.cwd,
    args: [
      "--leader",
      "--cwd",
      context.cwd,
      ...(previous ? ["--resume", sessionId] : ["--session-id", sessionId]),
      ...(trust.enabled ? MAXIMUM_TRUST_HARNESS_ARGS.grok : []),
    ],
    maximumTrustMode: trust.enabled,
    ...(trust.unreadable === undefined ? {} : { maximumTrustModeUnreadable: trust.unreadable }),
    plugin: { source: "skill-paths", path: join(options.repoRoot, ".agents", "skills") },
    skills: bundledSkills(options.repoRoot),
    channel: true,
    sessionId,
    resumed: !!previous,
    ...(context.conversationId ? { conversationId: context.conversationId } : {}),
    ...(context.newConversation ? { newConversation: context.newConversation } : {}),
  };
}
export async function runGrokSeat(flags: Flags, options: SeatCommandOptions): Promise<number> {
  const env = options.env ?? process.env;
  let plan = await planGrokSeat(flags, options);
  const stderr = options.stderr ?? process.stderr;
  if (flags.dryRun) {
    outputJson(options.stdout ?? process.stdout, {
      ok: true,
      ...plan,
      delivery:
        "Private native leader IPC + ACP attached to the visible TUI's exact session. No terminal input, and never a worker without its visible TUI.",
      ownerSteps: ["Native permissions and sign-in remain owner decisions."],
    });
    return 0;
  }
  if (options.spawnImpl) throw new Error("Grok operator requires a directly observed native TUI process");
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
  });
  if (!credential) throw new Error("Grok operator needs Clankie's operator credential in the broker");
  if (plan.newConversation) {
    const context = await resolveSeatContext(
      { cwd: plan.cwd, command: "grok", fresh: true, dryRun: false },
      options,
    );
    plan = {
      ...plan,
      ...context,
      args: [
        "--leader",
        "--cwd",
        context.cwd,
        "--session-id",
        plan.sessionId,
        ...(plan.maximumTrustMode ? MAXIMUM_TRUST_HARNESS_ARGS.grok : []),
      ],
    };
  }
  const query = { lane: "operator", ...(plan.conversationId ? { conversationId: plan.conversationId } : {}) };
  const prompt = await fetchLaneText("/v1/captain/prompt", query, options);
  const memory = await fetchLaneText("/v1/captain/memory-card", query, options);
  if (!prompt.trim()) throw new Error("Grok operator context unavailable; nothing launched");
  const directory = await realpath(await mkdtemp(join(tmpdir(), "clankie-grok-seat-")));
  const socketPath = join(directory, "leader.sock");
  const state = join(clankieStateHome(env), "clankie", "grok-seat-receipts", plan.sessionId!);
  await mkdir(state, { recursive: true, mode: 0o700 });
  const fence = new DeliveryFence(join(state, "events.json"));
  if (fence.entries().length)
    throw new Error(
      "Uncertain Grok operator event retained; inspect the original session and receipt before launching another TUI",
    );
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    CLANKIE_SEAT_HARNESS: "grok",
    CLANKIE_CONTROL_PLANE_URL: commandHost(options),
    ...(plan.conversationId ? { CLANKIE_CONVERSATION_ID: plan.conversationId } : {}),
  };
  delete childEnv.CLANKIE_SEAT_PARENT_ARGV;
  const context = `${prompt}\n\n${memory}\n\nAvailable Clankie skills (read the relevant SKILL.md before using it):\n${plan.skills
    .map((skill) => `${skill.name}: ${join(skill.path, "SKILL.md")}`)
    .join("\n")}`;
  let child: ChildProcess | undefined, native: GrokNativeController | undefined;
  const stop = new AbortController();
  let upstream: Awaited<ReturnType<typeof connectLaneUpstream>> | undefined;
  let pump: Promise<void> | undefined;
  let transcriptPump: Promise<void> | undefined;
  let active = true;
  const persist = async () => {
    await mkdir(join(recordPath(env), ".."), { recursive: true, mode: 0o700 });
    await writeFile(
      recordPath(env),
      JSON.stringify({
        sessionId: plan.sessionId,
        cwd: plan.cwd,
        ...(plan.conversationId ? { conversationId: plan.conversationId } : {}),
        grokHome: plan.grokHome,
        active,
      } satisfies Record),
      { mode: 0o600 },
    );
  };
  try {
    await persist();
    child = spawn(
      plan.command,
      [...plan.args, "--leader-socket", socketPath, "--system-prompt-override", context],
      { cwd: plan.cwd, env: childEnv, stdio: "inherit" },
    );
    const exited = new Promise<number>((resolve, reject) => {
      child!.once("error", reject);
      child!.once("exit", (code) => {
        active = false;
        stop.abort();
        resolve(code ?? 1);
      });
    });
    void exited.catch(() => {});
    await waitForGrokTuiSession({
      home: plan.grokHome,
      pid: child.pid!,
      sessionId: plan.sessionId!,
      cwd: await realpath(plan.cwd),
      guard: async () => {
        if (!active || child!.exitCode !== null) throw new Error("Original Grok TUI exited");
      },
    });
    native = await connectGrokNative({
      socketPath,
      executable: plan.command,
      cwd: await realpath(plan.cwd),
      sessionId: plan.sessionId,
      processHelper: join(options.repoRoot, "integrations/opencode-plugin/process-birth.py"),
      receiptsPath: join(state, "native.json"),
      guard: async () => {
        if (!active || !child?.pid || child.exitCode !== null)
          throw new Error("Original Grok operator TUI exited");
        if (
          !(await grokTuiOwnsSession({
            home: plan.grokHome,
            pid: child.pid,
            sessionId: plan.sessionId!,
            cwd: await realpath(plan.cwd),
          }))
        )
          throw new Error("Original Grok visible session changed");
      },
    });
    await native.load({
      systemPrompt: context,
      mcpServers: [
        {
          name: "clankie",
          command: "clankie",
          args: ["mcp", "--lane", "operator"],
          env: [
            { name: "CLANKIE_CONTROL_PLANE_URL", value: commandHost(options) },
            { name: "CLANKIE_OPERATOR_TOKEN", value: credential.token },
            ...(plan.conversationId ? [{ name: "CLANKIE_CONVERSATION_ID", value: plan.conversationId }] : []),
          ],
        },
      ],
    });
    await native.waitTools("clankie", ["hire_agent", "reply"]);
    upstream = await connectLaneUpstream({
      host: commandHost(options),
      bearer: credential.token,
      ...(plan.conversationId ? { conversationId: plan.conversationId } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    const controller = native;
    transcriptPump = (async () => {
      while (!stop.signal.aborted) {
        try {
          await controller.verify();
          const path = globSync(
            join(plan.grokHome, "sessions", "*", plan.sessionId!, "chat_history.jsonl"),
          )[0];
          const transcript = path
            ? readHerdrSeatTranscript("grok", { source: "herdr:grok", kind: "path", value: path })
            : undefined;
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
              sessionId: plan.sessionId,
              entries: entries.slice(index, index + 100),
              activity: controller.status() === "working" ? "responding" : "waiting",
            });
            const url = new URL("/v1/seat/transcript", commandHost(options));
            if (plan.conversationId) url.searchParams.set("conversationId", plan.conversationId);
            await controller.verify();
            const response = await (options.fetchImpl ?? fetch)(url, {
              method: "POST",
              headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
              body: JSON.stringify(upload),
              signal: AbortSignal.any([stop.signal, AbortSignal.timeout(10_000)]),
            });
            await response.body?.cancel();
            if (response.status === 409) {
              stop.abort();
              throw new Error("Original Grok conversation/session retired; no transcript retargeting");
            }
            if (!response.ok) throw new Error(`Grok transcript upload refused (${response.status})`);
          }
        } catch (error) {
          if (!stop.signal.aborted) stderr.write(`Grok native transcript: ${String(error)}\n`);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    })();
    pump = pumpSeatEvents(
      {
        notification: async (event) => {
          const params = event.params as { content: string; meta: { event_id: string } };
          const id = params.meta.event_id;
          const completed = fence.completed(id);
          if (completed) {
            if (completed.sessionId !== plan.sessionId)
              throw new Error("Grok event belongs to its original session");
            return;
          }
          if (fence.pending(id)) throw new Error("Original Grok event is uncertain; no replay");
          while (controller.status() !== "idle") {
            stop.signal.throwIfAborted();
            if (controller.status() === "offline") throw new Error("Grok operator channel closed");
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          const receipt = fence.begin(id, {
            sessionId: plan.sessionId,
            fingerprint: deliveryFingerprint(params.content),
          });
          const delivery = await controller.send(
            `<clankie-seat-event>\n${JSON.stringify(params)}\n</clankie-seat-event>`,
          );
          if (delivery.outcome !== "accepted")
            throw new Error("Grok operator event unconfirmed; inspect its original receipt");
          fence.complete(id, receipt.messageId, {
            messageId: delivery.messageId,
            state: delivery.state,
            deliveryStage: delivery.deliveryStage,
          });
        },
      },
      upstream,
      stop.signal,
      { onError: (error) => stderr.write(`Grok operator outbox: ${String(error)}\n`) },
    );
    void pump.catch((error) => {
      stderr.write(`Grok operator delivery stopped: ${String(error)}\n`);
      stop.abort();
    });
    stderr.write(`Clankie Grok: native session ${plan.sessionId}; receipts ${state}\n`);
    return await exited;
  } finally {
    stop.abort();
    await pump?.catch(() => {});
    await transcriptPump?.catch(() => {});
    await upstream?.close();
    if (!active) {
      await native?.stopOwnedLeader().catch(() => {});
      await persist();
    }
    await native?.close();
    // A failed binding leaves its original visible TUI and receipts for inspection.
    // Never terminate a potentially accepted launch or erase an uncertain receipt.
  }
}
