import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  effectiveHireProfile,
  type HireProfile,
  operatorAgentRoleKey,
  SpawnOperatorSeatSchema,
  type SpawnOperatorSeat,
} from "@clankie/protocol";
import { projectRolePolicy, type ProjectsSettings } from "@clankie/protocol/projects";

const ProcessSchema = z.object({ pid: z.number().int().positive(), startTime: z.string().min(1) }).strict();
const ProofSchema = z
  .object({
    nativeOccupantId: z.string().min(1),
    fleet: z.string(),
    pane: z.string(),
    binding: z.object({ socketPath: z.string(), session: z.string().optional() }).strict(),
    processes: z.array(ProcessSchema).min(1),
    shell: ProcessSchema,
  })
  .strict();
export interface ProjectHireProcessProof {
  readonly nativeOccupantId: string;
  readonly fleet: string;
  readonly pane: string;
  readonly binding: { readonly socketPath: string; readonly session?: string };
  readonly processes: readonly { readonly pid: number; readonly startTime: string }[];
  readonly shell: { readonly pid: number; readonly startTime: string };
}
const AllocationSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    projectId: z.string(),
    role: z.string().optional(),
    policy: z.string(),
    request: SpawnOperatorSeatSchema,
    started: z.boolean(),
    pane: z.string().optional(),
    seat: z.string().optional(),
    occupantId: z.string().optional(),
    proof: ProofSchema.optional(),
    confirmed: z.boolean().default(false),
    gone: z.boolean().default(false),
  })
  .strict();
type Allocation = z.infer<typeof AllocationSchema>;
const StateSchema = z.object({ version: z.literal(1), allocations: z.array(AllocationSchema) }).strict();
export type ProjectHireAssignment =
  | { state: "none" }
  | { state: "invalid" }
  | { state: "assigned"; projectId: string; role?: string; occupantId: string };

/** Private display-read snapshot; never sent over HTTP or accepted from callers. */
export type ProjectHireMembershipCandidate =
  | { state: "none" | "unconfirmed" }
  | {
      state: "confirmed";
      revision: string;
      seat: string;
      nativeOccupantId: string;
      harness: string;
      generic: boolean;
    };

