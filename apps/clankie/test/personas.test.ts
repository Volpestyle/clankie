import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ObservedFleetSeat } from "../src/captain/herdr-census.ts";
import { PersonaStore } from "../src/captain/personas.ts";

const OCCUPANT_ONE = `session-${"a".repeat(64)}`;
const OCCUPANT_TWO = `session-${"b".repeat(64)}`;
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function observed(seatId: string, occupantId = OCCUPANT_ONE, subject = "atlas-ab12"): ObservedFleetSeat {
  return {
    seatId,
    subject,
    occupantId,
    harness: "codex",
    status: "working",
    title: "Build grove",
  };
}

describe("PersonaStore", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("keeps one minted character when a replacement occupant presents the same subject", () => {
    const root = mkdtempSync(join(tmpdir(), "clankie-personas-"));
    roots.push(root);
    const store = new PersonaStore(root);
    const first = store.reconcile([observed("term-1")])[0]!;
    expect(first.personaId).toMatch(
      /^agent-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    const updated = store.update({
      schemaVersion: 1,
      personaId: first.personaId,
      name: "Atlas",
      appearance: { variant: "azure", accessory: "implementer", shape: "squircle" },
      avatarPngBase64: PNG_BASE64,
    });
    const revision = createHash("sha256").update(Buffer.from(PNG_BASE64, "base64")).digest("hex");

    expect(updated.avatarRevision).toBe(revision);
    expect(existsSync(join(root, "persona-avatars", `${first.personaId}-${revision}.png`))).toBe(true);
    expect(store.presentation(first.personaId, "activity.clankie.bot")).toEqual({
      username: "Atlas",
      avatarUrl: `https://activity.clankie.bot/avatars/${first.personaId}-${revision}.png`,
    });

    const restarted = new PersonaStore(root);
    const replacement = restarted.reconcile([observed("term-9", OCCUPANT_TWO)])[0]!;
    expect(replacement.personaId).toBe(first.personaId);
    expect(replacement.occupantId).toBe(OCCUPANT_TWO);
    expect(restarted.all([replacement], () => "conversation-1")).toMatchObject([
      {
        personaId: first.personaId,
        name: "Atlas",
        activeSeatId: "term-9",
        conversationId: "conversation-1",
      },
    ]);
    expect(JSON.parse(readFileSync(join(root, "personas.json"), "utf8"))).toMatchObject({
      schemaVersion: 2,
      bindings: [{ subject: "atlas-ab12", personaId: first.personaId, occupantId: OCCUPANT_TWO }],
    });
  });

  it("rejects malformed image bytes without replacing the current identity", () => {
    const root = mkdtempSync(join(tmpdir(), "clankie-personas-"));
    roots.push(root);
    const store = new PersonaStore(root);
    const personaId = store.reconcile([observed("term-1")])[0]!.personaId;

    expect(() =>
      store.update({
        schemaVersion: 1,
        personaId,
        name: "Atlas",
        appearance: { variant: "azure", accessory: "implementer", shape: "squircle" },
        avatarPngBase64: Buffer.from("not a png").toString("base64"),
      }),
    ).toThrow(/PNG/u);
    expect(store.presentation(personaId, "activity.clankie.bot")).toEqual({ username: "Build grove" });
  });

  it("migrates a v1 session-derived record once without changing its public identity", () => {
    const root = mkdtempSync(join(tmpdir(), "clankie-personas-"));
    roots.push(root);
    const legacyPersonaId = `agent-${OCCUPANT_ONE.slice("session-".length)}`;
    const now = new Date().toISOString();
    writeFileSync(
      join(root, "personas.json"),
      JSON.stringify({
        schemaVersion: 1,
        personas: [
          {
            schemaVersion: 1,
            personaId: legacyPersonaId,
            name: "Atlas",
            appearance: { variant: "teal", accessory: "planner", shape: "circle" },
            harness: "codex",
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
    );

    const seat = new PersonaStore(root).reconcile([observed("term-1")])[0]!;
    expect(seat.personaId).toBe(legacyPersonaId);
    expect(JSON.parse(readFileSync(join(root, "personas.json"), "utf8"))).toMatchObject({
      schemaVersion: 2,
      bindings: [{ subject: "atlas-ab12", personaId: legacyPersonaId, occupantId: OCCUPANT_ONE }],
    });
  });
});
