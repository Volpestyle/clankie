import { DEFAULT_PROJECT_ID } from "@clankie/protocol/projects";
import type { FleetSeatToolCatalog } from "@clankie/protocol/tool-catalog";
import { type ClankieSettings } from "@clankie/settings";
import { basename } from "node:path";
import { nativeProofLocation, splitFleetQualified } from "../herdr-fleet.ts";
import type { ProjectProcessProof } from "../project-process-proof.ts";
import { type CaptainOptions } from "./captain-types.ts";
import { createNativeSources } from "./captain-native-sources.ts";
import { createLeadSeats } from "./captain-lead-seats.ts";
import { type ConversationOwner } from "./conversation-owner.ts";
import { ConversationStore } from "./conversations.ts";
import type { CaptainDeps } from "./deps.ts";
import { occupantIdForHerdrSession } from "./herdr-census.ts";
import { FleetChangeClock } from "./herdr-fleet-changes.ts";
import { ToolCatalogHealthStore, type ToolCatalogIdentity } from "./tool-catalog-health.ts";

import type { HerdrWatchRunner } from "./herdr-watch.ts";

export interface ToolCatalogHealthContext {
  readonly options: Pick<CaptainOptions, "projectHireTools">;
  readonly deps: Pick<CaptainDeps, "herdrAvailable">;
  readonly herdrRunner: HerdrWatchRunner;
  readonly settings: () => Promise<ClankieSettings>;
  readonly conversations: ConversationStore;
  readonly validateConversationOwner: (owner: ConversationOwner) => Promise<boolean>;
  readonly toolCatalogHealth: ToolCatalogHealthStore;
  readonly fleetChanges: FleetChangeClock;
  readonly laneToolBankFor: (
    lane: "operator",
    conversationId?: string,
  ) => Promise<{ readonly tools: readonly { readonly name: string }[] }>;
  /** Read at call time: the captain builds these after this module (ADR 0325). */
  readonly inboundBinding: ReturnType<typeof createNativeSources>["inboundBinding"];
  readonly rememberOperatorSource: ReturnType<typeof createLeadSeats>["rememberOperatorSource"];
}

/** A native seat's reported tool catalog, checked against the tools it should have. */
export function createToolCatalogHealth(ctx: ToolCatalogHealthContext) {
  const {
    options,
    deps,
    herdrRunner,
    settings,
    conversations,
    validateConversationOwner,
    toolCatalogHealth,
    fleetChanges,
    laneToolBankFor,
  } = ctx;
  async function recordNativeToolCatalog(
    paneId: string,
    report: FleetSeatToolCatalog,
    workerTools: readonly string[],
    proof?: ProjectProcessProof,
    operatorTools?: readonly string[],
  ) {
    if (splitFleetQualified(paneId) === undefined && deps.herdrAvailable?.() === false) return undefined;
    // allow-swallowed-rejection -- moved unchanged from the captain (ADR 0325); a pane that can't be read has no catalog to record.
    const agent = await herdrRunner.get(paneId).catch(() => undefined);
    if (!agent?.session) return undefined;
    const identity = catalogIdentity(
      {
        paneId,
        occupantId: occupantIdForHerdrSession(agent.session),
        harness: agent.agent,
        session: agent.session,
      },
      report.bridge,
    );
    if (!identity || identity.sessionId !== report.sessionId || identity.harness !== report.harness)
      return undefined;
    const location = nativeProofLocation(paneId);
    if (
      proof &&
      (proof.nativeSessionPending ||
        proof.nativeOccupantId !== identity.occupantId ||
        proof.pane !== location.pane ||
        proof.fleet !== location.fleet)
    )
      return undefined;
    const currentSettings = await settings();
    const expected =
      report.bridge === "worker"
        ? [
            "message_clankie",
            "message_clankie_status",
            ...workerTools,
            ...(currentSettings.fleet.peerMessages === "on" ? ["list_fleet_seats", "message_peer"] : []),
          ]
        : operatorTools;
    if (expected === undefined) return undefined;
    if (report.bridge === "operator" && proof && report.conversationId) {
      // This caller has kernel/native-session proof and explicitly reports its
      // operator conversation. Preserve that qualified binding while the
      // transcript attachment and current occupant still agree. A later bare
      // discovery must not depend on unrelated offline fleet inventories.
      // allow-swallowed-rejection -- moved unchanged from the captain (ADR 0325); a pane that can't be read has no catalog to record.
      const current = await herdrRunner.get(paneId).catch(() => undefined);
      if (
        !current ||
        ctx.inboundBinding(current) !== ctx.inboundBinding(agent) ||
        conversations.attachedConversationForNative(current) !== report.conversationId ||
        !(await validateConversationOwner({ conversationId: report.conversationId }))
      )
        return undefined;
      await ctx.rememberOperatorSource(report.conversationId, current);
    }
    const health = toolCatalogHealth.record(identity, report, expected);
    fleetChanges.touch();
    return health;
  }

  async function observeCodexToolCatalog(ref: { paneId: string }, report: FleetSeatToolCatalog) {
    const workerTools = (await options.projectHireTools?.(DEFAULT_PROJECT_ID)) ?? [];
    return recordNativeToolCatalog(ref.paneId, report, workerTools);
  }

  function catalogIdentity(
    observed: {
      paneId: string;
      occupantId: string;
      harness: string;
      session?: { kind: "id" | "path"; value: string };
    },
    bridge: "worker" | "operator",
  ): ToolCatalogIdentity | undefined {
    if (observed.harness !== "claude" && observed.harness !== "codex") return undefined;
    const sessionId =
      observed.session === undefined
        ? undefined
        : observed.session.kind === "id"
          ? observed.session.value
          : basename(observed.session.value, ".jsonl");
    return {
      paneId: observed.paneId,
      occupantId: observed.occupantId,
      harness: observed.harness,
      ...(sessionId === undefined ? {} : { sessionId }),
      bridge,
    };
  }

  async function currentCatalogHealth(identity: ToolCatalogIdentity) {
    const operatorIdentity = { ...identity, bridge: "operator" as const };
    const workerIdentity = { ...identity, bridge: "worker" as const };
    if (!toolCatalogHealth.hasReport(operatorIdentity) && !toolCatalogHealth.hasReport(workerIdentity))
      return toolCatalogHealth.readPane(identity);
    try {
      const currentSettings = await settings();
      const worker = [
        "message_clankie",
        "message_clankie_status",
        ...((await options.projectHireTools?.(DEFAULT_PROJECT_ID)) ?? []),
        ...(currentSettings.fleet.peerMessages === "on" ? ["list_fleet_seats", "message_peer"] : []),
      ];
      const operator = toolCatalogHealth.hasReport(operatorIdentity)
        ? [
            ...(
              await laneToolBankFor("operator", toolCatalogHealth.conversationId(operatorIdentity))
            ).tools.map((tool) => tool.name),
            "reconcile_seat_call",
            "reply",
          ]
        : undefined;
      return toolCatalogHealth.readPane(identity, { worker, ...(operator ? { operator } : {}) });
    } catch (error) {
      const health = toolCatalogHealth.readPane(identity);
      return {
        ...health,
        status: "unverified" as const,
        missing: [],
        detail:
          `The current bridge catalog could not be read: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            4096,
          ),
      };
    }
  }

  return { recordNativeToolCatalog, observeCodexToolCatalog, catalogIdentity, currentCatalogHealth };
}
