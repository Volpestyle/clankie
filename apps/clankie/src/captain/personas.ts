import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  statSync,
  lstatSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  SettingsStore,
  migratePersonaRoles,
  setDefaultProjectRole,
  setProjectRole,
  projectRoleForPersona,
  projectsRevision,
} from "@clankie/settings";
import { OperatorAgentRoleSchema } from "@clankie/protocol";
import { DEFAULT_PROJECT_ID, ProjectIdSchema } from "@clankie/protocol/projects";
import {
  defaultOperatorAgentAppearance,
  OPERATOR_AGENT_ROLES,
  operatorAgentRoleKey,
  OperatorAgentNameSchema,
  OperatorCodexAccountSchema,
  OperatorAgentPersonaIdSchema,
  OperatorAgentPersonaSchema,
  SetOperatorAgentPersonaRoleSchema,
  UpdateOperatorAgentPersonaSchema,
  type OperatorAgentPersona,
  type OperatorAgentRole,
  type OperatorAgentRoleSummary,
  type SetOperatorAgentPersonaRole,
  type OperatorConversation,
  type OperatorFleetSeat,
  type UpdateOperatorAgentPersona,
} from "@clankie/protocol";
import { z } from "zod";
import type { ObservedFleetSeat } from "./herdr-census.ts";

function retiredPersona(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const { swarm: _swarm, ...persona } = input as Record<string, unknown>;
  return persona;
}

const MAX_AVATAR_BYTES = 512 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const LegacyPersonaFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    personas: z.array(z.preprocess(retiredPersona, OperatorAgentPersonaSchema)),
  })
  .strict();
const PersonaBindingSchema = z
  .object({
    account: OperatorCodexAccountSchema.optional(),
    subject: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u),
    personaId: OperatorAgentPersonaIdSchema,
    occupantId: z.string().regex(/^session-[a-f0-9]{64}$/u),
  })
  .strict();
const PersonaFileSchema = z.discriminatedUnion("schemaVersion", [
  LegacyPersonaFileSchema,
  z
    .object({
      schemaVersion: z.literal(2),
      personas: z.array(z.preprocess(retiredPersona, OperatorAgentPersonaSchema)),
      bindings: z.array(PersonaBindingSchema),
    })
    .strict(),
]);

const PendingRoleSchema = z
  .object({
    id: z.string().uuid(),
    personaId: OperatorAgentPersonaIdSchema,
    role: OperatorAgentRoleSchema.nullable(),
    projectId: ProjectIdSchema.optional(),
  })
  .strict();
const PendingRolesSchema = z.array(PendingRoleSchema).max(10_000);
type PendingRole = z.infer<typeof PendingRoleSchema>;
export type PersonaRoleWrite = { outcome: "pending"; operationId: string } | { outcome: "unsaved" };

type PersonaBinding = z.infer<typeof PersonaBindingSchema>;

/** Host-owned fleet characters. Herdr seats are only their current locations. */
export class PersonaStore {
  private readonly path: string;
  private readonly avatarDir: string;
  private readonly records = new Map<string, OperatorAgentPersona>();
  private readonly bindings = new Map<string, PersonaBinding>();
  private unreadable = false;
  private loadedSource: string | undefined;
  private projectStore?: SettingsStore;
  private initializing = false;
  private migration?: Promise<void>;
  private flushQueue: Promise<void> = Promise.resolve();
  private pending: PendingRole[] = [];
  private pendingPath = "";
  private journalLock: { path: string; nonce: string } | undefined;
  private closed = false;

