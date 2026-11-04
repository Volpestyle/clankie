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
  statSync,
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
export const ProjectHireProcessProofSchema = z
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
  /** The observed process has not reported a native session; never persisted with a hire. */
  readonly nativeSessionPending?: true;
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
    /** Legacy allocations predate a recorded start time. */
    beganAt: z.number().int().nonnegative().optional(),
    pane: z.string().optional(),
    seat: z.string().optional(),
    occupantId: z.string().optional(),
    proof: ProjectHireProcessProofSchema.optional(),
    restartPredecessors: z
      .array(
        z
          .object({
            receiptId: z.string().min(1),
            seat: z.string(),
            occupantId: z.string(),
            proof: ProjectHireProcessProofSchema,
          })
          .strict(),
      )
      .optional(),
    selection: z
      .object({
        at: z.string().datetime(),
        plan: z.string(),
        remaining: z.number().min(0).max(1),
        reason: z.string(),
        model: z.string(),
        effort: z.string(),
        effortReason: z.string(),
      })
      .strict()
      .optional(),
    confirmed: z.boolean().default(false),
    gone: z.boolean().default(false),
    /** This attempt's work landed on main first (#602); its harness and model won. */
    attemptWon: z.string().datetime().optional(),
    /** The winning attempt's allocation, once another attempt at this deliverable landed. */
    supersededBy: z.string().optional(),
    operatorRelease: z
      .object({ at: z.string().datetime(), censusSha256: z.string().regex(/^[a-f0-9]{64}$/u) })
      .strict()
      .optional(),
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
      /** The registered project this pane was hired for. */
      projectId: string;
      seat: string;
      nativeOccupantId: string;
      harness: string;
      generic: boolean;
      /** The project role it was hired into, when the hire named one. */
      role?: string;
    };

