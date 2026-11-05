import type { SeatExitGuard } from "@clankie/agent-hosts";
import { type ProjectHireProcessProof } from "./project-hires.ts";
import type { ProjectsSettings } from "@clankie/protocol/projects";
import { ConversationOwnerSchema, type ConversationAuthority } from "./conversation-owner.ts";
import { DiscordWatchOriginSchema, type DiscordWatchOrigin } from "./conversation-owner.ts";
import { codexProxySettled, type ExternalCodexControl } from "./external-codex-control.ts";
import { type CodexAccount } from "@clankie/settings";
import { type OperatorSeatSpawnResult, type SpawnOperatorSeat as HireRequest } from "@clankie/protocol";
import { z } from "zod";
import { type HerdrForegroundProcess } from "./codex-seat.ts";
import { type ObservedFleetSeat } from "./herdr-census.ts";
import { type FleetSeatDelivery } from "./fleet-seat.ts";
import { type MachineWorkerAccounts } from "./harness-accounts.ts";
import { type HerdrAgentSession, type HerdrSeatTranscript } from "./herdr-transcript.ts";
import type { HerdrWatchStore } from "./herdr-watch.ts";

/**
 * Exact persisted conversation and route for a one-shot completion wake.
 * Current authority is checked again by the host dispatcher (ADR 0186/0215).
 */
