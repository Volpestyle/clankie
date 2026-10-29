import { FileCredentialStore } from "@clankie/credential-broker";
import { EmbodimentManager } from "../../src/embodiment.ts";
import { ConfiguredMediaGenerator } from "../../src/media-generation.ts";
import {
  DiscordPresenceSessionProjection,
  DiscordVoiceHistoryProjection,
} from "../../src/discord-presence-session.ts";
import { readVoiceSpeechSnapshot } from "../../src/voice-receipt-activity.ts";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import type { MachineWorkerAccounts } from "../../src/captain/harness-accounts.ts";
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
    inventory?: (fleet?: string) => Promise<void>;
    /** Complete occupants after a lead leaves; undefined retains the fixture's initial native seat. */
    inventoryAgents?: (fleet?: string) => HerdrAgentSnapshot[] | undefined;
    /** A second registered inventory, independent of the native lead's local one. */
    additionalFleet?: boolean;
    remoteShell?: NonNullable<CaptainDeps["fleets"]>["shell"];
    /**
     * Herdr's `pane process-info` for one pane (undefined fleet is local); it may throw.
     * Unset, no process read answers. VUH-2975 omitted-agent shell proof.
     */
    paneShell?: (
      fleet: string | undefined,
      paneId: string,
    ) => { readonly shellPid?: number; readonly foreground: readonly { pid: number; name: string }[] };
    leadRestartCheckMs?: number;
    defaultLead?: boolean;
    beforeOpen?: (sessionId: string) => Promise<void>;
    projectHireIdentity?: CaptainOptions["projectHireIdentity"];
    paneReadFails?: () => boolean;
    /** Opt-in native launch surface for one hire's own new pane (VUH-2975). */
    launch?: {
      readonly seatAdapters: NonNullable<CaptainOptions["seatAdapters"]>;
      readonly createTab: () => Promise<string>;
      /** Herdr's occupant of exactly this allocated pane; undefined keeps the native lead. */
      readonly pane: (paneId: string) => HerdrAgentSnapshot | undefined;
      /** Herdr's resolution of the hire's own terminal; any other terminal stays gone. */
      readonly terminal?: (terminalId: string) => HerdrAgentSnapshot | undefined;
      readonly tools: NonNullable<CaptainOptions["projectHireTools"]>;
    };
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
  const herdrResponse = (args: readonly string[], fleet?: string) => {
    wire.agent_status = options.nativeStatus?.() ?? "idle";
    const agents = options.inventoryAgents?.(fleet)?.map((snapshot) => ({
      pane_id: snapshot.paneId.replace(/^pc\//u, ""),
      terminal_id: snapshot.terminalId.replace(/^pc\//u, ""),
      // The parser reads an omitted agent field as "unknown", as current Herdr sends a plain shell.
      ...(snapshot.agent === "unknown" ? {} : { agent: snapshot.agent }),
      agent_status: snapshot.status,
      title: snapshot.title,
      ...(snapshot.session === undefined ? {} : { agent_session: snapshot.session }),
      cwd: snapshot.workingDirectory ?? root,
    })) ?? [wire];
    let result: unknown;
    if (args[0] === "agent" && args[1] === "list") result = { agents };
    else if (args[0] === "agent" && args[1] === "get") result = { agent: agents[0] };
    else if (args[0] === "pane" && args[1] === "list") result = { panes: agents };
    else if (args[0] === "workspace" && args[1] === "list") result = { workspaces: [] };
    else if (args[0] === "api" && args[1] === "snapshot")
      result = { snapshot: { workspaces: [], tabs: [], panes: agents, agents } };
    else if (
      options.paneShell !== undefined &&
      args[0] === "pane" &&
      args[1] === "process-info" &&
      args[2] === "--pane"
    ) {
      const shell = options.paneShell(fleet, args[3]!);
      result = {
        process_info: {
          pane_id: args[3],
          ...(shell.shellPid === undefined ? {} : { shell_pid: shell.shellPid }),
          foreground_processes: shell.foreground,
        },
      };
    } else throw new Error(`Unexpected Herdr command: ${args.join(" ")}`);
    return JSON.stringify({ result });
  };
  // The worker delivery path types nothing here; any call proves a lead was treated as a hire.
  const workerDelivery = vi.spyOn(HerdrWatchStore.prototype, "deliverToSeat");
  const adoption = vi.spyOn(HerdrWatchStore.prototype, "adoptSeat");
  // A launch observes one fixture Codex account in a temp home, as project-hires.test.ts
  // does, never the real ~/.codex or its CLI. createCaptain has no option for these
  // observation sources; it assigns workerAccountsReport just before it starts the
  // store, so the store's own start installs them. Admission over them stays real.
  let launchAccounts: ((store: unknown) => void) | undefined;
  if (options.launch !== undefined) {
    const codexHome = join(root, "codex-home");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "auth.json"), "fixture presence only");
    const observed = (): MachineWorkerAccounts => ({
      machine: "local",
      shell: "posix",
      observedAt: new Date().toISOString(),
      accounts: [
        {
          harness: "codex",
          label: "fixture",
          home: codexHome,
          signedIn: true,
          usable: true,
          plan: "pro",
          headroom: 0.8,
          usage: {
            source: "codex-rate-limits",
            observedAt: new Date().toISOString(),
            windows: [{ id: "week", label: "Week", usedPercent: 20 }],
          },
        },
      ],
    });
    launchAccounts = (store) =>
      Object.assign(store as object, {
        workerAccountsReport: async () => observed(),
        workerAccounts: async (_fleet: string | undefined, harness: string) => {
          const report = observed();
          return { ...report, accounts: report.accounts.filter((account) => account.harness === harness) };
        },
        accounts: async () => [{ label: "fixture", home: codexHome }],
      });
  }
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(function (this: unknown) {
    launchAccounts?.(this);
  });
  const runner: HerdrWatchRunner = {
    ...(options.slowFleetMs === undefined && !options.nativeSourceProof
      ? {}
      : {
          list: async (fleet) => {
            await options.inventory?.(fleet);
            return options.inventoryAgents?.(fleet) ?? [head];
          },
        }),
    get: async (target) => {
      if (options.paneReadFails?.()) throw new Error("Herdr pane read unavailable");
      return options.launch?.pane(target) ?? head;
    },
    ...(options.launch === undefined
      ? {}
      : { createTab: options.launch.createTab, runInPane: async () => {}, startAgent: async () => {} }),
    ...(options.paneShell === undefined
      ? {}
      : { paneShell: async (paneId: string) => options.paneShell!(undefined, paneId) }),
    resolveTerminal: async (id) =>
      id === head.terminalId ? head : (options.launch?.terminal?.(id) ?? Promise.reject(new Error("gone"))),
    wait: async () => head,
  };
  // Setup's roster check needs only the local lead; the case's own calls meet the slow
  // machine. Waiting it out here too cost each case 2.5 s against the roster budget (VUH-2929).
  let fleetDelayMs = 0;
  let slowFleetCalls = 0;
  const settings = new SettingsStore(join(root, "settings.json"));
  if (remote || options.slowFleetMs !== undefined || options.additionalFleet)
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
    ...(options.additionalFleet
      ? {
          fleets: {
            list: [{ id: "pc", session: "default", ssh: { host: "fixture.invalid", shell: "posix" } }],
            ...(options.remoteShell === undefined ? {} : { shell: options.remoteShell }),
            run: (fleet: { id: string }) => async (args: readonly string[]) => {
              await options.inventory?.(fleet.id);
              return herdrResponse(args, fleet.id);
            },
          },
        }
      : remote
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
      discordEnvironment: {},
      seatAdapters: options.launch?.seatAdapters ?? [],
      ...(options.launch === undefined ? {} : { projectHireTools: options.launch.tools }),
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