/** Controller state: semantic persona assignments cannot create, finish or release these claims. */
export class ProjectHires {
  private readonly path: string;
  private readonly receiptDetail: ((freshIntent: string) => string) | undefined;
  public constructor(path: string, receiptDetail?: (freshIntent: string) => string) {
    this.path = path;
    this.receiptDetail = receiptDetail;
  }
  /** Retained launch provenance, including a pane later reattached to that same native session. */
  public hiredOccupant(occupantId: string): boolean {
    return this.read().allocations.some(
      (entry) => entry.started && entry.confirmed && entry.occupantId === occupantId,
    );
  }
  /**
   * The title Clankie hired this native session under, or is still hiring this pane under before
   * its session is known. Its Herdr handle was minted from that title (LOCAL-VUH-59).
   */
  public hireTitle(fleet: string, pane: string | undefined, occupantId: string): string | undefined {
    const started = this.read().allocations.filter((entry) => entry.started);
    return (
      started.findLast((entry) => entry.occupantId === occupantId) ??
      (pane === undefined
        ? undefined
        : started.findLast(
            (entry) =>
              entry.occupantId === undefined &&
              (entry.request.fleet ?? "default") === fleet &&
              entry.pane === pane,
          ))
    )?.request.title;
  }
  /** The project and directory this exact seat and native occupant was hired into, for display only. */
  public hiredInto(
    seat: string,
    occupantId: string,
  ): { readonly projectId: string; readonly workingDirectory: string } | undefined {
    const entry = this.read().allocations.findLast(
      (allocation) => allocation.started && allocation.seat === seat && allocation.occupantId === occupantId,
    );
    return entry && { projectId: entry.projectId, workingDirectory: entry.request.workingDirectory };
  }
  /**
   * Every roster projection reads this ledger once per seat. Parse a given
   * file version once: writes replace the file by rename, so its identity,
   * size and timestamps change with every committed state. The cached state
   * is frozen; mutations go through `change`, which parses afresh under its lock.
   */
  private cached: { version: string; state: z.infer<typeof StateSchema> } | undefined;
  private read(): z.infer<typeof StateSchema> {
    let stat;
    try {
      stat = statSync(this.path, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.cached = undefined;
      return { version: 1, allocations: [] };
    }
    const version = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    if (this.cached?.version === version) return this.cached.state;
    const state = deepFreeze(this.parse());
    this.cached = { version, state };
    return state;
  }
  private parse(): z.infer<typeof StateSchema> {
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
      const state = this.parse();
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
  public unresolved(input: {
    readonly fleet?: string | undefined;
    readonly workingDirectory: string;
    readonly harness?: string | undefined;
  }): boolean {
    return this.read().allocations.some(
      (a) =>
        !a.gone &&
        !a.confirmed &&
        (a.request.fleet ?? "default") === (input.fleet ?? "default") &&
        a.request.workingDirectory === input.workingDirectory &&
        (input.harness === undefined || a.request.harness === input.harness),
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
        if (pending.request.freshIntent || input.freshIntent) {
          const requested = projectHireRequest(settings, projectId, input, defaults);
          if (
            !isDeepStrictEqual(
              { ...pending.request, projectId: pending.projectId },
              { ...requested, projectId },
            )
          )
            throw new Error(this.blockerDetail(pending));
        }
        if (
          pending.projectId !== projectId ||
          operatorAgentRoleKey(pending.role ?? "") !== operatorAgentRoleKey(input.role ?? "") ||
          pending.request.deliverable !== input.deliverable
        )
          throw new Error(this.blockerDetail(pending));
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
        beganAt: Date.now(),
        confirmed: false,
        gone: false,
      };
      state.allocations.push(allocation);
      return { ...structuredClone(allocation), reused: false };
    });
  }
  /** A live hire's attempt state (#602); undefined for an ordinary claim. */
  public attempt(
    fleet: string,
    pane: string | undefined,
  ):
    | {
        readonly allocation: string;
        readonly occupantId: string | undefined;
        readonly deliverable: string;
        readonly superseded: boolean;
      }
    | undefined {
    const entry = this.read().allocations.find(
      (a) => !a.gone && (a.request.fleet ?? "default") === fleet && a.pane === pane && a.request.attempt,
    );
    return entry?.request.deliverable === undefined
      ? undefined
      : {
          allocation: entry.id,
          occupantId: entry.occupantId,
          deliverable: entry.request.deliverable,
          superseded: entry.supersededBy !== undefined,
        };
  }
  /**
   * Every attempt at the deliverable of the attempt captured before its close (#602),
   * gone or live, while none has won and the captured record still matches its
   * allocation. `revision` fingerprints the set and each one's provenance; settleAttempt
   * refuses if it changed while the settlement read GitHub.
   */
  public attemptCandidates(
    allocation: string,
    occupantId: string,
  ):
    | { readonly deliverable: string; readonly candidates: AttemptCandidate[]; readonly revision: string }
    | undefined {
    const allocations = this.read().allocations;
    const attempts = attemptSet(allocations, allocation, occupantId);
    if (attempts === undefined) return undefined;
    return {
      deliverable: attempts.deliverable,
      revision: attemptRevision(attempts.all),
      candidates: attempts.all.map((a) => ({
        allocation: a.id,
        occupantId: a.occupantId,
        pane: a.pane,
        harness: a.request.harness,
        model: a.selection?.model ?? a.request.model,
      })),
    };
  }
  /**
   * Record one attempt as the winner its merged hire branch proved (#602), even after
   * its close released it, and mark every other live attempt at the same deliverable
   * superseded. Under the ledger lock, the captured attempt's set must still have the
   * `revision` the settlement read; any change, or an attempt that already won, refuses.
   * Advisory: the lead closes the superseded ones. Returns their panes, or undefined.
   */
  public settleAttempt(
    captured: { readonly allocation: string; readonly occupantId: string },
    revision: string,
    winner: string,
  ): string[] | undefined {
    return this.change((state) => {
      const attempts = attemptSet(state.allocations, captured.allocation, captured.occupantId);
      if (attempts === undefined || attemptRevision(attempts.all) !== revision) return undefined;
      const won = attempts.all.find((a) => a.id === winner);
      if (won === undefined || won.supersededBy !== undefined) return undefined;
      won.attemptWon = new Date().toISOString();
      const siblings = attempts.all.filter((a) => a.id !== won.id && !a.gone);
      for (const sibling of siblings) sibling.supersededBy = won.id;
      return siblings.map((sibling) => sibling.pane ?? sibling.id);
    });
  }
  /** Read-only identity and age for a refused retry; never settles the original hire. */
  public describe(id: string): string {
    const entry = this.read().allocations.find((allocation) => allocation.id === id);
    if (!entry) return `allocation ${id} (age unknown)`;
    const age =
      entry.beganAt === undefined
        ? "age unknown; legacy hire has no recorded start time"
        : `age ${Math.max(0, Math.floor((Date.now() - entry.beganAt) / 1_000))}s`;
    return `allocation ${id}${entry.pane === undefined ? "" : ` in pane ${entry.pane}`} (${age})`;
  }
  private blockerDetail(entry: Allocation): string {
    const intent = entry.request.freshIntent?.id;
    return `Blocking hire ${this.describe(entry.id)} retains pane ${entry.pane ?? "unobserved"} (seat ${entry.seat ?? "unobserved"}; intent ${intent ?? "legacy"}). ${intent ? (this.receiptDetail?.(intent) ?? "Inspect original receipt.") : "Inspect original receipt."} Blocks different intent or launch scope. Settlement leaves allocation held. Owning lead: keep report; close_worker_pane with reason (owner/process/draft/work guards). Complete pane-absent inventory releases it. Never replay or substitute intent.`;
  }
  /** Exact retained launch for retirement; this does not confer confirmed project membership. */
  public retirementCandidate(fleet: string, pane: string) {
    return this.read()
      .allocations.filter(
        (a) => !a.gone && a.started && (a.request.fleet ?? "default") === fleet && a.pane === pane,
      )
      .at(-1);
  }
  public retainedIntent(intent: string) {
    return this.read().allocations.find((a) => !a.gone && a.request.freshIntent?.id === intent);
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
  /**
   * One live hire holds a deliverable in a project (#602), so an accidental second
   * claim is refused under the state lock that also records the first. Deliberate
   * attempts (`attempt: true`) coexist with each other, each with its own harness or
   * model and its own working directory. A holder's claim ends when its allocation
   * is released: the pane closed, or a complete census found it gone.
   */
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
    if (request.attempt && !request.deliverable)
      throw new Error("An attempt needs the deliverable key it attempts.");
    if (!request.deliverable) return;
    const holders = allocations.filter(
      (a) =>
        !a.gone &&
        a.id !== excluding &&
        a.projectId === projectId &&
        a.request.deliverable === request.deliverable,
    );
    for (const holder of holders) {
      if (holder.request.delegation === "native-first" || request.delegation === "native-first")
        throw new Error(
          `Deliverable ${request.deliverable} already has a pane under native-first delegation. Message the existing worker; use its native subagents for slices instead of another hire.`,
        );
      const tries = (a: SpawnOperatorSeat) => JSON.stringify([a.harness ?? null, a.model ?? null]);
      if (!request.attempt || !holder.request.attempt)
        throw new Error(
          `Deliverable ${request.deliverable} is already claimed by ${this.holderDetail(holder)}. Message that worker, or close its pane with close_worker_pane to reassign the work. To race another harness or model on purpose, hire each one with attempt: true.`,
        );
      if (tries(holder.request) === tries(request))
        throw new Error(
          `${this.holderDetail(holder)} already attempts ${request.deliverable} with the same harness and model. Each attempt tries a different one.`,
        );
      if (
        (holder.request.fleet ?? "default") === (request.fleet ?? "default") &&
        holder.request.workingDirectory === request.workingDirectory
      )
        throw new Error(
          `${this.holderDetail(holder)} already attempts ${request.deliverable} in ${request.workingDirectory}. Give each attempt its own worktree.`,
        );
    }
  }
  private holderDetail(holder: Allocation): string {
    const harness = [holder.request.harness, holder.selection?.model ?? holder.request.model]
      .filter(Boolean)
      .join(" ");
    return `${holder.request.attempt ? "an attempt by " : ""}${harness || "a hire"}${holder.seat === undefined ? "" : ` (seat ${holder.seat})`}, ${this.describe(holder.id)}`;
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
  public launch(id: string, settings: ProjectsSettings, dispatched = true): void {
    this.change((state) => {
      const entry = state.allocations.find((a) => a.id === id && !a.gone);
      if (!entry) throw new Error("This hire is no longer available. Try again.");
      projectHireRequest(settings, entry.projectId, entry.request);
      if (launchPolicy(settings, entry.projectId, entry.role) !== entry.policy)
        throw new Error("This role's launch settings changed. Start a new hire with the current settings.");
      this.checkCaps(state.allocations, settings, entry.projectId, entry.role, id);
      this.checkDeliverable(state.allocations, entry.projectId, entry.request, id);
      // Policy probes are reversible. Latch only at the native effect boundary.
      if (dispatched) entry.started = true;
    });
  }
  public requiredModel(id: string): string | undefined {
    const allocation = this.read().allocations.find((a) => a.id === id);
    return allocation === undefined ? undefined : allocation.request.model;
  }
  public selection(id: string, selection: NonNullable<Allocation["selection"]>): void {
    this.change((state) => {
      state.allocations.find((entry) => entry.id === id)!.selection = selection;
    });
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
      a.started = true;
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
        // Native observers also report cwd/private-seat metadata. A hire's
        // intentional assignment retains only its original process identity.
        const { nativeOccupantId, fleet, pane, binding, processes, shell } = proof;
        const observed = ProjectHireProcessProofSchema.parse({
          nativeOccupantId,
          fleet,
          pane,
          binding,
          processes,
          shell,
        });
        if (a.proof && !isDeepStrictEqual(a.proof, observed))
          throw new Error(
            "The original hire's native process has changed. Check the existing agent before retrying.",
          );
        // A later matching session cannot retroactively prove the process we launched.
        if (firstObservation) a.proof = observed;
      }
    });
  }
  /** Original allocation continues only under an explicit journaled predecessor CAS. */
  public restartSuccessor(
    id: string,
    receiptId: string,
    previous: {
      pane: string;
      seat: string;
      occupantId: string;
      proof: ProjectHireProcessProof;
    },
    next: { seat: string; occupantId: string; proof: ProjectHireProcessProof },
  ): void {
    this.change((state) => {
      const allocation = state.allocations.find((entry) => entry.id === id);
      if (
        !receiptId ||
        !allocation ||
        !allocation.started ||
        !allocation.confirmed ||
        allocation.gone ||
        allocation.pane !== previous.pane ||
        allocation.seat !== previous.seat ||
        allocation.occupantId !== previous.occupantId ||
        !isDeepStrictEqual(allocation.proof, previous.proof) ||
        next.proof.pane !== previous.pane ||
        next.proof.nativeOccupantId !== next.occupantId ||
        !isDeepStrictEqual(previous.proof.shell, next.proof.shell)
      )
        throw new Error("Restart successor does not match the original project allocation");
      allocation.seat = next.seat;
      allocation.occupantId = next.occupantId;
      (allocation.restartPredecessors ??= []).push({
        receiptId,
        seat: previous.seat,
        occupantId: previous.occupantId,
        proof: ProjectHireProcessProofSchema.parse(previous.proof),
      });
      allocation.proof = ProjectHireProcessProofSchema.parse(next.proof);
    });
  }
  /** Only pre-launch failures release immediately; all native uncertainty remains counted. */
  public failed(id: string): void {
    this.change((state) => {
      const a = state.allocations.find((a) => a.id === id);
      if (a && !a.started) a.gone = true;
    });
  }
  /** Host allocator proof: the dispatch fence was crossed, but no pane effect was issued. */
  public notStarted(id: string): void {
    this.change((state) => {
      const a = state.allocations.find((entry) => entry.id === id);
      if (!a || a.pane !== undefined || a.occupantId !== undefined || a.confirmed)
        throw new Error("An observed hire cannot be marked not started.");
      a.started = false;
      a.gone = true;
    });
  }
  /** Read only: the allocation with this UUID, whatever its state. */
  public allocation(id: string): Allocation | undefined {
    return this.read().allocations.find((a) => a.id === id);
  }
  /** Operator recovery snapshots retain the original allocation; they confer no launch authority. */
  public recoveryCandidate(id: string): Allocation | undefined {
    return this.read().allocations.find((a) => a.id === id && !a.confirmed && (!a.gone || a.operatorRelease));
  }
  /** Read only: this machine's unresolved allocations recorded for one pane (or none) in one directory. */
  public unresolvedLocal(workingDirectory: string, pane: string | undefined, harness: string): Allocation[] {
    return this.read().allocations.filter(
      (a) =>
        !a.confirmed &&
        !a.gone &&
        a.request.fleet === undefined &&
        a.pane === pane &&
        a.request.workingDirectory === workingDirectory &&
        (a.request.harness ?? "codex") === harness,
    );
  }
  /** Read only: this machine's unresolved allocations in one directory, whatever their harness or pane. */
  public unresolvedLocalAt(workingDirectory: string): Allocation[] {
    return this.read().allocations.filter(
      (a) =>
        !a.confirmed &&
        !a.gone &&
        a.request.fleet === undefined &&
        a.request.workingDirectory === workingDirectory,
    );
  }
  public release(candidate: Allocation, inventory: unknown): void {
    this.change((state) => {
      const entry = state.allocations.find((a) => a.id === candidate.id);
      if (!entry || !isDeepStrictEqual(entry, candidate))
        throw new Error("Original project hire allocation changed; nothing released.");
      entry.gone = true;
      entry.operatorRelease = {
        at: new Date().toISOString(),
        censusSha256: createHash("sha256").update(JSON.stringify(inventory)).digest("hex"),
      };
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
      projectId: entry.projectId,
      seat: entry.seat,
      nativeOccupantId: entry.occupantId,
      harness: entry.request.harness ?? "codex",
      generic: entry.proof.shell.pid !== entry.proof.processes[0]!.pid,
      ...(entry.role === undefined ? {} : { role: entry.role }),
    };
  }
  /**
   * Capture a confirmed original hire for its later exit bookkeeping. This is
   * not live membership: complete inventory may mark the hire gone before its
   * issue is settled. Replacement, recovery release or changed provenance
   * still invalidates the capture; the caller must recheck current project policy.
   */
  public bookkeepingAttribution(fleet: string, pane: string, occupantId: string) {
    const candidates = () =>
      this.read().allocations.filter(
        (entry) => (entry.request.fleet ?? "default") === fleet && entry.pane === pane,
      );
    const latest = () => candidates().at(-1);
    const entry = latest();
    if (
      !entry ||
      candidates().filter((candidate) => !candidate.gone).length !== 1 ||
      !entry.started ||
      !entry.confirmed ||
      entry.gone ||
      entry.operatorRelease ||
      !entry.proof ||
      !entry.seat ||
      entry.occupantId !== occupantId ||
      entry.proof.nativeOccupantId !== occupantId ||
      entry.proof.fleet !== fleet ||
      entry.proof.pane !== pane
    )
      return undefined;
    const retained = (allocation: Allocation) => {
      const { gone: _gone, ...provenance } = allocation;
      return provenance;
    };
    const saved = retained(entry);
    return {
      projectId: entry.projectId,
      ...(entry.role === undefined ? {} : { role: entry.role }),
      validate: () => {
        const current = latest();
        if (
          !current ||
          candidates().filter((candidate) => !candidate.gone).length > 1 ||
          current.operatorRelease ||
          !isDeepStrictEqual(retained(current), saved)
        )
          throw new Error("Original project hire bookkeeping attribution changed or was revoked");
      },
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
  const result = projectHireProfile(settings, projectId, request, defaults);
  // The hire chooses a harness before reserving when no layer names one; never assume one here.
  if (result.harness === undefined)
    throw new Error("No harness was chosen for this hire. Pass harness, or set one on the role or fleet.");
  return { ...result, harness: result.harness };
}

/** The request with its project role and fleet defaults applied; `harness` may stay unset (no preference). */
export function projectHireProfile(
  settings: ProjectsSettings,
  projectId: string,
  request: SpawnOperatorSeat,
  defaults: HireProfile = {},
): SpawnOperatorSeat {
  const project = settings.projects.find((p) => p.id === projectId);
  if (!project) throw new Error("Choose an existing project before hiring.");
  const role = request.role === undefined ? undefined : projectRolePolicy(project, request.role);
  if (request.role !== undefined && !role)
    throw new Error(`${project.name} has no ${request.role} role. Choose one of its roles before hiring.`);
  // Fleet-wide effort is retired: each work hire chooses it for the job.
  const { effort: _retiredEffort, ...fleet } = defaults;
  const profile = request.hireKind === "lead" ? project.hiring?.lead : project.hiring?.worker;
  const result = {
    ...request,
    ...effectiveHireProfile(request, role, effectiveHireProfile(profile ?? {}, {}, fleet)),
  };
  if (result.model === undefined && project.hiring?.allowedModels?.length === 1)
    result.model = project.hiring.allowedModels[0]!;
  if (result.subagents === null) delete result.subagents;
  return result;
}

function launchPolicy(settings: ProjectsSettings, projectId: string, role?: string): string {
  const project = settings.projects.find((p) => p.id === projectId);
  const selected = project === undefined || role === undefined ? undefined : projectRolePolicy(project, role);
  const base = [selected?.harness, selected?.model, selected?.effort];
  const extra = [
    selected?.subagents,
    selected?.delegation,
    selected?.account,
    selected?.placement,
    ...(project?.hiring === undefined ? [] : [project.hiring]),
  ];
  // Preserve legacy journals when no new role fields are configured.
  return JSON.stringify(extra.some((value) => value !== undefined) ? [...base, ...extra] : base);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** The attempts sharing the captured attempt's deliverable, while none has won. */
function attemptSet(
  allocations: readonly Allocation[],
  allocation: string,
  occupantId: string,
): { readonly deliverable: string; readonly all: Allocation[] } | undefined {
  const captured = allocations.find(
    (a) => a.id === allocation && a.occupantId === occupantId && a.request.attempt,
  );
  const deliverable = captured?.request.deliverable;
  if (captured === undefined || deliverable === undefined || captured.supersededBy !== undefined)
    return undefined;
  const all = allocations.filter(
    (a) => a.request.attempt && a.projectId === captured.projectId && a.request.deliverable === deliverable,
  );
  return all.some((a) => a.attemptWon !== undefined) ? undefined : { deliverable, all };
}
/** Fingerprint of an attempt set and each member's provenance. */
function attemptRevision(attempts: readonly Allocation[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        attempts
          .map((a) => [
            a.id,
            a.occupantId ?? null,
            a.seat ?? null,
            a.pane ?? null,
            a.gone,
            a.supersededBy ?? null,
            a.request,
          ])
          .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
      ),
    )
    .digest("hex");
}
/** One attempt at a deliverable, as the hire ledger recorded it (#602). */
export type AttemptCandidate = {
  readonly allocation: string;
  readonly occupantId: string | undefined;
  readonly pane: string | undefined;
  readonly harness: string | undefined;
  readonly model: string | undefined;
};
/** The pull request that merged an attempt's hire branch, as GitHub records it. */
export type AttemptMerge = { readonly number: number; readonly url: string; readonly mergedAt: string };
/** What the hire recorded before its native harness launched: never the worktree's later say. */
export type AttemptLaunch = { readonly branch: string; readonly startHead: string; readonly hiredAt: string };
/** A hire's prelaunch commit baseline as an attempt's launch record. */
export function attemptLaunch(
  baseline: { readonly branchRef: string; readonly head: string; readonly capturedAt: string } | undefined,
): AttemptLaunch | undefined {
  return (
    baseline && {
      branch: baseline.branchRef.slice("refs/heads/".length),
      startHead: baseline.head,
      hiredAt: baseline.capturedAt,
    }
  );
}
export type AttemptSettlement =
  | {
      readonly outcome: "won";
      readonly allocation: string;
      readonly superseded: string[];
      readonly detail: string;
    }
  | { readonly outcome: "unsettled"; readonly detail: string };

/**
 * Settle a closed attempt's deliverable from evidence the host keeps (#602): what each
 * attempt's hire recorded before launch (its branch, start commit and time), and the
 * pull request GitHub merged from that branch into the default branch after the hire,
 * with a head descended from that start. Nothing the worktree writes counts. Once every
 * attempt has such a merge, the first one wins and its live siblings are superseded;
 * otherwise, or if the attempts changed meanwhile, nothing is set and the lead gets the
 * candidates.
 */
export async function settleAttemptByMerge(
  hires: Pick<ProjectHires, "attemptCandidates" | "settleAttempt">,
  record: { readonly allocation: string; readonly occupantId: string },
  launchOf: (candidate: AttemptCandidate) => AttemptLaunch | undefined,
  mergedPull: (repository: string, launch: AttemptLaunch) => Promise<AttemptMerge | undefined>,
): Promise<AttemptSettlement | undefined> {
  const found = hires.attemptCandidates(record.allocation, record.occupantId);
  if (found === undefined) return undefined;
  const { deliverable, candidates, revision } = found;
  const launches = candidates.map(launchOf);
  const name = (candidate: AttemptCandidate, index: number) =>
    `${[candidate.harness, candidate.model].filter(Boolean).join(" ") || "an attempt"} (${
      candidate.pane === undefined ? `allocation ${candidate.allocation}` : `pane ${candidate.pane}`
    }${launches[index] === undefined ? "" : `, branch ${launches[index]!.branch}`})`;
  const unsettled = (reason: string) => ({
    outcome: "unsettled" as const,
    detail: `No automatic winner for ${deliverable}: ${reason}. Candidates: ${candidates
      .map(name)
      .join("; ")}. Decide which attempt's work to keep and close the others.`,
  });
  const repository = /^([\w.-]+\/[\w.-]+)#\d+$/u.exec(deliverable)?.[1];
  if (repository === undefined) return unsettled("the deliverable names no GitHub issue");
  const missing = launches.findIndex((launch) => launch === undefined);
  if (missing !== -1)
    return unsettled(`no launch record holds the hire branch of ${name(candidates[missing]!, missing)}`);
  if (new Set(launches.map((launch) => launch!.branch)).size !== launches.length)
    return unsettled("two attempts share a hire branch");
  let merges: (AttemptMerge | undefined)[];
  try {
    merges = await Promise.all(launches.map((launch) => mergedPull(repository, launch!)));
  } catch (error) {
    return unsettled(`GitHub could not be read (${error instanceof Error ? error.message : String(error)})`);
  }
  const unmerged = merges.findIndex((merge) => merge === undefined);
  if (unmerged !== -1)
    return unsettled(
      `${name(candidates[unmerged]!, unmerged)} has no pull request merged from its hire branch since its hire`,
    );
  const ranked = candidates
    .map((candidate, index) => ({ candidate, index, merge: merges[index]! }))
    .sort((a, b) => Date.parse(a.merge.mergedAt) - Date.parse(b.merge.mergedAt));
  const first = ranked[0]!;
  if (ranked[1] !== undefined && Date.parse(ranked[1].merge.mergedAt) === Date.parse(first.merge.mergedAt))
    return unsettled("two attempts' pull requests merged at the same instant");
  const superseded = hires.settleAttempt(record, revision, first.candidate.allocation);
  if (superseded === undefined) return unsettled("the attempts changed while GitHub was read");
  return {
    outcome: "won",
    allocation: first.candidate.allocation,
    superseded,
    detail: `${name(first.candidate, first.index)} won ${deliverable}: its hire branch merged first as ${first.merge.url}.${
      superseded.length ? ` Superseded: ${superseded.join(", ")}; close them when their reports are in.` : ""
    }`,
  };
}
