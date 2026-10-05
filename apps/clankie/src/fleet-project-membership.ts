import { isDeepStrictEqual } from "node:util";
import { projectRoleForPersona, projectsRevision, resolveProjectMembership } from "@clankie/settings";
import {
  ReadFleetProjectMembershipSchema,
  FleetProjectMembershipSnapshotSchema,
  type ReadFleetProjectMembership,
  type FleetProjectMembershipSnapshot,
  type ProjectsSettings,
} from "@clankie/protocol/projects";
import type { HerdrBinding } from "@clankie/protocol";
import type { CaptainPort } from "./captain/port.ts";
import { occupantIdForHerdrSession, type HerdrCensusAgent } from "./captain/herdr-census.ts";
import type { ProjectProcessProof } from "./project-process-proof.ts";

export type MembershipAuthorization = true | "authentication_required" | "forbidden";
export class FleetMembershipReadError extends Error {
  readonly code: "busy" | "changed" | "unavailable" | "authentication_required" | "forbidden";
  constructor(code: FleetMembershipReadError["code"]) {
    super(code);
    this.code = code;
  }
}
type Seat = ReadFleetProjectMembership["seats"][number];
type Membership = FleetProjectMembershipSnapshot["seats"][number]["membership"];
type Candidate = ReturnType<CaptainPort["projectHireMembershipCandidate"]>;
interface Receipt {
  result: FleetProjectMembershipSnapshot;
  binding: HerdrBinding | undefined;
  candidates: { pane: string; value: Candidate }[];
  proofs: Map<string, ProjectProcessProof>;
  personas: Map<string, string | undefined>;
}
interface Batch {
  controller: AbortController;
  waiters: number;
  readers: number;
  result: Promise<Receipt>;
  settled: boolean;
  timer: ReturnType<typeof setTimeout>;
}
export interface FleetProjectMembershipOptions {
  settings(): Promise<ProjectsSettings>;
  binding(): Promise<HerdrBinding | undefined>;
  roster(binding: HerdrBinding, signal: AbortSignal): Promise<readonly HerdrCensusAgent[]>;
  observe(pane: string, binding: HerdrBinding, signal: AbortSignal): Promise<ProjectProcessProof | undefined>;
  hires: Pick<CaptainPort, "projectHireMembershipCandidate" | "confirmedProjectHireAssignment"> &
    Partial<Pick<CaptainPort, "personaForFleetOccupant">>;
  /** Deterministic deadline fixture; production uses five seconds for all native work. */
  deadlineMs?: number;
}
const unknown = (reason: Extract<Membership, { outcome: "unknown" }>["reason"]): Membership => ({
  outcome: "unknown",
  reason,
});
const tuple = (agent: HerdrCensusAgent) => [agent.paneId, agent.terminalId, agent.agent, agent.session];
const matches = (agent: HerdrCensusAgent, seat: Seat) =>
  agent.terminalId === seat.seatId &&
  agent.session !== undefined &&
  occupantIdForHerdrSession(agent.session) === seat.occupantId;

/** Separate from control/tool authority. No effects, adoption, transcript reads or result cache. */
export class FleetProjectMembership {
  private readonly batches = new Map<string, Batch>();
  private active = 0;
  private readonly queued = new Set<() => void>();
  private readonly options: FleetProjectMembershipOptions;
  constructor(options: FleetProjectMembershipOptions) {
    this.options = options;
  }

  /** Global across every batch. Capacity is held through observer/owned child cleanup. */
  private async permit(signal: AbortSignal): Promise<() => void> {
    while (this.active >= 4) {
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          this.queued.delete(wake);
          signal.removeEventListener("abort", abort);
        };
        const wake = () => {
          finish();
          resolve();
        };
        const abort = () => {
          finish();
          reject(signal.reason);
        };
        this.queued.add(wake);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    signal.throwIfAborted();
    this.active++;
    return () => {
      this.active--;
      for (const wake of this.queued) wake();
    };
  }

  private async observeRoster(
    binding: HerdrBinding,
    signal: AbortSignal,
  ): Promise<readonly HerdrCensusAgent[]> {
    const release = await this.permit(signal);
    try {
      return await this.options.roster(binding, signal);
    } finally {
      release();
    }
  }

