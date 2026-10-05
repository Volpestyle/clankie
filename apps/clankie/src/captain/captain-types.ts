import type { HarnessSeatAdapter } from "@clankie/agent-hosts";
import { type ModelPurpose } from "@clankie/model-provider";
import { SettingsStore } from "@clankie/settings";
import { type AgentSession } from "@earendil-works/pi-coding-agent";
import type { DeliveredFileStore } from "../delivered-files.ts";
import type { DiscordPresenceRuntimePort } from "../discord-presence-runtime.ts";
import { type FleetProjectMembership } from "../fleet-project-membership.ts";
import type { LocalCodexRegistration } from "../local-codex-seats.ts";
import { type PersonaImageSource } from "../persona-images.ts";
import type { RemoteCodexLaunch, RemoteCodexRegistration } from "../remote-codex-seats.ts";
import type { EvalSessionBoundary } from "./eval-session-boundary.ts";
import type { GrokNativeHost } from "./grok-native-host.ts";
import { type HerdrCensusRunner } from "./herdr-census.ts";
import { type HerdrWatchRunner, type NativeLaunchPolicy } from "./herdr-watch.ts";
import { type RoutedSelection } from "./model.ts";
import type { createOpenCodeNativeHost } from "./opencode-native-host.ts";
import type { ProjectHireProcessProof } from "./project-hires.ts";
import { type TurnContext } from "./tools.ts";

export interface CaptainOptions {
  /** Explicit controller-created eval boundary; ordinary sessions remain unchanged. */
  readonly evalSessionBoundary?: EvalSessionBoundary;
  /** Override local harness control adapters (including deterministic test adapters). */
  readonly seatAdapters?: readonly HarnessSeatAdapter[];
  readonly grokNative?: GrokNativeHost;
  readonly openCodeNative?: ReturnType<typeof createOpenCodeNativeHost>;
  readonly nativeLaunchPolicy?: NativeLaunchPolicy;
  readonly projectHireIdentity?: (
    fleet: string,
    pane: string,
  ) => Promise<ProjectHireProcessProof | undefined>;
  readonly projectHireTools?: (projectId: string) => Promise<readonly string[]>;
  /** The same native membership producer exposed by the HTTP app, created after the captain. */
  readonly fleetProjectMembership?: () => Pick<FleetProjectMembership, "read"> | undefined;
  readonly projectHireWorkspace?: (proof: ProjectHireProcessProof) => Promise<string | undefined>;
  readonly nativeHerdrRunner?: HerdrWatchRunner;
  readonly nativeCensusRunner?: HerdrCensusRunner;
  readonly nativeSummariesPath?: string;
  readonly fleetRoundIntervalMs?: number;
  readonly localCodexProcess?: (pid: number, pane: string) => LocalCodexRegistration;
  readonly localCodexSocket?: () => string | undefined;
  readonly remoteCodexProcess?: (launch: RemoteCodexLaunch) => RemoteCodexRegistration;
  readonly personaImages?: PersonaImageSource;
  /** Repo root: instructions.md lives here, skills are discovered here. */
  readonly repoRoot: string;
  /**
   * Where his shell and sessions run when a conversation names no workspace
   * (ADR 0149). Default the operator's home directory — never the repo root,
   * which on a release install is immutable.
   */
  readonly workingDirectory?: string;
  /** Durable captain state (sessions, lane logs, conversations). Default ~/.clankie/captain. */
  readonly stateDir: string;
  /** Settings store; defaults to the owner-authored file. Reloaded per turn. */
  readonly settings?: SettingsStore;
  /** Live webhook readiness, rechecked before a queued Linear wake starts. */
  readonly linearFollowing?: () => Promise<boolean>;
  /** Real process-level overrides captured before stored settings are projected into child env. */
  readonly discordEnvironment?: NodeJS.ProcessEnv;
  /** Conversation-scoped file publication; bytes share the conversation retention lifecycle. */
  readonly deliveredFiles?: Pick<DeliveredFileStore, "publish" | "removeConversation"> &
    Partial<Pick<DeliveredFileStore, "beginUpload" | "appendUpload" | "commitUpload" | "attachment">>;
  /**
   * Trusted Discord runtime, used to make a channel's room and webhook
   * (ADR 0146). It is also what answers which guild the managed server is, so an
   * absent runtime is no Discord projection at all rather than a fallback to
   * pasting — a deployment with no Discord bot has nothing to paste into.
   * Only a runtime that is present but lacks `Manage Webhooks` leaves the
   * manual path, and that webhook still has to be in the managed server.
   */
  readonly discordChannels?: Pick<
    DiscordPresenceRuntimePort,
    "provisionChannel" | "listRooms" | "swarmGuildId"
  >;
}

export interface LaneSession {
  readonly session: AgentSession;
  readonly capture: TurnContext;
  /** Machine-wide skills left out of the listing; `/name` still expands them. */
  readonly quietSkills: ReadonlySet<string>;
  readonly purpose: ModelPurpose;
  /** This purpose's route as of the last sync; the routing extension reads it per run. */
  readonly route: { current: RoutedSelection };
  /** Set when a request had to be trimmed to fit; the next sync compacts first. */
  readonly budget: { compactBeforeNextRun: boolean };
  lastAssistantText: string;
  turnCounter: number;
  /** Settlement of the in-flight run, while one is active: true if it succeeded. */
  running?: Promise<boolean> | undefined;
  runningDeliveryId?: string | undefined;
  /**
   * Operator turns hold this while they prepare (model sync, lane-log, herdr
   * census) so a concurrent human send waits and then steers instead of starting
   * a second prompt.
   */
  starting?: Promise<void> | undefined;
}

/**
 * The slice of pi's agent state a settled run is judged on. Kept structural so
 * a turn only ever asks for the transcript it reads.
 */
export interface PiRunState {
  readonly messages: readonly {
    readonly role: string;
    readonly stopReason?: string | undefined;
    readonly errorMessage?: string | undefined;
  }[];
}
