import { FileCredentialStore } from "@clankie/credential-broker";
import { EmbodimentManager } from "../../src/embodiment.ts";
import { ConfiguredMediaGenerator } from "../../src/media-generation.ts";
import {
  DiscordPresenceSessionProjection,
  DiscordVoiceHistoryProjection,
} from "../../src/discord-presence-session.ts";
import { readVoiceSpeechSnapshot } from "../../src/voice-receipt-activity.ts";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { OperatorSeatEventKindSchema } from "@clankie/protocol";
import { pumpSeatEvents } from "../../../tui/src/command/mcp.ts";
import { createCaptain } from "../../src/captain/captain.ts";
import { ConversationStore } from "../../src/captain/conversations.ts";
import {
  HerdrWatchStore,
  type HerdrAgentSnapshot,
  type HerdrWatchRunner,
} from "../../src/captain/herdr-watch.ts";
import type { CaptainDeps } from "../../src/captain/deps.ts";
import type { CaptainOptions } from "../../src/captain/captain-types.ts";

export const capabilities = {
  schemaVersion: 1 as const,
  eventKinds: [...OperatorSeatEventKindSchema.options],
  ownerOrigin: true,
};

export async function leadChatFixture(
  remote: boolean,
  cleanup: Array<() => Promise<void>>,
  /** A configured machine whose Herdr answers only after this delay, then fails. */
  options: {
    slowFleetMs?: number;
    localUnavailable?: () => boolean;
    nativeStatus?: () => string;
    nativeSourceProof?: boolean;
    /** Runs before the complete local Herdr inventory answers; it may hold or fail that answer. */
    inventory?: () => Promise<void>;
    leadRestartCheckMs?: number;
    defaultLead?: boolean;
    beforeOpen?: (sessionId: string) => Promise<void>;
    projectHireIdentity?: CaptainOptions["projectHireIdentity"];
    paneReadFails?: () => boolean;
    /** Herdr detection (ADR 0308). Absent leaves lead rebind off. */
    connectorSessionDetection?: () => boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "lead-messages-"));
  cleanup.push(async () => rmSync(root, { recursive: true, force: true }));
  const seeded = new ConversationStore(join(root, "conversations"), async () => {});
  const leads: string[] = [];
  for (const title of ["Global lead", "Clankie Work"]) {
    const created = await seeded.serve({ schemaVersion: 1, op: "create", scope: { kind: "global" }, title });
    if (created.op !== "create") throw new Error("create failed");
    leads.push(created.conversation.conversationId);
  }
  const hidden = [seeded.roomConversation("discord_presence", "guild:channel")];
  const worker = await seeded.serve({
    schemaVersion: 1,
    op: "create",
    scope: { kind: "seat", seatId: "worker-seat" },
    title: "Hidden worker",
  });
  if (worker.op !== "create") throw new Error("Missing worker chat");
  hidden.push(worker.conversation.conversationId);
  await seeded.close();
  const sessionId = randomUUID();
  const prefix = remote ? "pc/" : "";
  let head: HerdrAgentSnapshot = {
    paneId: `${prefix}w4:p2`,
    terminalId: `${prefix}term_work`,
    agent: "claude",
    status: "idle",
    title: "Clankie Work",
    session: { source: "herdr:claude", kind: "id", value: sessionId },
    workingDirectory: root,
  };
  const wire: {
    pane_id: string;
    terminal_id: string;
    agent: string;
    agent_status: string;
    title: string;
    agent_session?: HerdrAgentSnapshot["session"];
    cwd: string;
  } = {
    pane_id: "w4:p2",
    terminal_id: "term_work",
    agent: "claude",
    agent_status: "idle",
    title: "Clankie Work",
    agent_session: { ...head.session! },
    cwd: root,
  };
  /**
   * The pane's occupant changes, as when a relaunch starts a new session in it
   * (VUH-2860), or launches one that has not reported a session yet (VUH-2868).
   */
  const occupy = (next: { sessionId: string | undefined; terminalId?: string; agent?: string }) => {
    const terminal = next.terminalId ?? "term_work";
    const { session: _session, ...occupant } = head;
    head = {
      ...occupant,
      terminalId: `${prefix}${terminal}`,
      agent: next.agent ?? "claude",
      ...(next.sessionId === undefined
        ? {}
        : { session: { source: "herdr:claude", kind: "id" as const, value: next.sessionId } }),
    };
    wire.terminal_id = terminal;
    wire.agent = head.agent;
    if (head.session === undefined) delete wire.agent_session;
    else wire.agent_session = { ...head.session };
  };
  const herdrResponse = (args: readonly string[]) => {
    wire.agent_status = options.nativeStatus?.() ?? "idle";
    let result: unknown;
    if (args[0] === "agent" && args[1] === "list") result = { agents: [wire] };
    else if (args[0] === "agent" && args[1] === "get") result = { agent: wire };
    else if (args[0] === "pane" && args[1] === "list") result = { panes: [wire] };
    else if (args[0] === "workspace" && args[1] === "list") result = { workspaces: [] };
    else if (args[0] === "api" && args[1] === "snapshot")
      result = { snapshot: { workspaces: [], tabs: [], panes: [wire], agents: [wire] } };
    else throw new Error(`Unexpected Herdr command: ${args.join(" ")}`);
    return JSON.stringify({ result });
  };
  // The worker delivery path types nothing here; any call proves a lead was treated as a hire.
  const workerDelivery = vi.spyOn(HerdrWatchStore.prototype, "deliverToSeat");
  const adoption = vi.spyOn(HerdrWatchStore.prototype, "adoptSeat");
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  const runner: HerdrWatchRunner = {
    ...(options.slowFleetMs === undefined && !options.nativeSourceProof
      ? {}
      : {
          list: async () => {
            await options.inventory?.();
            return [head];
          },
        }),
    get: async () => {
      if (options.paneReadFails?.()) throw new Error("Herdr pane read unavailable");
      return head;
    },
    resolveTerminal: async (id) => (id === head.terminalId ? head : Promise.reject(new Error("gone"))),
    wait: async () => head,
  };
  // Setup's roster check needs only the local lead; the case's own calls meet the slow
  // machine. Waiting it out here too cost each case 2.5 s against the roster budget (VUH-2929).
  let fleetDelayMs = 0;
  let slowFleetCalls = 0;
  const settings = new SettingsStore(join(root, "settings.json"));
  if (remote || options.slowFleetMs !== undefined)
    await settings.update((current) => ({
      ...current,
      machines: [{ id: "pc", ssh: "fixture.invalid", shell: "posix", aliases: [] }],
      machineAccess: { pc: "shell" },
      execution: {
        ...current.execution,
        connections: [
          { id: "pc", machine: "pc", session: "default", kind: "herdr", enabled: true, capabilities: [] },
        ],
      },
    }));
  const embodiment = new EmbodimentManager({
    clock: () => new Date(),
    decide: () => "deny",
    idFactory: randomUUID,
    emit: async () => {
      throw new Error("Read-only self-state proof cannot emit embodiment events");
    },
  });
  const presence = new DiscordPresenceSessionProjection();
  const voice = new DiscordVoiceHistoryProjection();
  const media = new ConfiguredMediaGenerator({
    credentials: new FileCredentialStore(join(root, "credentials.json")),
    attachmentRoot: root,
    configCwd: root,
    environment: {},
  });
  const deps = {
    herdrAvailable: () => !remote,
    embodiment: { getLiveSession: async () => embodiment.observe() },
    presence: {
      listSessions: async () => presence.list(),
      listVoiceHistory: async (limit = 5) => voice.list(limit),
      listRecentVoiceSpeech: (limit = 12) => readVoiceSpeechSnapshot(join(root, "voice.jsonl"), limit),
    },
    media,

    memory: {},
    browser: { catalog: async () => ({ available: false, tools: [] }) },
    mcp: { catalog: async () => [], call: async () => ({ outcome: "ok", content: "", isError: false }) },
    ...(remote
      ? {
          fleets: {
            list: [{ id: "pc", session: "default", ssh: { host: "fixture.invalid", shell: "posix" } }],
            run: () => async (args: readonly string[]) => herdrResponse(args),
          },
        }
      : options.slowFleetMs !== undefined
        ? {
            fleets: {
              list: [{ id: "pc", session: "default", ssh: { host: "fixture.invalid", shell: "posix" } }],
              // Like an ssh connect timeout to a machine that went away.
              run: () => async () => {
                if (fleetDelayMs > 0) slowFleetCalls++;
                await new Promise((resolve) => setTimeout(resolve, fleetDelayMs));
                throw new Error("ssh: connect to host fixture.invalid port 22: Operation timed out");
              },
            },
          }
        : {}),
  } as unknown as CaptainDeps;
  /** One service process over the same state directory; a second call is a restart. */
  const open = () => {
    const opened = createCaptain(deps, {
      repoRoot: root,
      stateDir: root,
      workingDirectory: root,
      nativeHerdrRunner: runner,
      nativeCensusRunner: async (_command: string, args: readonly string[]) => {
        if (options.localUnavailable?.()) throw new Error("Local Herdr socket unavailable");
        return { stdout: herdrResponse(args), stderr: "" };
      },
      settings,
      ...(options.leadRestartCheckMs === undefined ? {} : { leadRestartCheckMs: options.leadRestartCheckMs }),
      ...(options.projectHireIdentity === undefined
        ? {}
        : { projectHireIdentity: options.projectHireIdentity }),
      ...(options.connectorSessionDetection === undefined
        ? {}
        : { connectorSessionDetection: options.connectorSessionDetection }),
      discordEnvironment: {},
      seatAdapters: [],
    });
    cleanup.push(() => opened.close());
    return opened;
  };
  await options.beforeOpen?.(sessionId);
  const captain = open();
  // The lead's own hook sync attaches its native session to its conversation.
  expect(
    captain.syncSeatTranscript(options.defaultLead ? "global-default" : leads[1]!, {
      sessionId,
      entries: [],
    }),
  ).toBe(true);
  const roster = await captain.serveOperatorConversation({ schemaVersion: 1, op: "roster" });
  if (roster.op !== "roster") throw new Error("roster missing");
  expect(roster.seats.map((seat) => seat.seatId)).toContain(head.terminalId);
  fleetDelayMs = options.slowFleetMs ?? 0;

  /** A lead's seat bridge: the real pump, polling and acknowledging its own conversation. */
  const bridge = async (conversationId: string) => {
    const stop = new AbortController();
    const notification = vi.fn(async (_event: unknown) => {});
    const pump = pumpSeatEvents(
      { notification },
      {
        pollEvents: (waitMs, signal) => captain.pollSeatEvents(waitMs, signal, conversationId, capabilities),
        acknowledge: (id) => captain.acknowledgeSeatEvent(id, conversationId),
      },
      stop.signal,
      { waitMs: 200, retryMs: 20 },
    );
    cleanup.push(async () => {
      stop.abort();
      await pump;
    });
    // The seat is bound once its first poll parks, as a long-running bridge already is.
    // A slow machine delays that first poll's source proof.
    await expect
      .poll(() => captain.serveOperatorConversation({ op: "get", schemaVersion: 1, conversationId }), {
        timeout: 10_000,
      })
      .toMatchObject({ conversation: { driver: {} } });
    return notification;
  };
  const messageSeat = async (from: string, seat: string, message: string) => {
    const bank = await captain.laneToolBank("operator", from);
    const sent = await bank.tools.find((tool) => tool.name === "message_seat")!.call({ seat, message });
    const part = sent.content.find((item) => item.type === "text");
    return JSON.parse(part?.type === "text" ? part.text : "null");
  };
  return {
    captain,
    open,
    leads,
    head,
    /** The pane's current occupant, as Herdr reports it now. */
    current: () => head,
    occupy,
    bridge,
    messageSeat,
    workerDelivery,
    adoption,
    settings,
    root,
    hidden,
    /** Fleet calls that met the slow machine after setup. */
    slowFleetCalls: () => slowFleetCalls,
  };
}