  public constructor(stateDir: string) {
    this.path = join(stateDir, "personas.json");
    this.avatarDir = join(stateDir, "persona-avatars");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(this.avatarDir, { recursive: true });
    try {
      if (!existsSync(this.path)) return;
      this.loadedSource = readFileSync(this.path, "utf8");
      const state = PersonaFileSchema.parse(JSON.parse(this.loadedSource));
      for (const persona of state.personas) {
        if (this.records.has(persona.personaId)) throw new Error("Duplicate agent identity");
        // A seat is live state and is always rebuilt from Herdr after launch.
        const { activeSeatId: _activeSeatId, conversationId: _conversationId, ...persisted } = persona;
        this.records.set(persona.personaId, {
          ...persisted,
        });
      }
      if (state.schemaVersion === 2) {
        for (const binding of state.bindings) {
          if (this.bindings.has(binding.subject) || !this.records.has(binding.personaId)) {
            throw new Error("Agent identity bindings are inconsistent");
          }
          this.bindings.set(binding.subject, binding);
        }
      }
    } catch {
      this.unreadable = true;
    }
  }

  /** Run against the real owner settings store before exposing any persona operations. */
  public async ready(settings: SettingsStore): Promise<void> {
    if (this.closed) throw new Error("Persona store is closed");
    if (this.projectStore && this.projectStore !== settings)
      throw new Error("Persona project settings store changed");
    this.migration ??= this.migrate(settings);
    await this.migration;
    await this.flushProjectRoles();
    this.projectRoles((await settings.load()).projects);
  }

