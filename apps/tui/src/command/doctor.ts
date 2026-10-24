import {
  DiscordRoomVoiceStatusSchema,
  DiscordRoomsSnapshotSchema,
  type DiscordVoiceStayPipelines,
  DISCORD_ROOM_VOICE_PATH,
  DISCORD_ROOMS_PATH,
  formatAutonomyDrift,
  parseProtocolResponse,
} from "@clankie/protocol";
import { z } from "zod";
import { MachineAccessRefusalSchema } from "@clankie/protocol";
import { JoinedShellAuditSchema } from "@clankie/protocol/machine-join";
import { runMachinesCommand } from "./machines.ts";
import {
  CheckoutReportSchema,
  FleetSimulatorStatusSchema,
  type FleetSimulatorStatus,
} from "@clankie/protocol";
import { runCheckoutsCommand } from "./checkouts.ts";
import { FleetHealthMetricsSnapshotSchema, FLEET_HEALTH_METRICS_PATH } from "@clankie/protocol";
import {
  FLEET_TOOL_CATALOG_HEALTH_PATH,
  FleetToolCatalogHealthPageSchema,
} from "@clankie/protocol/tool-catalog";
import {
  createDefaultCredentialStore,
  resolveOperatorCredential,
  resolveCaptainCredential,
} from "@clankie/credential-broker";
import { commandHost } from "./io.ts";
import { runRuntimeCommand } from "./runtime.ts";
import { readWorkingPreferences } from "./working-preferences.ts";
import { runResourceStatusCommand, runSimulatorCommand } from "./fleet-resources.ts";
import { formatSeatDeliveryAge, readSeatDeliveries, readSeatBridges } from "./seat-delivery.ts";
import { summarizeRecovery } from "../../bin/service-recovery.ts";
import { inspectAutostartNode } from "./autostart.ts";
import {
  createCaptainOperatorConversationClient,
  createCaptainRouteClient,
} from "../session/operator-conversations.ts";
import {
  inspectInstall,
  type ExecFileImpl,
  type InspectInstallOptions,
  type InstallDoctorReport,
} from "../install-doctor.ts";
import { EVIDENCE_STATUS_PATH, EvidenceStoreStatusSchema } from "@clankie/protocol/evidence";
import {
  LINEAR_REQUEST_BUDGET_PATH,
  LinearRequestBudgetReportSchema,
} from "@clankie/protocol/linear-request-budget";

export type { ExecFileImpl, InstallDoctorReport };

/** Readiness first; optional rooms never hide the reason a first turn fails. */
export function formatDoctorSummary(report: InstallDoctorReport): string {
  const summary = doctorSummary(report);
  return report.autonomy?.drift === undefined
    ? summary
    : `${summary}\n${formatAutonomyDrift(report.autonomy.drift)}`;
}

/** An ended call stays on the card's detail line; only a live or just-ended one is the next step. */
const RECENT_VOICE_CALL_MS = 60 * 60_000;

function brokenVoiceCall(stay: DiscordVoiceStayPipelines | undefined): string | undefined {
  if (stay === undefined) return undefined;
  if (stay.endedAt !== undefined && Date.now() - Date.parse(stay.endedAt) > RECENT_VOICE_CALL_MS)
    return undefined;
  const legs = [
    ...(stay.hearing.state === "broken" ? [{ verb: "hear", pipeline: stay.hearing }] : []),
    ...(stay.answering.state === "broken" ? [{ verb: "answer", pipeline: stay.answering }] : []),
  ];
  if (legs.length === 0) return undefined;
  const providerCode = legs.find((leg) => leg.pipeline.lastLoss?.providerCode)?.pipeline.lastLoss
    ?.providerCode;
  return `${stay.endedAt === undefined ? "Clankie's Discord call" : "Clankie's last Discord call"} could not ${legs.map((leg) => leg.verb).join(" or ")}: ${providerCode === undefined ? "the voice provider's session was lost" : `the voice provider ended its session with ${providerCode}`} — run \`clankie discord call\`.`;
}