  private async collect(
    input: ReadFleetProjectMembership,
    settings: ProjectsSettings,
    binding: HerdrBinding | undefined,
    controller: AbortController,
  ): Promise<Receipt> {
    const signal = controller.signal;
    const candidates: Receipt["candidates"] = [];
    const proofs: Receipt["proofs"] = new Map();
    const personas: Receipt["personas"] = new Map();
    const rows = input.seats.map((seat) => ({ ...seat, membership: unknown("observation_unavailable") }));
    try {
      signal.throwIfAborted();
      if (!binding) {
        rows.forEach((row) => {
          row.membership = unknown("unsupported_host");
        });
      } else if (rows.every((row) => row.fleet !== undefined && row.fleet !== "default")) {
        rows.forEach((row) => {
          row.membership = unknown("unsupported_host");
        });
      } else {
        const local = await this.observeRoster(binding, signal);
        signal.throwIfAborted();
        const outcomes = await Promise.allSettled(
          rows.map(async (row) => {
            if (row.fleet !== undefined && row.fleet !== "default") {
              row.membership = unknown("unsupported_host");
              return;
            }
            const sameSeat = local.filter((agent) => agent.terminalId === row.seatId);
            const agent = sameSeat.length === 1 ? sameSeat[0] : undefined;
            if (
              !agent ||
              !matches(agent, row) ||
              agent.status === "offline" ||
              local.filter((other) => other.paneId === agent.paneId).length !== 1
            ) {
              row.membership = unknown("identity_changed");
              return;
            }
            const candidate = this.options.hires.projectHireMembershipCandidate("default", agent.paneId);
            candidates.push({ pane: agent.paneId, value: candidate });
            if (candidate.state !== "confirmed") {
              row.membership = unknown("no_confirmed_hire");
              return;
            }
            if (
              candidate.seat !== row.seatId ||
              candidate.nativeOccupantId !== row.occupantId ||
              candidate.harness !== agent.agent
            ) {
              row.membership = unknown("identity_changed");
              return;
            }
            if (!candidate.generic) return; // Prepared direct roots need an independent original observer.
            let release: (() => void) | undefined;
            try {
              release = await this.permit(signal);
              const proof = await this.options.observe(agent.paneId, binding, signal);
              signal.throwIfAborted();
              if (
                !proof ||
                proof.nativeSessionPending ||
                proof.privateSeat ||
                proof.workspace ||
                proof.fleet !== "default" ||
                proof.pane !== agent.paneId ||
                proof.nativeOccupantId !== row.occupantId ||
                proof.binding.socketPath !== binding.socketPath ||
                proof.binding.session !== binding.session ||
                proof.shell.pid === proof.processes[0]?.pid
              )
                return;
              const assignment = this.options.hires.confirmedProjectHireAssignment(
                "default",
                agent.paneId,
                candidate.revision,
                proof,
              );
              if (assignment.state !== "assigned") {
                row.membership = unknown("invalid_assignment");
                return;
              }
              const membership = resolveProjectMembership(settings, {
                occupantId: assignment.occupantId,
                hire: assignment,
              });
              if (membership.outcome !== "member") {
                row.membership = unknown("invalid_assignment");
                return;
              }
              proofs.set(agent.paneId, proof);
              const personaId = this.options.hires.personaForFleetOccupant?.(row.seatId, row.occupantId);
              personas.set(row.seatId, personaId);
              // Identity is host-bound only after native membership has been proven.
              // A cleared canonical role must not resurrect the immutable hire profile.
              const role =
                this.options.hires.personaForFleetOccupant === undefined
                  ? membership.role
                  : personaId === undefined
                    ? undefined
                    : projectRoleForPersona(settings, personaId, membership.projectId);
              row.membership = {
                outcome: "member",
                source: "hire",
                projectId: membership.projectId,
                ...(role === undefined ? {} : { role }),
              };
            } catch {
              row.membership = unknown(signal.aborted ? "timeout" : "observation_unavailable");
            } finally {
              release?.();
            }
          }),
        );
        if (outcomes.some((entry) => entry.status === "rejected"))
          throw new Error("Membership read unavailable");
        signal.throwIfAborted();
        const final = await this.observeRoster(binding, signal);
        signal.throwIfAborted();
        for (const row of rows) {
          const before = local.filter((agent) => agent.terminalId === row.seatId);
          const after = final.filter((agent) => agent.terminalId === row.seatId);
          if (
            row.membership.outcome === "member" &&
            (before.length !== 1 ||
              after.length !== 1 ||
              !isDeepStrictEqual(tuple(before[0]!), tuple(after[0]!)) ||
              after[0]!.status === "offline")
          )
            row.membership = unknown("identity_changed");
        }
      }
    } catch {
      // A missing final shared census invalidates every positive, never an empty success.
      for (const row of rows)
        row.membership = unknown(signal.aborted ? "timeout" : "observation_unavailable");
    }
    return {
      binding,
      candidates,
      proofs,
      personas,
      result: FleetProjectMembershipSnapshotSchema.parse({
        schemaVersion: 1,
        projectsRevision: projectsRevision(settings),
        observedAt: new Date().toISOString(),
        seats: rows,
      }),
    };
  }