  private async migrate(settings: SettingsStore): Promise<void> {
    if (this.unreadable) throw new Error("Agent identity state is unreadable; legacy roles retained");
    this.initializing = true;
    const journalId = createHash("sha256").update(this.path).digest("hex");
    this.pendingPath = join(dirname(settings.path), `persona-project-roles-${journalId}.pending.json`);
    this.journalLock = acquireJournalWriter(this.pendingPath);
    if (existsSync(this.pendingPath)) {
      const info = lstatSync(this.pendingPath);
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        (info.mode & 0o077) !== 0 ||
        info.uid !== process.getuid?.() ||
        info.size > 4 * 1024 * 1024
      )
        throw new Error("Project role journal must be a bounded private owner file");
      this.pending = PendingRolesSchema.parse(JSON.parse(readFileSync(this.pendingPath, "utf8")));
    }
    const source = existsSync(this.path) ? readFileSync(this.path, "utf8") : undefined;
    if (source !== this.loadedSource) throw new Error("Agent identity source changed before migration");
    const legacy = [...this.records.values()].flatMap((p) =>
      p.role === undefined ? [] : [{ personaId: p.personaId, role: p.role }],
    );
    const sourceId = createHash("sha256").update(this.path).digest("hex");
    try {
      let projects;
      if (legacy.length > 0) {
        const saved = await settings.update((current) => ({
          ...current,
          projects: migratePersonaRoles(current.projects, sourceId, legacy),
        }));
        const verified = await settings.load();
        if (projectsRevision(saved.projects) !== projectsRevision(verified.projects))
          throw new Error("Project settings changed before legacy migration verification");
        projects = verified.projects;
      } else projects = (await settings.load()).projects;
      if ((existsSync(this.path) ? readFileSync(this.path, "utf8") : undefined) !== source)
        throw new Error("Agent identity source changed during migration");
      this.projectStore = settings;
      this.initializing = false;
      this.projectRoles(projects);
      // Project commit and readback precede removal of every legacy identity role.
      if (source !== undefined) this.save();
    } catch (error) {
      this.initializing = false;
      throw error;
    }
  }

  private projectRoles(projects: Parameters<typeof projectRoleForPersona>[0]): void {
    for (const [id, persona] of this.records) {
      const { role: _legacy, ...identity } = persona;
      const role = projectRoleForPersona(projects, id);
      this.records.set(id, { ...identity, ...(role === undefined ? {} : { role }) });
    }
  }

  private queueProjectRole(personaId: string, role: string | null, projectId = DEFAULT_PROJECT_ID): string {
    if (this.closed || !this.journalLock) throw new Error("Project role journal is not owned");
    const id = randomUUID();
    const next = PendingRolesSchema.parse([...this.pending, { id, personaId, role, projectId }]);
    durableJson(this.pendingPath, next);
    this.pending = next;
    return id;
  }

  /** The synchronous adoption receipt writes a separate durable intent; settings remain its final owner. */
  public flushProjectRoles(): Promise<void> {
    const run = async () => {
      if (!this.projectStore || this.pending.length === 0) return;
      const pending = [...this.pending];
      if (pending.some((entry) => !this.records.has(entry.personaId)))
        throw new Error("Pending role has no persisted agent identity; retained for reconciliation");
      const sourceId = createHash("sha256").update(this.pendingPath).digest("hex");
      const saved = await this.projectStore.update((current) => {
        const completed = new Set(
          current.projects.roleWriteReceipts.find((receipt) => receipt.sourceId === sourceId)?.operationIds ??
            [],
        );
        const projects = pending
          .filter((entry) => !completed.has(entry.id))
          .reduce(
            (value, entry) => setProjectRole(value, entry.personaId, entry.role, entry.projectId),
            current.projects,
          );
        return {
          ...current,
          projects: {
            ...projects,
            roleWriteReceipts: [
              ...projects.roleWriteReceipts.filter((receipt) => receipt.sourceId !== sourceId),
              { sourceId, operationIds: pending.map((entry) => entry.id) },
            ],
          },
        };
      });
      const verified = await this.projectStore.load();
      if (projectsRevision(saved.projects) !== projectsRevision(verified.projects))
        throw new Error("Project role write could not be verified");
      const remaining = this.pending.filter((entry) => !pending.some((done) => done.id === entry.id));
      durableJson(this.pendingPath, remaining);
      this.pending = remaining;
      this.projectRoles(verified.projects);
    };
    const result = this.flushQueue.then(run, run);
    this.flushQueue = result.catch(() => undefined);
    return result;
  }

  public async prepareRoleAdoption(role: OperatorAgentRole | undefined): Promise<void> {
    if (role === undefined) return;
    if (!this.projectStore || this.closed || !this.journalLock)
      throw new Error("Project role journal is not ready");
    if (this.pending.length >= 10_000) throw new Error("Project role journal is full");
    // Check current schema/role limits before a native side effect, without writing a phantom identity.
    setDefaultProjectRole((await this.projectStore.load()).projects, `prospective-${randomUUID()}`, role);
  }

  public roleWritePending(operationId: string): boolean {
    return this.pending.some((entry) => entry.id === operationId);
  }

  public async setProjectRole(
    input: SetOperatorAgentPersonaRole,
    admit?: () => void,
    projects?: Parameters<typeof projectRoleForPersona>[0],
  ): Promise<OperatorAgentPersona> {
    if (!this.projectStore) throw new Error("Project role migration has not completed");
    const parsed = SetOperatorAgentPersonaRoleSchema.parse(input);
    if (!this.records.has(parsed.personaId)) throw new Error(`Unknown agent ${parsed.personaId}`);
    const current = projects ?? (await this.projectStore.load()).projects;
    setProjectRole(current, parsed.personaId, parsed.role, parsed.projectId);
    // The host admits the exact current member synchronously before durable intent.
    admit?.();
    this.queueProjectRole(parsed.personaId, parsed.role, parsed.projectId);
    await this.flushProjectRoles();
    const { role: _defaultRole, ...persona } = this.records.get(parsed.personaId)!;
    const role = projectRoleForPersona(
      (await this.projectStore.load()).projects,
      parsed.personaId,
      parsed.projectId,
    );
    return { ...persona, ...(role === undefined ? {} : { role }) };
  }

  /** Exact native session binding, independent of names and roster prose. */
  public personaForOccupant(occupantId: string): string | undefined {
    const matches = [...this.bindings.values()].filter((binding) => binding.occupantId === occupantId);
    return matches.length === 1 ? matches[0]!.personaId : undefined;
  }

  public async close(): Promise<void> {
    this.closed = true;
    await this.migration?.catch(() => undefined);
    await this.flushQueue;
    if (this.journalLock) {
      const owner = JSON.parse(readFileSync(join(this.journalLock.path, "owner.json"), "utf8")) as {
        nonce?: string;
      };
      if (owner.nonce === this.journalLock.nonce) rmSync(this.journalLock.path, { recursive: true });
      this.journalLock = undefined;
    }
  }

  /** Resolve Herdr subjects to durable characters, then bind their current occupants and seats. */
  public reconcile(observedSeats: readonly ObservedFleetSeat[]): readonly OperatorFleetSeat[] {
    const previousRecords = new Map(this.records);
    const previousBindings = new Map(this.bindings);
    let changed = false;
    const seats = observedSeats.map((observed) => {
      const bound = this.bindSeat(observed);
      changed ||= bound.changed;
      return bound.seat;
    });
    if (changed) {
      try {
        this.save();
      } catch (error) {
        this.records.clear();
        this.bindings.clear();
        for (const [personaId, persona] of previousRecords) this.records.set(personaId, persona);
        for (const [subject, binding] of previousBindings) this.bindings.set(subject, binding);
        throw error;
      }
    }
    return seats;
  }

  /** Preserve the operator's chosen hire name before a terminal title can change. */
  public adoptSpawn(
    observed: ObservedFleetSeat,
    name: string,
    role?: OperatorAgentRole,
    onRoleWrite?: (status: PersonaRoleWrite) => void,
    projectId = DEFAULT_PROJECT_ID,
  ): OperatorFleetSeat {
    const previousRecords = new Map(this.records);
    const previousBindings = new Map(this.bindings);
    const { seat } = this.bindSeat(observed);
    const current = this.records.get(seat.personaId);
    if (current === undefined) throw new Error("Agent persona binding did not create a character");
    const now = new Date().toISOString();
    this.records.set(seat.personaId, {
      schemaVersion: 1,
      personaId: seat.personaId,
      name: previousRecords.get(seat.personaId)?.name ?? name,
      appearance: current.appearance,
      // A move re-adopts the same character; it keeps the role it had.
      ...((this.projectStore ? current.role : (role ?? current.role)) === undefined
        ? {}
        : { role: this.projectStore ? current.role : (role ?? current.role) }),
      harness: seat.harness,
      ...(current.avatarRevision === undefined ? {} : { avatarRevision: current.avatarRevision }),
      createdAt: current.createdAt,
      updatedAt: now,
    });
    try {
      if (this.projectStore && role !== undefined) {
        let status: PersonaRoleWrite;
        try {
          status = {
            outcome: "pending",
            operationId: this.queueProjectRole(seat.personaId, role, projectId),
          };
        } catch {
          status = { outcome: "unsaved" };
        }
        onRoleWrite?.(status);
      }
      this.save();
    } catch (error) {
      this.records.clear();
      this.bindings.clear();
      for (const [personaId, persona] of previousRecords) this.records.set(personaId, persona);
      for (const [subject, binding] of previousBindings) this.bindings.set(subject, binding);
      throw error;
    }
    return { ...seat, title: this.records.get(seat.personaId)!.name };
  }

  /**
   * Every character, the ones that spoke most recently first.
   *
   * An inbox is read from the top, so the thread with something new in it is
   * the one that belongs there — the same order the registry already lists
   * conversations and channels in. A character with no thread yet has nothing
   * to be recent about and sits after the ones that do, alphabetically, which
   * is also the whole order before anybody has said anything.
   */
  public all(
    seats: readonly OperatorFleetSeat[],
    conversationForPersona: (personaId: string) => OperatorConversation | undefined,
  ): readonly OperatorAgentPersona[] {
    const active = new Map(seats.map((seat) => [seat.personaId, seat.seatId]));
    return [...this.records.values()]
      .map((persona) => {
        const activeSeatId = active.get(persona.personaId);
        const conversation = conversationForPersona(persona.personaId);
        return {
          persona: {
            ...persona,
            ...(activeSeatId === undefined ? {} : { activeSeatId }),
            ...(conversation === undefined ? {} : { conversationId: conversation.conversationId }),
          },
          lastActivityAt: conversation?.updatedAt ?? "",
        };
      })
      .sort(
        (left, right) =>
          right.lastActivityAt.localeCompare(left.lastActivityAt) ||
          left.persona.name.localeCompare(right.persona.name),
      )
      .map(({ persona }) => persona);
  }

  public update(input: UpdateOperatorAgentPersona): OperatorAgentPersona {
    const parsed = UpdateOperatorAgentPersonaSchema.parse(input);
    const current = this.records.get(parsed.personaId);
    if (current === undefined) throw new Error(`Unknown agent ${parsed.personaId}`);
    const image = parsed.avatarPngBase64 === undefined ? undefined : validatedPng(parsed.avatarPngBase64);
    const avatarRevision =
      image === undefined ? current.avatarRevision : createHash("sha256").update(image).digest("hex");
    if (image !== undefined && avatarRevision !== undefined) {
      this.writeAvatar(parsed.personaId, avatarRevision, image);
    }
    const updated: OperatorAgentPersona = {
      ...current,
      name: parsed.name ?? current.name,
      appearance: parsed.appearance ?? current.appearance,
      ...(avatarRevision === undefined ? {} : { avatarRevision }),
      updatedAt: new Date().toISOString(),
    };
    this.records.set(parsed.personaId, updated);
    try {
      this.save();
    } catch (error) {
      this.records.set(parsed.personaId, current);
      throw error;
    }
    return updated;
  }

  /**
   * Built-in roles, then the custom roles characters hold, most held first
   * (ADR 0208). Roles compare case-insensitively; a custom role shows the
   * casing its most recently updated holder was given.
   */
  public roles(): readonly OperatorAgentRoleSummary[] {
    const held = new Map<string, { role: string; count: number; updatedAt: string }>();
    for (const persona of this.records.values()) {
      if (persona.role === undefined) continue;
      const key = operatorAgentRoleKey(persona.role);
      const current = held.get(key);
      held.set(key, {
        role: current === undefined || persona.updatedAt >= current.updatedAt ? persona.role : current.role,
        count: (current?.count ?? 0) + 1,
        updatedAt:
          current === undefined || persona.updatedAt >= current.updatedAt
            ? persona.updatedAt
            : current.updatedAt,
      });
    }
    const builtIns = OPERATOR_AGENT_ROLES.map((role) => ({
      role,
      builtIn: true,
      count: held.get(role)?.count ?? 0,
    }));
    const custom = [...held.entries()]
      .filter(([key]) => !(OPERATOR_AGENT_ROLES as readonly string[]).includes(key))
      .map(([, entry]) => ({ role: entry.role, builtIn: false, count: entry.count }))
      .sort((left, right) => right.count - left.count || left.role.localeCompare(right.role));
    return [...builtIns, ...custom];
  }

  /** Assign or clear a character's team role (ADR 0208). */
  public setRole(input: SetOperatorAgentPersonaRole): OperatorAgentPersona {
    if (this.projectStore) throw new Error("Use the project role setter after migration");
    const parsed = SetOperatorAgentPersonaRoleSchema.parse(input);
    if (parsed.projectId !== undefined && parsed.projectId !== DEFAULT_PROJECT_ID)
      throw new Error("Project roles require the project settings store");
    const current = this.records.get(parsed.personaId);
    if (current === undefined) throw new Error(`Unknown agent ${parsed.personaId}`);
    const { role: _role, ...rest } = current;
    const updated: OperatorAgentPersona = {
      ...rest,
      ...(parsed.role === null ? {} : { role: parsed.role }),
      updatedAt: new Date().toISOString(),
    };
    this.records.set(parsed.personaId, updated);
    try {
      this.save();
    } catch (error) {
      this.records.set(parsed.personaId, current);
      throw error;
    }
    return updated;
  }

  public presentation(
    personaId: string,
    publicHostname: string | undefined,
  ): { readonly username: string; readonly avatarUrl?: string } {
    const persona = this.records.get(personaId);
    if (persona === undefined) return { username: personaId };
    const avatarUrl =
      persona.avatarRevision === undefined
        ? undefined
        : publicAvatarUrl(publicHostname, persona.personaId, persona.avatarRevision);
    return {
      username: persona.name,
      ...(avatarUrl === undefined ? {} : { avatarUrl }),
    };
  }

  private bindSeat(observed: ObservedFleetSeat): { readonly seat: OperatorFleetSeat; changed: boolean } {
    let changed = false;
    let binding = this.bindings.get(observed.subject);
    let renamed = false;
    if (binding === undefined && observed.renamed !== undefined) {
      // Naming an agent in Herdr re-keys the character the operator is already
      // talking to; it never hires a stranger (ADR 0147). Without this the
      // rename strands that persona and its conversation offline, and the
      // replacement takes its name from a terminal title nobody chose.
      const previous = this.bindings.get(observed.renamed.from);
      if (previous !== undefined) {
        this.bindings.delete(observed.renamed.from);
        const { account, ...identity } = previous;
        binding = {
          ...identity,
          ...(previous.occupantId === observed.occupantId && account ? { account } : {}),
          subject: observed.subject,
          occupantId: observed.occupantId,
        };
        this.bindings.set(observed.subject, binding);
        changed = true;
        renamed = true;
      }
    }
    if (binding === undefined) {
      // Compatibility only: v1 derived persona ids from occupants. Retaining a
      // matching record preserves its conversations; new ids are always minted.
      const legacyPersonaId = `agent-${observed.occupantId.slice("session-".length)}`;
      const personaId = this.records.has(legacyPersonaId) ? legacyPersonaId : `agent-${randomUUID()}`;
      binding = { subject: observed.subject, personaId, occupantId: observed.occupantId };
      this.bindings.set(observed.subject, binding);
      changed = true;
    } else if (binding.occupantId !== observed.occupantId) {
      binding = { subject: binding.subject, personaId: binding.personaId, occupantId: observed.occupantId };
      this.bindings.set(observed.subject, binding);
      changed = true;
    }

    if (
      observed.account &&
      (binding.account?.label !== observed.account.label || binding.account?.home !== observed.account.home)
    ) {
      binding = { ...binding, account: observed.account };
      this.bindings.set(observed.subject, binding);
      changed = true;
    }
    // A name the operator typed outranks a title the harness happened to write.
    const chosen =
      observed.renamed === undefined ? undefined : OperatorAgentNameSchema.safeParse(observed.renamed.name);
    const current = this.records.get(binding.personaId);
    if (current === undefined) {
      const now = new Date().toISOString();
      const discoveredName =
        chosen?.success === true ? chosen : OperatorAgentNameSchema.safeParse(observed.title.trim());
      this.records.set(binding.personaId, {
        schemaVersion: 1,
        personaId: binding.personaId,
        name: discoveredName.success ? discoveredName.data : `${observed.harness} agent`,
        appearance: defaultOperatorAgentAppearance(observed.harness, binding.personaId),
        harness: observed.harness,
        createdAt: now,
        updatedAt: now,
      });
      changed = true;
    } else {
      // Only the rename itself adopts the Herdr name, so a later rename in the
      // app is not overwritten on the next census.
      const name = renamed && chosen?.success === true ? chosen.data : current.name;
      if (name !== current.name || current.harness !== observed.harness) {
        this.records.set(binding.personaId, {
          ...current,
          name,
          harness: observed.harness,
          updatedAt: new Date().toISOString(),
        });
        changed = true;
      }
    }

    // Pane ids are the captain's join to Herdr's edges, not part of the seat
    // contract; the wire carries seat ids only.
    const {
      subject: _subject,
      renamed: _renamed,
      paneId: _paneId,
      parentPaneId: _parentPaneId,
      session: _session,
      ...seat
    } = observed;
    return {
      seat: {
        ...seat,
        ...(binding.account ? { account: binding.account } : {}),
        personaId: binding.personaId,
        title: this.records.get(binding.personaId)!.name,
      },
      changed,
    };
  }

  private writeAvatar(personaId: string, revision: string, image: Buffer): void {
    const path = join(this.avatarDir, `${encodeURIComponent(personaId)}-${revision}.png`);
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, image, { mode: 0o600 });
    renameSync(temporary, path);
  }

  private save(): void {
    if (this.unreadable) throw new Error("Agent identity state is unreadable; refusing to overwrite it");
    if (this.initializing) throw new Error("Agent identity migration is still in progress");
    durableJson(this.path, {
      schemaVersion: 2,
      personas: [...this.records.values()].map((persona) => {
        if (!this.projectStore) return persona;
        const { role: _role, ...identity } = persona;
        return identity;
      }),
      bindings: [...this.bindings.values()],
    });
  }
}

