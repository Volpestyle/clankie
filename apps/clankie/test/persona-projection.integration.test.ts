import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  defaultOperatorAgentAppearance,
  OPERATOR_AGENT_PERSONA_LIST_MAX,
  OperatorFleetSnapshotSchema,
  OperatorConversationServiceResultSchema,
} from "@clankie/protocol";
import { PersonaStore } from "../src/captain/personas.ts";
import { ConversationStore } from "../src/captain/conversations.ts";

it("projects more than a thousand retained identities into a valid fleet snapshot without dropping live or recent contacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "persona-projection-"));
  const conversations = new ConversationStore(join(root, "conversations"), async () => {
    throw new Error("Persona projection must never run a model");
  });
  try {
    // The retained-file shape is the same as the live 1,056-persona backlog.
    const records = Array.from({ length: OPERATOR_AGENT_PERSONA_LIST_MAX + 56 }, (_, index) => ({
      schemaVersion: 1,
      personaId: `agent-retained-${index}`,
      name: index < 1000 ? `Archived ${String(index).padStart(4, "0")}` : `Z retained ${index}`,
      appearance: defaultOperatorAgentAppearance("codex", `agent-retained-${index}`),
      harness: "codex",
      createdAt: "2026-10-12T05:54:34.159Z",
      updatedAt: "2026-10-12T05:54:34.159Z",
    }));
    const liveId = records.at(-1)!.personaId;
    const recentId = records.at(-2)!.personaId;
    const retainedId = records.at(-3)!.personaId;
    const path = join(root, "personas.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 2,
        personas: records,
        bindings: [{ subject: "live-contact", personaId: liveId, occupantId: `session-${"a".repeat(64)}` }],
      }),
    );
    const personas = new PersonaStore(root);
    const seats = personas.reconcile([
      {
        seatId: "term_live_contact",
        paneId: "w1:pLive",
        subject: "live-contact",
        occupantId: `session-${"a".repeat(64)}`,
        harness: "codex",
        status: "working",
        title: "Live contact",
      },
    ]);
    expect(seats[0]!.personaId).toBe(liveId);
    await conversations.serve({
      op: "create",
      schemaVersion: 1,
      scope: { kind: "persona", personaId: recentId },
      title: "Recent retained contact",
    });
    const lookup = (personaId: string) => conversations.conversationForPersona(personaId);
    const before = await readFile(path);
    const all = personas.all(seats, lookup);
    expect(all).toHaveLength(1056);
    const base = { schemaVersion: 1, cursor: "projection-1", seats: [...seats], channels: [] };
    expect(OperatorFleetSnapshotSchema.safeParse({ ...base, personas: all }).success).toBe(false);
    const snapshot = OperatorFleetSnapshotSchema.parse({
      ...base,
      personas: personas.projection(seats, lookup),
    });
    OperatorConversationServiceResultSchema.parse({ op: "fleet", schemaVersion: 1, snapshot });
    expect(snapshot.personas).toHaveLength(OPERATOR_AGENT_PERSONA_LIST_MAX);
    expect(snapshot.personas[0]).toMatchObject({ personaId: liveId, activeSeatId: seats[0]!.seatId });
    expect(snapshot.personas[1]).toMatchObject({
      personaId: recentId,
      conversationId: lookup(recentId)!.conversationId,
    });
    expect(snapshot.personas.some((persona) => persona.personaId === retainedId)).toBe(false);
    expect(await readFile(path)).toEqual(before);
    expect(personas.all([], lookup).some((persona) => persona.personaId === retainedId)).toBe(true);
    expect(
      personas.update({ schemaVersion: 1, personaId: retainedId, name: "Retained identity" }),
    ).toMatchObject({ personaId: retainedId });
    expect(new PersonaStore(root).all([], lookup)).toHaveLength(1056);
  } finally {
    await conversations.close();
    await rm(root, { recursive: true, force: true });
  }
});