  async read(
    value: ReadFleetProjectMembership,
    signal: AbortSignal,
    authorize: () => Promise<MembershipAuthorization>,
  ): Promise<FleetProjectMembershipSnapshot> {
    const auth = async () => {
      signal.throwIfAborted();
      const result = await authorize();
      signal.throwIfAborted();
      if (result !== true) throw new FleetMembershipReadError(result);
    };
    await auth();
    const input = ReadFleetProjectMembershipSchema.parse(value);
    const [settings, binding] = await Promise.all([this.options.settings(), this.options.binding()]);
    signal.throwIfAborted();
    const key = JSON.stringify([input, projectsRevision(settings), binding]);
    let batch = this.batches.get(key);
    if (batch?.controller.signal.aborted) throw new FleetMembershipReadError("busy");
    if (!batch) {
      if (this.batches.size >= 4) throw new FleetMembershipReadError("busy");
      const controller = new AbortController();
      batch = {
        controller,
        waiters: 0,
        readers: 0,
        settled: false,
        timer: setTimeout(
          () => controller.abort(new Error("Membership deadline")),
          this.options.deadlineMs ?? 5000,
        ),
        result: this.collect(input, settings, binding, controller),
      };
      this.batches.set(key, batch);
      const selected = batch;
      // Deletion waits for all owned native tasks to settle, including abort cleanup.
      const settled = () => {
        selected.settled = true;
        if (selected.readers === 0) {
          clearTimeout(selected.timer);
          if (this.batches.get(key) === selected) this.batches.delete(key);
        }
      };
      void batch.result.then(settled, settled);
    }
    if (batch.readers >= 32) throw new FleetMembershipReadError("busy");
    batch.waiters++;
    batch.readers++;
    let attached = true;
    const detach = () => {
      if (!attached) return;
      attached = false;
      batch.waiters--;
      if (batch.waiters === 0) {
        batch.controller.abort(new Error("No membership readers"));
      }
    };
    signal.addEventListener("abort", detach, { once: true });
    try {
      if (signal.aborted) detach();
      // Do not race/abandon native work. Its signal-aware children settle before release.
      const receipt = await batch.result;
      await auth();
      // A waiter may have been held in authorization after shared proof completion.
      // Re-read its current native roster; this is not cached from the shared batch.
      if (receipt.binding && receipt.result.seats.some((row) => row.membership.outcome === "member")) {
        const publicationSignal = AbortSignal.any([signal, batch.controller.signal]);
        const finalObservations = await Promise.allSettled(
          receipt.result.seats
            .filter((row) => row.membership.outcome === "member")
            .map(async (row) => {
              const candidate = receipt.candidates.find(
                (entry) => entry.value.state === "confirmed" && entry.value.seat === row.seatId,
              );
              if (!candidate || candidate.value.state !== "confirmed")
                throw new FleetMembershipReadError("changed");
              const release = await this.permit(publicationSignal);
              try {
                const finalProof = await this.options.observe(
                  candidate.pane,
                  receipt.binding!,
                  publicationSignal,
                );
                publicationSignal.throwIfAborted();
                if (!isDeepStrictEqual(finalProof, receipt.proofs.get(candidate.pane)))
                  throw new FleetMembershipReadError("changed");
              } finally {
                release();
              }
            }),
        );
        if (finalObservations.some((entry) => entry.status === "rejected"))
          throw new FleetMembershipReadError("changed");
        const release = await this.permit(publicationSignal);
        try {
          const current = await this.options.roster(receipt.binding, publicationSignal);
          publicationSignal.throwIfAborted();
          for (const row of receipt.result.seats) {
            if (row.membership.outcome !== "member") continue;
            const matchesSeat = current.filter((agent) => agent.terminalId === row.seatId);
            const candidate = receipt.candidates.find(
              (entry) => entry.value.state === "confirmed" && entry.value.seat === row.seatId,
            );
            if (
              matchesSeat.length !== 1 ||
              !matches(matchesSeat[0]!, row) ||
              matchesSeat[0]!.status === "offline" ||
              candidate?.value.state !== "confirmed" ||
              matchesSeat[0]!.paneId !== candidate.pane ||
              matchesSeat[0]!.agent !== candidate.value.harness
            )
              throw new FleetMembershipReadError("changed");
          }
        } finally {
          release();
        }
      }
      await auth();
      const [latest, currentBinding] = await Promise.all([this.options.settings(), this.options.binding()]);
      signal.throwIfAborted();
      if (
        projectsRevision(latest) !== receipt.result.projectsRevision ||
        !isDeepStrictEqual(currentBinding, receipt.binding)
      )
        throw new FleetMembershipReadError("changed");
      if (
        receipt.candidates.some(
          ({ pane, value: candidate }) =>
            !isDeepStrictEqual(this.options.hires.projectHireMembershipCandidate("default", pane), candidate),
        )
      )
        throw new FleetMembershipReadError("changed");
      if (
        receipt.result.seats.some(
          (row) =>
            row.membership.outcome === "member" &&
            this.options.hires.personaForFleetOccupant?.(row.seatId, row.occupantId) !==
              receipt.personas.get(row.seatId),
        )
      )
        throw new FleetMembershipReadError("changed");
      if (receipt.result.seats.some((row) => row.membership.outcome === "member"))
        batch.controller.signal.throwIfAborted();
      // Publication is a bracketed observation, not an atomic process/authority lease.
      return receipt.result;
    } finally {
      signal.removeEventListener("abort", detach);
      detach();
      batch.readers--;
      if (batch.readers === 0 && batch.settled) {
        clearTimeout(batch.timer);
        if (this.batches.get(key) === batch) this.batches.delete(key);
      }
    }
  }
}