function validatedPng(encoded: string): Buffer {
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new Error("Agent avatar is not valid base64");
  }
  const image = Buffer.from(encoded, "base64");
  if (image.length === 0 || image.length > MAX_AVATAR_BYTES) {
    throw new Error(`Agent avatar must be at most ${String(MAX_AVATAR_BYTES)} bytes`);
  }
  if (
    image.length < 33 ||
    !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    image.readUInt32BE(8) !== 13 ||
    image.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error("Agent avatar must be a PNG image");
  }
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 1_024 || height > 1_024) {
    throw new Error("Agent avatar dimensions must be between 1 and 1024 pixels");
  }
  let offset = 8;
  let complete = false;
  while (offset + 12 <= image.length) {
    const length = image.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > image.length) break;
    if (image.toString("ascii", offset + 4, offset + 8) === "IEND") {
      complete = length === 0 && end === image.length;
      break;
    }
    offset = end;
  }
  if (!complete) throw new Error("Agent avatar must be a complete PNG image");
  return image;
}

function publicAvatarUrl(
  publicHostname: string | undefined,
  personaId: string,
  revision: string,
): string | undefined {
  const input = publicHostname?.trim();
  if (!input) return undefined;
  try {
    const origin = new URL(input.includes("://") ? input : `https://${input}`);
    if (origin.protocol !== "https:") return undefined;
    origin.pathname = `/avatars/${encodeURIComponent(personaId)}-${revision}.png`;
    origin.search = "";
    origin.hash = "";
    return origin.toString();
  } catch {
    return undefined;
  }
}

function durableJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

/** Same conservative dead-process recovery as the body store: PID reuse denies takeover. */
function acquireJournalWriter(journal: string): { path: string; nonce: string } {
  const path = `${journal}.lock`;
  const recovery = `${path}.recovery`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(recovery)) throw new Error("Project role journal recovery requires inspection");
  const schema = z.object({ pid: z.number().int().positive(), nonce: z.string().uuid() }).strict();
  const readOwner = () => schema.parse(JSON.parse(readFileSync(join(path, "owner.json"), "utf8")));
  const dead = (pid: number) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  };
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const original = readOwner();
    const inode = statSync(path).ino;
    if (!dead(original.pid))
      throw new Error("Project role journal already has a live or unverifiable writer");
    mkdirSync(recovery, { mode: 0o700 });
    try {
      const current = readOwner();
      if (statSync(path).ino !== inode || current.nonce !== original.nonce || !dead(current.pid))
        throw new Error("Project role journal writer changed during recovery");
      rmSync(path, { recursive: true });
      mkdirSync(path, { mode: 0o700 });
    } finally {
      rmSync(recovery, { recursive: true });
    }
  }
  const nonce = randomUUID();
  durableJson(join(path, "owner.json"), { pid: process.pid, nonce });
  return { path, nonce };
}