function doctorSummary(report: InstallDoctorReport): string {
  if (report.credentialStoreHealth?.state !== undefined && report.credentialStoreHealth.state !== "ready")
    return report.credentialStoreHealth.message ?? "Keychain unavailable";
  const refusal =
    report.machineAccessRefusals && "refusals" in report.machineAccessRefusals
      ? report.machineAccessRefusals.refusals[0]
      : undefined;
  if (refusal)
    return `Machine ${refusal.machine} refused ${refusal.required} access (${refusal.accessLevel}). ${refusal.fix}`;
  const unavailableBridge =
    report.seatBridges && "bridges" in report.seatBridges
      ? report.seatBridges.bridges.find((bridge) => bridge.state !== "current")
      : undefined;
  if (unavailableBridge?.state === "stale")
    return `Stale seat bridge for ${unavailableBridge.conversationId}. ${unavailableBridge.detail}`;
  if (unavailableBridge)
    return `Seat bridge ${unavailableBridge.state} for ${unavailableBridge.conversationId}. ${unavailableBridge.detail}`;
  if (!report.captain.ready) {
    return report.captain.reason === "no_model"
      ? "Choose a model — run `clankie`, then `/setup`."
      : `Sign in to ${report.captain.providerId} — run \`clankie\`, then \`/setup\`.`;
  }
  const endpoint = report.selectedModel?.endpoint;
  if (endpoint && (!endpoint.reachable || !endpoint.declaresModel)) {
    return `The selected model ${report.model} is unavailable — run \`clankie\`, then \`/setup\` to choose a working model.`;
  }
  if (endpoint?.authRequired && !endpoint.credentialStored) {
    return `The selected model needs a key — run \`clankie\`, then \`/auth ${report.selectedModel?.providerId}\`.`;
  }
  const stopped = report.serviceRecovery?.find((service) => service.state === "gave_up");
  if (stopped !== undefined) {
    return `${stopped.id} crashed ${String(stopped.crashes)} times and crash recovery left it stopped (${stopped.lastError}) — run \`clankie restart\`.`;
  }
  if (report.autostart?.executable === false)
    return `Autostart runs ${report.autostart.node}, which no longer exists, so Clankie will not start or recover — run \`clankie autostart enable\`.`;
  if (report.autostart?.stable !== undefined)
    return `Autostart pins ${report.autostart.node}; a Node upgrade removes it — run \`clankie autostart enable\` to use ${report.autostart.stable}.`;
  if (report.doorway.state === "unreachable") {
    return "Clankie is not answering — run `clankie`.";
  }
  if (report.doorway.state === "sign_in_required") {
    return "Phone access is signed out — run `clankie remote-access on`.";
  }
  if (report.doorway.state === "unavailable") {
    return "Phone access has no connection — run `clankie restart`.";
  }
  if (report.doorway.state === "connecting") {
    return "Phone access is still connecting — run `clankie gateway status` to check again.";
  }
  if (report.runtimeHealth?.state === "alarm")
    return `Runtime health alarm (${report.runtimeHealth.reasons.join(" and ")}) — run \`clankie runtime-health status\`.`;
  const unresolved =
    report.seatDeliveries && "unresolved" in report.seatDeliveries
      ? report.seatDeliveries.unresolved[0]
      : undefined;
  if (unresolved)
    return `Seat delivery ${unresolved.receiptId} to ${unresolved.conversationId} has been unresolved for ${formatSeatDeliveryAge(unresolved.ageMs)} — confirm the seat never received it, then run \`clankie seat-delivery settle ${unresolved.receiptId} abandoned-unknown --conversation ${unresolved.conversationId}\`.`;
  if (report.discordRoomDelivery && "rooms" in report.discordRoomDelivery) {
    const failed = report.discordRoomDelivery.rooms.filter((room) => (room.unrecoveredFailed ?? 0) > 0);
    if (failed.length > 0)
      return `${failed.reduce((count, room) => count + room.unrecoveredFailed!, 0)} Discord messages still need a reply or notice — run \`clankie discord rooms\`.`;
  }
  if (
    report.discordRoomDelivery &&
    "rooms" in report.discordRoomDelivery &&
    report.discordRoomDelivery.rooms.some(
      (room) => room.coverage === "observed" && room.unrecoveredFailed === undefined,
    )
  )
    return "Discord delivery recovery status unknown — run `clankie discord rooms`.";
  const brokenCall = brokenVoiceCall(report.discordVoice?.pipelines);
  if (brokenCall) return brokenCall;
  const remediation = report.remediations[0];
  const sourceSetup = report.harnessBridges.profiles.codex.sourceSetup;
  if (sourceSetup?.state === "source-manager-required") return `${sourceSetup.detail}. ${sourceSetup.fix}`;
  if (remediation !== undefined) {
    const line = remediation.replace(/\s+/gu, " ").trim();
    return line.includes("`") || line.includes("/discord")
      ? line
      : `${line} Run \`clankie\`, then \`/setup\`.`;
  }
  const budget = report.linearRequestBudget;
  const pressured =
    budget && "accounts" in budget
      ? budget.accounts.find((account) => account.status !== "normal")
      : undefined;
  if (pressured)
    return `Linear request budget is ${pressured.status} at ${Math.round(pressured.utilization * 100)}% — run \`clankie linear budget\`.`;
  const checkouts = report.checkouts;
  if (checkouts && "checkouts" in checkouts) {
    const stale = checkouts.checkouts.filter(
      (entry) => entry.outcome === "unavailable" || entry.behind || entry.ahead || entry.staleWorktrees,
    );
    if (stale.length)
      return (
        stale
          .map(
            (entry) =>
              `${entry.path}: ${entry.outcome === "unavailable" ? "unavailable" : `${entry.behind} behind, ${entry.ahead} ahead, ${entry.staleWorktrees} stale worktrees`}`,
          )
          .join("\n") + "\nRun `clankie checkouts sync` and the tidy action; local work is preserved."
      );
    // Unlanded work older than a day with no recorded decision is at risk of being forgotten.
    const forgotten = checkouts.checkouts.flatMap((entry) =>
      (entry.unreconciled ?? []).filter((tree) => !tree.decision && (tree.ageSeconds ?? 0) >= 86_400),
    );
    if (forgotten.length)
      return `${forgotten.length} worktrees hold unlanded or uncommitted work over a day old with no decision — land it, hand it to its owner, or record one with \`clankie checkouts decide\`.`;
  }
  return "ready";
}

