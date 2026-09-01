import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultOperatorAgentAppearance,
  OperatorAgentNameSchema,
  OperatorAgentPersonaIdSchema,
  OperatorAgentPersonaSchema,
  UpdateOperatorAgentPersonaSchema,
  type OperatorAgentPersona,
  type OperatorFleetSeat,
  type UpdateOperatorAgentPersona,
} from "@clankie/protocol";
import { z } from "zod";
import type { ObservedFleetSeat } from "./herdr-census.ts";

const MAX_AVATAR_BYTES = 512 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const LegacyPersonaFileSchema = z
  .object({ schemaVersion: z.literal(1), personas: z.array(OperatorAgentPersonaSchema) })
  .strict();
const PersonaBindingSchema = z
  .object({
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
      personas: z.array(OperatorAgentPersonaSchema),
      bindings: z.array(PersonaBindingSchema),
    })
    .strict(),
]);

type PersonaBinding = z.infer<typeof PersonaBindingSchema>;

/** Host-owned fleet characters. Herdr seats are only their current locations. */
export class PersonaStore {
  private readonly path: string;
  private readonly avatarDir: string;
  private readonly records = new Map<string, OperatorAgentPersona>();
  private readonly bindings = new Map<string, PersonaBinding>();
  private unreadable = false;

  public constructor(stateDir: string) {
    this.path = join(stateDir, "personas.json");
    this.avatarDir = join(stateDir, "persona-avatars");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(this.avatarDir, { recursive: true });
    if (!existsSync(this.path)) return;
    try {
      const state = PersonaFileSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
      for (const persona of state.personas) {
        // A seat is live state and is always rebuilt from Herdr after launch.
        const { activeSeatId: _activeSeatId, conversationId: _conversationId, ...persisted } = persona;
        this.records.set(persona.personaId, persisted);
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
  public adoptSpawn(observed: ObservedFleetSeat, name: string): OperatorFleetSeat {
    const previousRecords = new Map(this.records);
    const previousBindings = new Map(this.bindings);
    const { seat } = this.bindSeat(observed);
    const current = this.records.get(seat.personaId);
    if (current === undefined) throw new Error("Agent persona binding did not create a character");
    const now = new Date().toISOString();
    this.records.set(seat.personaId, {
      schemaVersion: 1,
      personaId: seat.personaId,
      name,
      appearance: current.appearance,
      harness: seat.harness,
      ...(current.avatarRevision === undefined ? {} : { avatarRevision: current.avatarRevision }),
      createdAt: current.createdAt,
      updatedAt: now,
    });
    try {
      this.save();
    } catch (error) {
      this.records.clear();
      this.bindings.clear();
      for (const [personaId, persona] of previousRecords) this.records.set(personaId, persona);
      for (const [subject, binding] of previousBindings) this.bindings.set(subject, binding);
      throw error;
    }
    return seat;
  }

  public all(
    seats: readonly OperatorFleetSeat[],
    conversationIdForPersona: (personaId: string) => string | undefined,
  ): readonly OperatorAgentPersona[] {
    const active = new Map(seats.map((seat) => [seat.personaId, seat.seatId]));
    return [...this.records.values()]
      .map((persona) => {
        const activeSeatId = active.get(persona.personaId);
        const conversationId = conversationIdForPersona(persona.personaId);
        return {
          ...persona,
          ...(activeSeatId === undefined ? {} : { activeSeatId }),
          ...(conversationId === undefined ? {} : { conversationId }),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
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
      name: parsed.name,
      appearance: parsed.appearance,
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
        binding = { ...previous, subject: observed.subject, occupantId: observed.occupantId };
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
      binding = { ...binding, occupantId: observed.occupantId };
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

    const { subject: _subject, renamed: _renamed, ...seat } = observed;
    return { seat: { ...seat, personaId: binding.personaId }, changed };
  }

  private writeAvatar(personaId: string, revision: string, image: Buffer): void {
    const path = join(this.avatarDir, `${encodeURIComponent(personaId)}-${revision}.png`);
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, image, { mode: 0o600 });
    renameSync(temporary, path);
  }

  private save(): void {
    if (this.unreadable) throw new Error("Agent identity state is unreadable; refusing to overwrite it");
    const temporary = `${this.path}.tmp`;
    writeFileSync(
      temporary,
      `${JSON.stringify(
        {
          schemaVersion: 2,
          personas: [...this.records.values()],
          bindings: [...this.bindings.values()],
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    renameSync(temporary, this.path);
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