/** Controller state: semantic persona assignments cannot create, finish or release these claims. */
export class ProjectHires {
  private readonly path: string;
  public constructor(path: string) {
    this.path = path;
  }
  private read(): z.infer<typeof StateSchema> {
    return existsSync(this.path)
      ? StateSchema.parse(JSON.parse(readFileSync(this.path, "utf8")))
      : { version: 1, allocations: [] };
  }
  private change<T>(update: (state: z.infer<typeof StateSchema>) => T): T {
    mkdirSync(dirname(this.path), { recursive: true });
    // A second controller fails closed rather than racing a stale snapshot. No async work holds this lock.
    let lock: number;
    try {
      lock = openSync(`${this.path}.lock`, "wx", 0o600);
    } catch {
      throw new Error("Project hiring is busy or needs recovery. No new agent was started.");
    }
    try {
      const state = this.read();
      const result = update(state);
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      const file = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(file, `${JSON.stringify(StateSchema.parse(state))}\n`);
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      renameSync(temporary, this.path);
      const directory = openSync(dirname(this.path), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      return result;
    } finally {
      closeSync(lock);
      unlinkSync(`${this.path}.lock`);
    }
  }
  public unresolved(input: SpawnOperatorSeat): boolean {
    return this.read().allocations.some(
      (a) =>
        !a.gone &&
        !a.confirmed &&
        (a.request.fleet ?? "default") === (input.fleet ?? "default") &&
        a.request.workingDirectory === input.workingDirectory,
    );
  }
  public reserve(
    settings: ProjectsSettings,
    projectId: string,
    input: SpawnOperatorSeat,
    defaults: HireProfile = {},
  ): Allocation & { reused: boolean } {
    // Policy changes must not produce a different retry key and a second native job.
    const key = JSON.stringify([input.fleet ?? "default", input.workingDirectory]);
    return this.change((state) => {
      const pending = state.allocations.find((a) => a.key === key && !a.gone && !a.confirmed);
      if (pending) {
        if (
          pending.projectId !== projectId ||
          operatorAgentRoleKey(pending.role ?? "") !== operatorAgentRoleKey(input.role ?? "") ||
          pending.request.deliverable !== input.deliverable
        )
          throw new Error(
            "An earlier hire in this workspace is still being checked. Resolve it before hiring again.",
          );
        return { ...structuredClone(pending), reused: true };
      }
      const request = projectHireRequest(settings, projectId, input, defaults);
      this.checkDeliverable(state.allocations, projectId, request);
      this.checkCaps(state.allocations, settings, projectId, request.role);
      const allocation: Allocation = {
        id: randomUUID(),
        key,
        projectId,
        ...(request.role === undefined ? {} : { role: request.role }),
        request,
        policy: launchPolicy(settings, projectId, request.role),
        started: false,
        confirmed: false,
        gone: false,
      };
      state.allocations.push(allocation);
      return { ...structuredClone(allocation), reused: false };
    });
  }
  public reuse(
    settings: ProjectsSettings,
    projectId: string,
    input: SpawnOperatorSeat,
    native: { pane: string; seat: string; occupantId: string },
  ): (Allocation & { reused: boolean }) | undefined {
    const allocation = this.read().allocations.find(
      (a) =>
        !a.gone &&
        a.confirmed &&
        a.pane === native.pane &&
        a.seat === native.seat &&
        a.occupantId === native.occupantId &&
        (a.request.fleet ?? "default") === (input.fleet ?? "default"),
    );
    if (!allocation) return undefined;
    if (
      allocation.projectId !== projectId ||
      (input.role !== undefined &&
        operatorAgentRoleKey(input.role) !== operatorAgentRoleKey(allocation.role ?? ""))
    )
      throw new Error(
        "This running agent belongs to a different project or role. Reuse its existing conversation.",
      );
    projectHireRequest(settings, projectId, allocation.request);
    if (launchPolicy(settings, projectId, allocation.role) !== allocation.policy)
      throw new Error(
        "This running agent uses earlier role settings. Message it directly or close it before hiring with the new settings.",
      );
    const request = { ...allocation.request, resume: input.resume };
    delete request.model;
    delete request.effort;
    return { ...allocation, request, reused: false };
  }
  private checkDeliverable(
    allocations: Allocation[],
    projectId: string,
    request: SpawnOperatorSeat,
    excluding?: string,
  ): void {
    if (request.delegation === "native-first" && !request.deliverable)
      throw new Error(
        "Native-first hiring requires a stable deliverable key (for example the issue ID). Its slices belong to the worker's native subagents.",
      );
    if (
      request.deliverable &&
      allocations.some(
        (a) =>
          !a.gone &&
          a.id !== excluding &&
          a.projectId === projectId &&
          a.request.deliverable === request.deliverable &&
          (a.request.delegation === "native-first" || request.delegation === "native-first"),
      )
    )
      throw new Error(
        `Deliverable ${request.deliverable} already has a pane under native-first delegation. Message the existing worker; use its native subagents for slices instead of another hire.`,
      );
  }
  private checkCaps(
    allocations: Allocation[],
    settings: ProjectsSettings,
    projectId: string,
    role?: string,
    excluding?: string,
  ): void {
    const project = settings.projects.find((p) => p.id === projectId);
    if (!project) throw new Error("This project no longer exists. Choose a project before hiring.");
    const live = allocations.filter((a) => !a.gone && a.projectId === projectId && a.id !== excluding);
    if (project.workerCap !== undefined && live.length >= project.workerCap)
      throw new Error(
        `${project.name} allows ${project.workerCap} running agents. ${project.workerCap === 0 ? "Raise this limit in project settings before hiring." : "Close an agent’s Herdr pane before hiring another."}`,
      );
    const selected = role === undefined ? undefined : projectRolePolicy(project, role);
    if (
      selected?.concurrencyCap !== undefined &&
      live.filter(
        (a) => a.role !== undefined && operatorAgentRoleKey(a.role) === operatorAgentRoleKey(selected.role),
      ).length >= selected.concurrencyCap
    )
      throw new Error(
        `${project.name}'s ${selected.role} role allows ${selected.concurrencyCap} running agents. ${selected.concurrencyCap === 0 ? "Raise this role’s limit in project settings before hiring." : "Close one of this role’s Herdr panes before hiring another."}`,
      );
  }
  public launch(id: string, settings: ProjectsSettings): void {
    this.change((state) => {
      const entry = state.allocations.find((a) => a.id === id && !a.gone);
      if (!entry) throw new Error("This hire is no longer available. Try again.");
      projectHireRequest(settings, entry.projectId, entry.request);
      if (launchPolicy(settings, entry.projectId, entry.role) !== entry.policy)
        throw new Error("This role's launch settings changed. Start a new hire with the current settings.");
      this.checkCaps(state.allocations, settings, entry.projectId, entry.role, id);
      this.checkDeliverable(state.allocations, entry.projectId, entry.request, id);
      entry.started = true;
    });
  }
  public requiredModel(id: string): string | undefined {
    const allocation = this.read().allocations.find((a) => a.id === id);
    return allocation === undefined ? undefined : allocation.request.model;
  }
  public confirmed(id: string): void {
    this.change((state) => {
      state.allocations.find((a) => a.id === id)!.confirmed = true;
    });
  }
  public pane(id: string, pane: string): void {
    this.change((state) => {
      const a = state.allocations.find((a) => a.id === id)!;
      a.pane = pane;
    });
  }
  public observe(id: string, seat: string, occupantId: string, proof?: ProjectHireProcessProof): void {
    this.change((state) => {
      const a = state.allocations.find((a) => a.id === id)!;
      if (a.occupantId !== undefined && (a.occupantId !== occupantId || a.seat !== seat))
        throw new Error("The original hire's agent has changed.");
      const firstObservation = a.occupantId === undefined;
      a.seat = seat;
      a.occupantId = occupantId;
      if (
        proof &&
        proof.nativeOccupantId === occupantId &&
        proof.pane === a.pane &&
        proof.fleet === (a.request.fleet ?? "default")
      ) {
        const observed = ProofSchema.parse(proof);
        if (a.proof && !isDeepStrictEqual(a.proof, observed))
          throw new Error(
            "The original hire's native process has changed. Check the existing agent before retrying.",
          );
        // A later matching session cannot retroactively prove the process we launched.
        if (firstObservation) a.proof = observed;
      }
    });
  }
  /** Only pre-launch failures release immediately; all native uncertainty remains counted. */
  public failed(id: string): void {
    this.change((state) => {
      const a = state.allocations.find((a) => a.id === id);
      if (a && !a.started) a.gone = true;
    });
  }
  /** Capture before starting inventory so a stale census cannot release a newer allocation. */
  public inventoryCandidates(fleet: string): ReadonlyMap<string, string> {
    return new Map(
      this.read()
        .allocations.filter(
          (a) => !a.gone && (a.request.fleet ?? "default") === fleet && a.pane !== undefined,
        )
        .map((a) => [a.id, JSON.stringify(a)]),
    );
  }
  /** Caller supplies a complete successful host inventory, never a missing get() response. */
  public reconcile(
    fleet: string,
    panes: ReadonlySet<string>,
    active: ReadonlySet<string>,
    candidates: ReadonlyMap<string, string>,
  ): void {
    this.change((state) => {
      for (const a of state.allocations)
        if (
          candidates.get(a.id) === JSON.stringify(a) &&
          !active.has(a.id) &&
          !a.gone &&
          (a.request.fleet ?? "default") === fleet &&
          a.pane !== undefined &&
          !panes.has(a.pane)
        )
          a.gone = true;
    });
  }
  /** Read only. A speculative observation is not a confirmed original launch. */
  public membershipCandidate(fleet: string, pane: string): ProjectHireMembershipCandidate {
    const entry = this.read()
      .allocations.filter((a) => (a.request.fleet ?? "default") === fleet && a.pane === pane)
      .at(-1);
    if (!entry) return { state: "none" };
    if (!entry.started || !entry.confirmed || entry.gone || !entry.proof || !entry.seat || !entry.occupantId)
      return { state: "unconfirmed" };
    return {
      state: "confirmed",
      revision: createHash("sha256").update(JSON.stringify(entry)).digest("hex"),
      seat: entry.seat,
      nativeOccupantId: entry.occupantId,
      harness: entry.request.harness ?? "codex",
      generic: entry.proof.shell.pid !== entry.proof.processes[0]!.pid,
    };
  }
  public confirmedAssignment(
    fleet: string,
    pane: string,
    revision: string,
    proof: ProjectHireProcessProof,
  ): ProjectHireAssignment {
    const candidate = this.membershipCandidate(fleet, pane);
    if (candidate.state !== "confirmed" || candidate.revision !== revision) return { state: "invalid" };
    return this.assignment(fleet, pane, proof);
  }

  public assignment(fleet: string, pane: string, proof?: ProjectHireProcessProof): ProjectHireAssignment {
    const records = this.read().allocations.filter(
      (a) => (a.request.fleet ?? "default") === fleet && a.pane === pane,
    );
    if (!records.length) return { state: "none" };
    const a = records.at(-1)!;
    const saved = a.proof;
    if (
      a.gone ||
      !a.occupantId ||
      !saved ||
      !proof ||
      proof.nativeOccupantId !== a.occupantId ||
      proof.fleet !== fleet ||
      proof.pane !== pane ||
      JSON.stringify(saved.binding) !== JSON.stringify(proof.binding) ||
      JSON.stringify(saved.shell) !== JSON.stringify(proof.shell) ||
      !proof.processes.some(
        (p) => p.pid === saved.processes[0]!.pid && p.startTime === saved.processes[0]!.startTime,
      )
    )
      return { state: "invalid" };
    const occupantId = createHash("sha256")
      .update(JSON.stringify([a.occupantId, saved.processes[0], saved.shell, saved.binding]))
      .digest("hex");
    return {
      state: "assigned",
      projectId: a.projectId,
      ...(a.role === undefined ? {} : { role: a.role }),
      occupantId,
    };
  }
}

export function projectHireRequest(
  settings: ProjectsSettings,
  projectId: string,
  request: SpawnOperatorSeat,
  defaults: HireProfile = {},
): SpawnOperatorSeat & { harness: NonNullable<SpawnOperatorSeat["harness"]> } {
  const project = settings.projects.find((p) => p.id === projectId);
  if (!project) throw new Error("Choose an existing project before hiring.");
  const role = request.role === undefined ? undefined : projectRolePolicy(project, request.role);
  if (request.role !== undefined && !role)
    throw new Error(`${project.name} has no ${request.role} role. Choose one of its roles before hiring.`);
  const result = { ...request, ...effectiveHireProfile(request, role, defaults) };
  if (result.subagents === null) delete result.subagents;
  return result;
}

function launchPolicy(settings: ProjectsSettings, projectId: string, role?: string): string {
  const project = settings.projects.find((p) => p.id === projectId);
  const selected = project === undefined || role === undefined ? undefined : projectRolePolicy(project, role);
  const base = [selected?.harness, selected?.model, selected?.effort];
  const extra = [selected?.subagents, selected?.delegation, selected?.account, selected?.placement];
  // Preserve legacy journals when no new role fields are configured.
  return JSON.stringify(extra.some((value) => value !== undefined) ? [...base, ...extra] : base);
}