/** Machine cards remain available verbatim via --json; observations are not tool acceptance. */
export function formatMachineDoctorSummary(report: Record<string, unknown>): string {
  const refusals = report.machineAccessRefusals as
    | { refusals?: import("@clankie/protocol").MachineAccessRefusal[] }
    | undefined;
  if (refusals?.refusals?.[0]) {
    const refusal = refusals.refusals[0];
    return `Machine ${refusal.machine} refused ${refusal.required} access (${refusal.accessLevel}). ${refusal.fix}`;
  }
  const harnesses = report.harnesses as
    | { codex?: { sourceSetup?: { state: string; detail?: string; fix?: string } } }
    | undefined;
  const sourceSetup = harnesses?.codex?.sourceSetup;
  if (sourceSetup?.state === "source-manager-required") return `${sourceSetup.detail}. ${sourceSetup.fix}`;
  const unavailable = [report.harnesses, report.membership].some(
    (card) => typeof card === "object" && card !== null && "status" in card && card.status === "unavailable",
  );
  return unavailable
    ? `Cannot inspect ${report.machine} — run \`clankie connections\` to repair its connection.`
    : "ready";
}

export async function doctorCommand(
  options: InspectInstallOptions & { cwd?: string; host?: string },
): Promise<InstallDoctorReport> {
  options = {
    ...options,
    credentialStore:
      options.credentialStore ?? createDefaultCredentialStore({ env: options.env ?? process.env }),
  };
  const [report, workerObservations, resources, simulators, checkouts, seatBridges, seatDeliveries] =
    await Promise.all([
      inspectInstall(options),
      inspectWorkerTools(options),
      inspectResources(options),
      inspectSimulators(options),
      runCheckoutsCommand(["status"], {
        ...options,
        ...(options.credentialStore ? { operatorCredentialStore: options.credentialStore } : {}),
      })
        .then((value) => CheckoutReportSchema.parse(value))
        .catch(() => ({
          status: "unavailable" as const,
          detail: "Checkout status unavailable; run clankie checkouts status",
        })),
      readSeatBridges({
        ...options,
        ...(options.credentialStore ? { captainCredentialStore: options.credentialStore } : {}),
        timeoutMs: 5_000,
      }).then(
        (bridges) => ({ bridges }),
        (error: unknown) => ({
          status: "unavailable" as const,
          detail: error instanceof Error ? error.message : String(error),
        }),
      ),
      readSeatDeliveries({
        ...options,
        ...(options.credentialStore ? { captainCredentialStore: options.credentialStore } : {}),
        timeoutMs: 5_000,
      }).then(
        (unresolved) => ({ unresolved }),
        (error: unknown) => ({
          status: "unavailable" as const,
          detail: error instanceof Error ? error.message : String(error),
        }),
      ),
    ]);
  const { workerTools, workerReports } = workerObservations;
  const serviceRecovery = summarizeRecovery(options.env ?? process.env);
  const autostart =
    process.platform === "darwin"
      ? // allow-swallowed-rejection -- an unreadable login agent only omits this optional check from the card
        await inspectAutostartNode({ env: options.env ?? process.env }).catch(() => undefined)
      : undefined;
  const workingPreferences = await readWorkingPreferences({
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.credentialStore === undefined ? {} : { operatorCredentialStore: options.credentialStore }),
  });
  let discordRoomDelivery: InstallDoctorReport["discordRoomDelivery"];
  try {
    const credential = await resolveOperatorCredential({
      env: options.env ?? process.env,
      ...(options.credentialStore ? { store: options.credentialStore } : {}),
    });
    if (!credential) throw new Error("Discord room health needs the operator credential");
    const response = await (options.fetchImpl ?? fetch)(`${commandHost(options)}${DISCORD_ROOMS_PATH}`, {
      headers: { authorization: `Bearer ${credential.token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Discord room health unavailable (HTTP ${response.status})`);
    discordRoomDelivery = DiscordRoomsSnapshotSchema.parse(await response.json());
  } catch (error) {
    discordRoomDelivery = {
      status: "unavailable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  let discordVoice: InstallDoctorReport["discordVoice"];
  try {
    const credential = await resolveOperatorCredential({
      env: options.env ?? process.env,
      ...(options.credentialStore ? { store: options.credentialStore } : {}),
    });
    if (credential) {
      const response = await (options.fetchImpl ?? fetch)(
        `${commandHost(options)}${DISCORD_ROOM_VOICE_PATH}`,
        {
          headers: { authorization: `Bearer ${credential.token}` },
          signal: AbortSignal.timeout(5_000),
        },
      );
      // Without a Discord body the route answers 503 and the card has no voice line.
      if (response.ok)
        discordVoice = parseProtocolResponse(DiscordRoomVoiceStatusSchema, await response.json());
    }
  } catch {
    /* An old or unreachable service has no voice observation. */
  }
  let fleetHealthMetrics: InstallDoctorReport["fleetHealthMetrics"];
  try {
    const credential = await resolveOperatorCredential({
      env: options.env ?? process.env,
      ...(options.credentialStore ? { store: options.credentialStore } : {}),
    });
    if (credential) {
      const response = await (options.fetchImpl ?? fetch)(
        `${commandHost(options)}${FLEET_HEALTH_METRICS_PATH}`,
        {
          headers: { authorization: `Bearer ${credential.token}` },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (response.ok) fleetHealthMetrics = FleetHealthMetricsSnapshotSchema.parse(await response.json());
    }
  } catch {
    /* An old or unreachable service has no metrics observation. */
  }
  let toolCatalogHealth: NonNullable<InstallDoctorReport["toolCatalogHealth"]>;
  try {
    const credential = await resolveOperatorCredential({
      env: options.env ?? process.env,
      ...(options.credentialStore ? { store: options.credentialStore } : {}),
    });
    if (!credential) throw new Error("Native tool catalog health needs the operator credential");
    const response = await (options.fetchImpl ?? fetch)(
      `${commandHost(options)}${FLEET_TOOL_CATALOG_HEALTH_PATH}`,
      {
        headers: { authorization: `Bearer ${credential.token}` },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) throw new Error(`Native tool catalog health unavailable (HTTP ${response.status})`);
    toolCatalogHealth = FleetToolCatalogHealthPageSchema.parse(await response.json());
  } catch (error) {
    toolCatalogHealth = {
      status: "unavailable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  let evidenceStore: NonNullable<InstallDoctorReport["evidenceStore"]>;
  try {
    const credential = await resolveOperatorCredential({
      env: options.env ?? process.env,
      ...(options.credentialStore ? { store: options.credentialStore } : {}),
    });
    if (!credential) throw new Error("Evidence store status needs the operator credential");
    const response = await (options.fetchImpl ?? fetch)(`${commandHost(options)}${EVIDENCE_STATUS_PATH}`, {
      headers: { authorization: `Bearer ${credential.token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Evidence store unavailable (HTTP ${response.status})`);
    evidenceStore = EvidenceStoreStatusSchema.parse(await response.json());
  } catch (error) {
    evidenceStore = {
      status: "unavailable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  let remoteHarnesses: readonly unknown[];
  let linearRequestBudget: NonNullable<InstallDoctorReport["linearRequestBudget"]>;
  try {
    const credential = await resolveOperatorCredential({
      env: options.env ?? process.env,
      ...(options.credentialStore ? { store: options.credentialStore } : {}),
    });
    if (!credential) throw new Error("Linear request budget needs the operator credential");
    const response = await (options.fetchImpl ?? fetch)(
      `${commandHost(options)}${LINEAR_REQUEST_BUDGET_PATH}`,
      {
        headers: { authorization: `Bearer ${credential.token}` },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!response.ok) throw new Error(`Linear request budget unavailable (HTTP ${response.status})`);
    linearRequestBudget = LinearRequestBudgetReportSchema.parse(await response.json());
  } catch (error) {
    linearRequestBudget = {
      status: "unavailable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const inventory = await runRuntimeCommand(["list"], options);
    const fleets = Array.isArray(inventory.connections)
      ? inventory.connections.filter(
          (entry: { id?: unknown; ssh?: unknown }) => typeof entry.id === "string" && entry.ssh,
        )
      : [];
    remoteHarnesses = await Promise.all(
      fleets.map(async (fleet: { id: string; linkState?: unknown }) => {
        const link = fleet.linkState === undefined ? {} : { linkState: fleet.linkState };
        try {
          return { ...(await runRuntimeCommand(["harnesses", fleet.id], options)), ...link };
        } catch (error) {
          return {
            machine: fleet.id,
            status: "unavailable",
            detail: error instanceof Error ? error.message : String(error),
            ...link,
          };
        }
      }),
    );
  } catch (error) {
    remoteHarnesses = [
      { status: "unavailable", detail: error instanceof Error ? error.message : String(error) },
    ];
  }
  return {
    ...report,
    ...(options.credentialStore?.health ? { credentialStoreHealth: options.credentialStore.health() } : {}),
    machineAccessRefusals: await inspectMachineAccessRefusals({
      ...options,
      ...(options.credentialStore ? { operatorCredentialStore: options.credentialStore } : {}),
    }),
    joinedShellAudit: await inspectJoinedShellAudit({
      ...options,
      ...(options.credentialStore ? { operatorCredentialStore: options.credentialStore } : {}),
    }),
    remoteHarnesses,
    discordRoomDelivery,
    ...(discordVoice === undefined ? {} : { discordVoice }),
    toolCatalogHealth,
    workerTools,
    workerReports,
    seatDeliveries,
    seatBridges,
    workingPreferences,
    resources,
    ...(simulators === undefined ? {} : { simulators }),
    checkouts,
    ...(fleetHealthMetrics === undefined ? {} : { fleetHealthMetrics }),
    linearRequestBudget,
    evidenceStore,
    ...(serviceRecovery.length === 0 ? {} : { serviceRecovery }),
    ...(autostart === undefined ? {} : { autostart }),
  };
}

async function inspectResources(
  options: InspectInstallOptions & { host?: string },
): Promise<NonNullable<InstallDoctorReport["resources"]>> {
  try {
    return await runResourceStatusCommand({
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.credentialStore === undefined ? {} : { operatorCredentialStore: options.credentialStore }),
    });
  } catch {
    // A legacy service, invalid response or missing credential must not hide
    // the install's model, account and tool diagnostics or echo response data.
    return {
      status: "unavailable",
      detail: "Fleet resource status unavailable; run `clankie fleet resources` to retry.",
    };
  }
}

/** Optional: a legacy service or missing inventory leaves the resource lines alone. */
async function inspectSimulators(
  options: InspectInstallOptions & { host?: string },
): Promise<FleetSimulatorStatus | undefined> {
  try {
    return FleetSimulatorStatusSchema.parse(
      await runSimulatorCommand(["status"], {
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.host === undefined ? {} : { host: options.host }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(options.credentialStore === undefined
          ? {}
          : { operatorCredentialStore: options.credentialStore }),
      }),
    );
  } catch {
    return undefined;
  }
}

async function inspectWorkerTools(options: InspectInstallOptions): Promise<{
  workerTools: NonNullable<InstallDoctorReport["workerTools"]>;
  workerReports: NonNullable<InstallDoctorReport["workerReports"]>;
}> {
  try {
    const credential = await resolveCaptainCredential({
      env: options.env ?? process.env,
      ...(options.credentialStore === undefined ? {} : { store: options.credentialStore }),
    });
    if (!credential) throw new Error("Worker tool observations need the captain credential");
    const client = createCaptainOperatorConversationClient(
      createCaptainRouteClient({
        host: commandHost(options),
        captainToken: credential.token,
        fetchImpl: (input, init) =>
          (options.fetchImpl ?? fetch)(input, { ...init, signal: AbortSignal.timeout(5_000) }),
      }),
    );
    const seats = await client.roster();
    return {
      workerTools: {
        workers: seats.map((seat) => ({
          seatId: seat.seatId,
          title: seat.title,
          ...(seat.fleet === undefined ? {} : { fleet: seat.fleet }),
          ...(seat.workerTools ?? {
            status: "not-observed" as const,
            reason: "No authenticated worker tool observation; native catalog is unverified.",
          }),
        })),
      },
      workerReports: {
        workers: seats.map((seat) => ({
          seatId: seat.seatId,
          title: seat.title,
          ...(seat.fleet === undefined ? {} : { fleet: seat.fleet }),
          ...(seat.workerReportBridge === undefined ? {} : { report: seat.workerReportBridge }),
          flags: (seat.efficiency?.flags ?? []).filter((flag) => flag === "finished, unreported"),
        })),
      },
    };
  } catch (error) {
    const failure = { workers: [], error: error instanceof Error ? error.message : String(error) };
    return { workerTools: failure, workerReports: failure };
  }
}

/** Inspect only the selected registered machine; no local executable/config probes. */
export async function machineDoctorCommand(
  machine: string,
  options: Parameters<typeof runRuntimeCommand>[1] = {},
): Promise<Record<string, unknown>> {
  const results = await Promise.allSettled([
    runRuntimeCommand(["harnesses", machine], options),
    runRuntimeCommand(["membership", machine], options),
    runRuntimeCommand(["list"], options),
  ]);
  const value = (result: PromiseSettledResult<Record<string, unknown>>) =>
    result.status === "fulfilled"
      ? result.value
      : {
          status: "unavailable",
          detail: result.reason instanceof Error ? result.reason.message : String(result.reason),
        };
  const inventory = results[2]!;
  const connection =
    inventory.status === "fulfilled" && Array.isArray(inventory.value.connections)
      ? inventory.value.connections.find((entry: { id?: unknown }) => entry.id === machine)
      : undefined;
  return {
    machine,
    machineAccessRefusals: await inspectMachineAccessRefusals(options, connection?.machine ?? machine),
    harnesses: results[0]!.status === "fulfilled" ? results[0]!.value.harnesses : value(results[0]!),
    membership: value(results[1]!),
    ...(inventory.status === "rejected"
      ? { linkState: value(inventory) }
      : connection?.linkState === undefined
        ? {}
        : { linkState: connection.linkState }),
  };
}

/** Clankie's own recent shell calls on joined machines, for the owner to read. */
async function inspectJoinedShellAudit(options: Parameters<typeof runMachinesCommand>[1]) {
  try {
    const { entries } = JoinedShellAuditSchema.parse(await runMachinesCommand(["shell-audit"], options));
    return { entries: entries.slice(-20) };
  } catch (error) {
    return { status: "unavailable" as const, detail: String(error) };
  }
}

async function inspectMachineAccessRefusals(
  options: Parameters<typeof runMachinesCommand>[1],
  machine?: string,
) {
  try {
    const report = z
      .object({ refusals: z.array(MachineAccessRefusalSchema) })
      .parse(await runMachinesCommand(["access-refusals"], options));
    return {
      refusals: report.refusals.filter((record) => machine === undefined || record.machine === machine),
    };
  } catch (error) {
    return { status: "unavailable" as const, detail: String(error) };
  }
}