export const HerdrWatchWakeReceiptSchema = z.strictObject({
  messageId: z.string().min(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  owner: ConversationOwnerSchema,
  recipientBinding: z.string().min(1).optional(),
});

type HerdrWatchWakeReceipt = z.infer<typeof HerdrWatchWakeReceiptSchema>;

export interface HerdrWatchWakeContext {
  readonly messageId: string;
  readonly receipt: HerdrWatchWakeReceipt | undefined;
  /** Persist the exact original before the native mailbox can expose it. */
  reserve(receipt: HerdrWatchWakeReceipt): void;
}

type HerdrWatchWakeResult = "accepted" | "deferred";

/**
 * The owner settled this watch's reserved original wake as abandoned-unknown.
 * It is never resent or reported delivered, so the watch ends terminally.
 */
export class HerdrWatchWakeAbandonedError extends Error {}

/** Why a watch ended without observing its completion. */
export type HerdrWatchEnd = "native_session_changed" | "native_agent_exited";

export const HerdrWatchSettlementSchema = z.strictObject({
  watchId: z.string().min(1),
  conversationId: z.string().min(1),
  terminalId: z.string().min(1),
  reason: z.string().min(1),
  outcome: z.enum(["native_session_changed", "native_agent_exited", "wake_abandoned"]),
  receiptId: z.string().min(1).optional(),
  settledAt: z.string().min(1),
});

export type HerdrWatchSettlement = z.infer<typeof HerdrWatchSettlementSchema>;

export const SETTLEMENTS_MAX = 200;

const HerdrWatchRecordSchema = z
  .object({
    id: z.string().min(1),
    conversationId: z.string().min(1),
    target: z.string().min(1),
    terminalId: z.string().min(1),
    /** Missing legacy native proof cannot authorize a completion harvest. */
    occupantId: z.string().min(1).optional(),
    /** Only a host-created hire harvest follows adoption; explicit watches keep their arming source. */
    hired: z.literal(true).optional(),
    /** Native accepted turn identity; never infer its completion from another idle turn. */
    messageId: z.string().min(1).max(512).optional(),
    wakeReceipt: HerdrWatchWakeReceiptSchema.optional(),
    /** A nonterminal working notice was accepted; retain observation without repeating it. */
    workingNoticeDelivered: z.boolean().optional(),
    workerSettledNotified: z.boolean().optional(),
    noticeSequence: z.number().int().nonnegative().optional(),
    reason: z.string().min(1),
    createdAt: z.string().min(1),
    discord: DiscordWatchOriginSchema.optional(),
  })
  .strict();

export const NativeCompletionSchema = z
  .object({
    type: z.literal("turn_completed"),
    at: z.string(),
    messageId: z.string().optional(),
    nativeTurnId: z.string().optional(),
    ok: z.boolean(),
    text: z.string().optional(),
    stopReason: z.string().optional(),
  })
  .strict();

export const PersistedHerdrWatchesSchema = z
  .object({
    schemaVersion: z.literal(1),
    watches: z.array(HerdrWatchRecordSchema),
    /** Deny-only native harvest claims, retained after a watch settles or restarts. */
    harvestedTurns: z
      .array(
        z
          .object({
            terminalId: z.string().min(1),
            occupantId: z.string().min(1),
            messageId: z.string().min(1).max(512),
            watchId: z.string().min(1),
            completion: NativeCompletionSchema.optional(),
          })
          .strict(),
      )
      .optional(),
    /** Deny-only history of prepared allocations; never ownership or admission. */
    preparedPanes: z
      .array(z.object({ paneId: z.string().min(1), terminalId: z.string().min(1).optional() }).strict())
      .optional(),
  })
  .strict();

export type HerdrWatchRecord = z.infer<typeof HerdrWatchRecordSchema>;

export type PersistedHerdrWatches = z.infer<typeof PersistedHerdrWatchesSchema>;

export interface HerdrAgentSnapshot {
  readonly paneId: string;
  readonly terminalId: string;
  readonly name?: string;
  readonly agent: string;
  readonly status: string;
  readonly title: string;
  readonly session?: HerdrAgentSession;
  readonly workingDirectory?: string;
  readonly foregroundWorkingDirectory?: string;
  /** Herdr lifecycle counters survive turns shorter than a roster poll. */
  readonly completionSeq?: number;
  readonly stateChangeSeq?: number;
}

export type SpawnOperatorSeat = HireRequest & { harness: NonNullable<HireRequest["harness"]> };

/**
 * One pane on one machine connection, held for a whole prompt answer (ADR 0303).
 * Every call goes through the connection the pane was found on, to the pane it
 * was found in, so a machine whose connection changes mid-answer refuses the next
 * call instead of reaching another endpoint.
 */
export interface HerdrBoundPane {
  /** The pane as found when it was bound. */
  readonly pane: HerdrAgentSnapshot;
  /** The same terminal as Herdr reports it now, over the same connection. */
  resolve(): Promise<HerdrAgentSnapshot | undefined>;
  readScreen(): Promise<string>;
  sendKeys(keys: readonly string[]): Promise<void>;
  /** Absent where the terminal takes only named keys, as a desktop-app seat does. */
  sendText?(text: string): Promise<void>;
}

export interface HerdrWatchRunner {
  /** Bind an exact terminal to its pane and connection; undefined when no such terminal. */
  bindPane?(terminalId: string): Promise<HerdrBoundPane | undefined>;
  /** Fresh complete inventory of exactly one fleet, for native session reuse. */
  list?(fleet?: string): Promise<readonly HerdrAgentSnapshot[]>;
  get(target: string): Promise<HerdrAgentSnapshot>;
  /**
   * Resolve an exact terminal or pane ID; never a name or focus alias. `fresh` reads Herdr's
   * pane list now, never one a runner kept from an earlier call.
   */
  resolveTerminal(
    terminalId: string,
    options?: { readonly fresh?: boolean },
  ): Promise<HerdrAgentSnapshot | undefined>;
  wait(target: string, signal: AbortSignal): Promise<HerdrAgentSnapshot>;
  waitForChange?(target: string, currentStatus: string, signal: AbortSignal): Promise<HerdrAgentSnapshot>;
  /**
   * `herdr agent wait --until idle --until working --until done --timeout 30000`
   * after the channels dialog. A working pane is a live hire.
   */
  waitUntilIdle?(target: string, signal: AbortSignal): Promise<HerdrAgentSnapshot>;
  transcript?(agent: HerdrAgentSnapshot): Promise<HerdrSeatTranscript | undefined>;
  read?(target: string, harness: string, source: "visible" | "recent-unwrapped"): Promise<string>;
  readPane?(target: string, source: "visible" | "recent-unwrapped", format: "text" | "ansi"): Promise<string>;
  /**
   * `herdr pane send-keys`: named key presses, never text. Claude's Stop presses one `esc` (VUH-2680).
   * Keys Herdr has no name for go in as their xterm bytes (ADR 0323).
   */
  sendKeys?(paneId: string, keys: readonly string[]): Promise<void>;
  /**
   * `herdr pane send-text`: one line typed into the pane, no Enter. Only a
   * connected app answering an open prompt the owner let it answer (ADR 0303);
   * never a channel for automated messages (ADR 0207).
   */
  sendText?(paneId: string, text: string): Promise<void>;
  /**
   * `herdr agent prompt`: pastes a whole message and presses Enter, refused while the agent is
   * blocked. Only the direct-prompt fallback for an agent with no native channel (ADR 0334).
   */
  promptAgent?(paneId: string, text: string): Promise<void>;
  /** `herdr pane process-info --pane` → `foreground_processes`. */
  paneProcesses?(paneId: string): Promise<readonly HerdrForegroundProcess[]>;
  /** `herdr pane process-info --pane` → the pane's own shell and its foreground processes. */
  paneShell?(
    paneId: string,
  ): Promise<{ readonly shellPid?: number; readonly foreground: readonly HerdrForegroundProcess[] }>;
  /** `lsof -p <pid> -Fn` via execFile (no shell). */
  openFiles?(pid: number): Promise<string>;
  /**
   * `codex queue --thread <id> --message <text>`. False on a non-zero exit or
   * "No active session".
   */
  codexControl?: ExternalCodexControl;
  codexQueue?(
    sessionId: string,
    text: string,
    codexHome?: string,
    endpoint?: string,
    beforeDispatch?: () => Promise<boolean>,
  ): Promise<boolean | FleetSeatDelivery>;
  codexSettled?: typeof codexProxySettled;
  closePane?(target: string, guard?: SeatExitGuard): Promise<void>;
  /** Change the manual label of an owned newly allocated pane, never its OSC title. */
  renamePane?(target: string, label: string): Promise<void>;
  /**
   * Where a host checkout is mounted in this runner's native namespace, when that differs
   * (an eval container). Pane cwds this runner reports are native paths.
   */
  nativeWorkingDirectory?(cwd: string): string;
  /** Open a tab in a working directory; resolves with its root pane id. */
  createTab?(options: {
    readonly cwd: string;
    readonly label: string;
    readonly paneLabel?: string;
    readonly pipeline?: string;
    readonly group?: string;
    /** The verified project's name, when the hire has one; the desktop app's space is named for it. */
    readonly project?: string;
    readonly placement?: "new-tab" | "split";
    readonly env?: Readonly<Record<string, string>>;
    /** Initial native argv, never terminal input. Only prepared adapters use this. */
    readonly command?: readonly string[];
    /** A registered remote fleet (ADR 0184); absent is the local default. */
    readonly fleet?: string;
    /** The harness this tab will hold, which decides where a local hire can start (ADR 0319). */
    readonly harness?: string;
  }): Promise<string>;
  /** Start a harness in a pane already sitting at its shell prompt. */
  startAgent?(options: {
    readonly name: string;
    readonly kind: string;
    readonly paneId: string;
    /** Extra argv after `--` on `herdr agent start` (the seat channel for claude). */
    readonly args?: readonly string[];
  }): Promise<void>;
  /**
   * `herdr integration install pi`: the pi extension that reports each pi
   * session to herdr. Without it herdr never learns a pi pane's session, so a pi
   * hire has no durable identity. Idempotent.
   */
  installPiIntegration?(): Promise<void>;
  /**
   * Declares one provider in pi's `models.json` (its agent directory), keeping
   * every other provider there. An unreadable file is left alone and fails the hire.
   */
  configurePiProvider?(id: string, config: Readonly<Record<string, unknown>>): Promise<void>;
  /**
   * `herdr pane run`: one shell command line in a pane at its prompt. A seat
   * adapter uses it to put its view there (VUH-1458).
   */
  runInPane?(paneId: string, argv: readonly string[]): Promise<void>;
}

export type HerdrWatchArmResult =
  | {
      readonly outcome: "settled_for_message";
      readonly messageId: string;
      readonly watchId: string;
      readonly completion: z.infer<typeof NativeCompletionSchema>;
    }
  | { readonly outcome: "already_harvested"; readonly messageId: string; readonly watchId: string }
  | {
      readonly outcome: "watching";
      readonly messageId?: string;
      readonly watchId: string;
      readonly target: string;
      readonly paneId: string;
      readonly terminalId: string;
      readonly alreadyWatching: boolean;
      readonly createdAt: string;
    }
  | {
      readonly outcome: "already_settled";
      readonly target: string;
      readonly paneId: string;
      readonly terminalId: string;
      readonly status: string;
    };

/** A lead's on-demand fresh restart of one hire (#425). */
export type RestartSeat = (
  seatId: string,
  authority: ConversationAuthority,
) => Promise<{ outcome: "scheduled" } | { outcome: "refused"; reason: string }>;

export interface HerdrWatchPort {
  settleHireReceipt?: HerdrWatchStore["settleHireReceipt"];
  tidy?: import("./pane-tidy.ts").PaneTidy;
  /** Moves a leaving seat's issue to its next status (VUH-1990). */
  issueStatus?: import("./seat-issue-status.ts").SeatIssueKeeper;
  efficiency?: import("./fleet-efficiency-tools.ts").FleetEfficiencyActions;
  /** A machine's Claude profiles and Codex accounts with sign-in and usage (VUH-1527). */
  workerAccountsReport?: (fleet?: string) => Promise<MachineWorkerAccounts>;
  /** Huddles (VUH-2025). */
  huddles?: import("./port.ts").HuddleService;
  workerAsks?: import("./worker-asks.ts").WorkerAskService;
  /** The standing review gate (ADR 0287). */
  reviews?: import("./review-gate.ts").ReviewGate;
  readoptSeat?(seatId: string, authority: ConversationAuthority): Promise<void>;
  /** A lead asks for one hire's fresh restart now, at any context size (#425). */
  restartSeat?: RestartSeat;
  /** This conversation's routines, managed as its lead (ADR 0265). */
  routines?: (
    command: import("@clankie/protocol").RoutineCommand,
    conversationId: string,
  ) => Promise<import("@clankie/protocol").RoutinesStatus>;
  watch(
    conversationId: string,
    target: string,
    reason: string,
    discord?: DiscordWatchOrigin,
    guard?: () => Promise<void>,
    messageId?: string,
  ): Promise<HerdrWatchArmResult>;
}

export type HireAuthority = ConversationAuthority & {
  readonly intentId?: string;
  /** Host-resolved saved thread, admitted against its existing persisted owner. */
  readonly resumedSessionKey?: string;
};

export type AdoptHire = (
  result: Extract<HerdrSeatSpawnResult, { outcome: "spawned" }>,
  projectId?: string,
) => void;

export type InternalWake = (
  conversationId: string,
  prompt: string,
  discord?: DiscordWatchOrigin,
  guard?: () => Promise<void>,
  original?: HerdrWatchWakeContext,
) => Promise<void | HerdrWatchWakeResult>;

type HerdrSeatProjection =
  | { readonly kind: "status"; readonly status: string }
  | { readonly kind: "summary"; readonly text: string }
  | { readonly kind: "reply"; readonly text: string }
  | { readonly kind: "transcript"; readonly transcript: HerdrSeatTranscript };

export type ProjectSeat = (seatId: string, projection: HerdrSeatProjection) => void;

export const REPLY_STATUSES = new Set(["idle", "done"]);

export const RETRY_ADMISSION_MS = 5_000;

/**
 * An uncertain local hire whose pane never appeared fences its place this long; after
 * it, a complete inventory showing no harness in its directory settles it (#251).
 */
export const UNRECORDED_HIRE_SETTLE_MS = 5 * 60_000;

/** ADR 0322: within the nine-minute Claude hook wait, a lead hears an open question again. */
export const QUESTION_REMINDERS = { retryMs: 30_000, remindMs: 3 * 60_000, windowMs: 9 * 60_000 } as const;

export const SEAT_TRANSCRIPT_TAIL_MS = 1_000;

export const NATIVE_CHAT_CACHE_FILES_MAX = 64;

export const NATIVE_CHAT_CACHE_BYTES_MAX = 32 * 1024 * 1024;

export const SPAWN_SESSION_WAIT_MS = 10_000;

// A harness that reports its session on its first turn (Codex) must start that
// turn first: connect every configured MCP server (Codex allows each 10 s by
// default, so one dead server spends all of SPAWN_SESSION_WAIT_MS), then begin
// the model call. A live hire was torn down at exactly 10 s waiting on it.
export const SPAWN_FIRST_TURN_SESSION_WAIT_MS = 30_000;

export const SPAWN_SESSION_POLL_MS = 250;

/** A live agent's session can be missing from one snapshot (#338); read again this often before refusing. */
export const SEAT_SESSION_RETRIES = 3;

export const SEAT_SESSION_RETRY_MS = 400;

/** A terminal id, bare on the local fleet or `<fleet>/term_…` on a remote one (ADR 0184). */
export const TERMINAL_ID = /^(?:[a-z][a-z0-9-]{0,63}\/)?term_[0-9a-f]+$/u;

/** How long a delivered message may take to turn an idle seat into a working one. */
export const SEAT_PICKUP_WAIT_MS = 10_000;

export const CHANNEL_DIALOG_MARKER = "Loading development channels";

export const CLAUDE_CHANNEL_CONSENT_REQUIRED =
  "consent_required: Claude stopped at its development-channel warning, which only the owner may accept. " +
  "Fix: approve the clankie-worker@inline channel in /Library/Application Support/ClaudeCode/managed-settings.json (channelsEnabled, allowedChannelPlugins).";

export const PI_ZONE_START = "\u001B]133;A\u0007";

export const PI_ZONE_END = "\u001B]133;B\u0007\u001B]133;C\u0007";

/**
 * Every hire names its available control, including why structured delivery is unavailable.
 */
export type SeatControlMode = NonNullable<OperatorSeatSpawnResult["control"]>;

export type HerdrSeatSpawnResult =
  | Exclude<OperatorSeatSpawnResult, { readonly outcome: "spawned" }>
  | (Omit<Extract<OperatorSeatSpawnResult, { outcome: "spawned" }>, "seat"> & {
      readonly seat: ObservedFleetSeat;
    });

export type HerdrSeatSpawnFailure = Extract<HerdrSeatSpawnResult, { readonly outcome: "failed" }>;

/** A move re-hires an existing seat, so it is never refused for capacity. */
export type HerdrSeatMoveResult =
  | Extract<HerdrSeatSpawnResult, { readonly outcome: "spawned" }>
  | (Omit<HerdrSeatSpawnFailure, "reason"> & {
      readonly reason: Exclude<
        HerdrSeatSpawnFailure["reason"],
        "at_capacity" | "delivery_unconfirmed" | "start_unconfirmed"
      >;
    });

/** Persisted, event-driven one-shot watches that wake an operator conversation when an agent settles. */
/**
 * How a hosted body's pi workers reach a model (VUH-1373). On included usage
 * the model is the body's own `clankie/default`, reached through its loopback
 * forwarder, so `provider` is declared in pi's `models.json` first. On the
 * customer's own credential it is their selected model, and no provider.
 */
export interface PiSeatModel {
  readonly model: string;
  readonly provider?: { readonly id: string; readonly config: Readonly<Record<string, unknown>> };
}

/** Controller-owned launch admission; absent for ordinary production hires. */
export interface NativeLaunchPolicy {
  /** Trusted preallocation replaces ordinary account probes and skill overlays. */
  prepare?(input: { seat: Readonly<SpawnOperatorSeat>; resumed: boolean }): Promise<{
    account: Readonly<CodexAccount>;
    args: readonly string[];
    env: Readonly<Record<string, string>>;
  }>;
  admit(input: {
    seat: Readonly<SpawnOperatorSeat>;
    phase: "request" | "launch";
    account?: Readonly<CodexAccount>;
    resumed: boolean;
  }): Promise<void>;
}

export interface ProjectHirePolicy {
  settings(): Promise<ProjectsSettings>;
  project(
    input: Readonly<HireRequest>,
    settings: ProjectsSettings,
    authority?: ConversationAuthority,
  ): Promise<string | undefined>;
  proof?(fleet: string, pane: string): Promise<ProjectHireProcessProof | undefined>;
  /** Why the last proof for this pane was refused, in fixed words, when the observer kept it. */
  proofRefusal?(pane: string): string | undefined;
  tools?(projectId: string): Promise<readonly string[]>;
}
