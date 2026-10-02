import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OperatorConversation } from "@clankie/protocol";
import type { ObservedFleetSeat } from "../src/captain/herdr-census.ts";
import { PersonaStore } from "../src/captain/personas.ts";

const OCCUPANT_ONE = `session-${"a".repeat(64)}`;
const OCCUPANT_TWO = `session-${"b".repeat(64)}`;
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function observed(seatId: string, occupantId = OCCUPANT_ONE, subject = "atlas-ab12"): ObservedFleetSeat {
  return {
    seatId,
    paneId: `w1:p${seatId}`,
    subject,
    occupantId,
    harness: "codex",
    status: "working",
    title: "Build grove",
  };
}

/** Just enough of a registry record to stand in for a persona's thread. */
function conversation(conversationId: string, updatedAt = "2026-01-01T00:00:00.000Z"): OperatorConversation {
  return {
    schemaVersion: 1,
    conversationId,
    scope: { kind: "persona", personaId: "whoever" },
    title: conversationId,
    isDefault: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
    sessionState: "active",
    revision: 1,
  };
}

describe("PersonaStore", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("retains the hired account across roster refresh and restart, but not a replacement occupant", () => {
    const root = mkdtempSync(join(tmpdir(), "clankie-personas-account-"));
    roots.push(root);
    const account = { label: "second", home: "/owner/codex-second" };
    const seat = observed("term-1");
    expect(new PersonaStore(root).adoptSpawn({ ...seat, account }, "Worker").account).toEqual(account);
    const restarted = new PersonaStore(root);
    expect(restarted.reconcile([seat])[0]?.account).toEqual(account);
    expect(restarted.reconcile([{ ...seat, occupantId: OCCUPANT_TWO }])[0]?.account).toBeUndefined();
  });

  it("persists a role from the hire or the owner, keeps it across a move, and clears it", () => {
    const root = mkdtempSync(join(tmpdir(), "clankie-personas-role-"));
    roots.push(root);
    const store = new PersonaStore(root);
    const seat = store.adoptSpawn(observed("term-1"), "Smith", "designer");
    const persona = () => store.all([], () => undefined).find((entry) => entry.personaId === seat.personaId);
    expect(persona()?.role).toBe("designer");
    // A move re-adopts under the same name without naming a role.
    store.adoptSpawn(observed("term-2"), "Smith");
    expect(persona()?.role).toBe("designer");
    expect(store.setRole({ schemaVersion: 1, personaId: seat.personaId, role: "builder" }).role).toBe(
      "builder",
    );
    expect(
      new PersonaStore(root).all([], () => undefined).find((entry) => entry.personaId === seat.personaId)
        ?.role,
    ).toBe("builder");
    expect(store.setRole({ schemaVersion: 1, personaId: seat.personaId, role: null })).not.toHaveProperty(
      "role",
    );
    expect(() => store.setRole({ schemaVersion: 1, personaId: "agent-missing", role: "tester" })).toThrow(
      "Unknown agent",
    );
    expect(() => store.setRole({ schemaVersion: 1, personaId: seat.personaId, role: "wiz/ard" })).toThrow();
  });

  it("holds custom roles in the owner's casing and lists roles in use case-insensitively", () => {
    const root = mkdtempSync(join(tmpdir(), "clankie-personas-roles-"));
    roots.push(root);
    const store = new PersonaStore(root);
    const one = store.adoptSpawn(observed("term-1", OCCUPANT_ONE, "one-ab12"), "One");
    const two = store.adoptSpawn(observed("term-2", OCCUPANT_TWO, "two-ab12"), "Two");
    expect(
      store.setRole({ schemaVersion: 1, personaId: one.personaId, role: "  sound   designer" }).role,
    ).toBe("sound designer");
    expect(store.setRole({ schemaVersion: 1, personaId: two.personaId, role: "Sound Designer" }).role).toBe(
      "Sound Designer",
    );
    const listed = store.roles();
    expect(listed.slice(0, 6).map((entry) => [entry.role, entry.builtIn, entry.count])).toEqual(
      ["planner", "designer", "builder", "tester", "reviewer", "researcher"].map((role) => [role, true, 0]),
    );
    expect(listed.slice(6)).toEqual([{ role: "Sound Designer", builtIn: false, count: 2 }]);
    store.setRole({ schemaVersion: 1, personaId: one.personaId, role: "Designer" });
    expect(store.roles().find((entry) => entry.role === "designer")?.count).toBe(1);
    // Restart keeps the casing.
    expect(new PersonaStore(root).roles().slice(6)).toEqual([
      { role: "Sound Designer", builtIn: false, count: 1 },
    ]);
  });

  it("never puts the internal harness session on a wire seat", () => {
    const root = mkdtempSync(join(tmpdir(), "clankie-personas-session-"));
    roots.push(root);
    const [seat] = new PersonaStore(root).reconcile([
      { ...observed("term-1"), session: { source: "herdr:claude", kind: "id", value: "abc" } },
    ]);
    expect(seat).not.toHaveProperty("session");
  });

  it("carries the character across a Herdr rename instead of minting a stranger", () => {
    const root = mkdtempSync(join(tmpdir(), "clankie-personas-"));
    roots.push(root);
    const store = new PersonaStore(root);
    const paneSubject = "adhoc-0123456789abcdef0123";
    const before = store.reconcile([{ ...observed("term-1"), subject: paneSubject }])[0]!;
    store.update({
      schemaVersion: 1,
      personaId: before.personaId,
      name: "Build grove",
      appearance: { variant: "azure", accessory: "implementer", shape: "squircle" },
    });

    const after = store.reconcile([
      { ...observed("term-1"), subject: "atlas", renamed: { name: "Atlas", from: paneSubject } },
    ])[0]!;

    // Same character, now filed under the name and wearing it.
    expect(after.personaId).toBe(before.personaId);
    expect(store.all([after], () => undefined)).toMatchObject([
      { personaId: before.personaId, name: "Atlas" },
    ]);
    // The stranded pane key is gone, so the old contact cannot linger offline.
    const restarted = new PersonaStore(root);
    expect(restarted.reconcile([{ ...observed("term-1"), subject: paneSubject }])[0]!.personaId).not.toBe(
      before.personaId,
    );
  });

  it("leaves an app-chosen name alone on later censuses of a named seat", () => {
    const root = mkdtempSync(join(tmpdir(), "clankie-personas-"));
    roots.push(root);
    const store = new PersonaStore(root);
    const named = { ...observed("term-1"), subject: "atlas", renamed: { name: "Atlas", from: "adhoc-x" } };
    const seat = store.reconcile([named])[0]!;
    store.update({
      schemaVersion: 1,
      personaId: seat.personaId,
      name: "Atlas the Second",
      appearance: { variant: "azure", accessory: "implementer", shape: "squircle" },
    });

    store.reconcile([named]);

    expect(store.all([seat], () => undefined)).toMatchObject([{ name: "Atlas the Second" }]);
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
    expect(restarted.all([replacement], () => conversation("conversation-1"))).toMatchObject([
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

  it("lists the character that spoke most recently first, and the silent ones last by name", () => {
    const root = mkdtempSync(join(tmpdir(), "clankie-personas-"));
    roots.push(root);
    const store = new PersonaStore(root);
    const seats = store.reconcile([
      { ...observed("term-1", OCCUPANT_ONE, "atlas-ab12"), title: "Atlas" },
      { ...observed("term-2", OCCUPANT_TWO, "zed-cd34"), title: "Zed" },
      { ...observed("term-3", `session-${"c".repeat(64)}`, "mute-ef56"), title: "Mute" },
    ]);
    const byName = new Map(seats.map((seat) => [seat.personaId, seat.title]));
    // Alphabetically this is Atlas, Mute, Zed. Zed spoke last and Mute never has.
    const threads = new Map([
      ["Atlas", conversation("c-atlas", "2026-03-01T00:00:00.000Z")],
      ["Zed", conversation("c-zed", "2026-03-02T00:00:00.000Z")],
    ]);
    const listed = store.all(seats, (personaId) => threads.get(byName.get(personaId) ?? ""));
    expect(listed.map((persona) => persona.name)).toEqual(["Zed", "Atlas", "Mute"]);
  });
});

it("hides saved coordinator contacts without deleting their identity or thread access", () => {
  const root = mkdtempSync(join(tmpdir(), "clankie-internal-personas-"));
  try {
    const peer = (actor: string, label: string) => ({
      label,
      contact: {
        conversationId: "global-default",
        connectionId: "embedded",
        coordinator: "a".repeat(64),
        scope: "project",
        actor,
        generation: 1,
      },
    });
    const store = new PersonaStore(root);
    store.reconcileSwarm([peer("worker", "Clankie app reviewer")]);
    const worker = store.all([], () => undefined)[0]!;
    // Simulate a contact persisted by an older build, including operator edits.
    const legacy = { ...worker, personaId: "swarm-legacy", name: "clankie:global-default" };
    writeFileSync(
      join(root, "personas.json"),
      JSON.stringify({ schemaVersion: 1, personas: [worker, legacy] }),
    );
    const restored = new PersonaStore(root);
    restored.reconcileSwarm([
      peer("captain", "clankie:linear-inbox"),
      peer("runtime", "runtime:claude-code transport:herdr"),
      peer("worker", "Clankie app reviewer"),
    ]);
    expect(restored.all([], () => conversation("saved-thread")).map((p) => p.name)).toEqual([
      "Clankie app reviewer",
    ]);
    expect(restored.swarmContact("swarm-legacy")).toEqual(
      legacy.swarm && {
        conversationId: legacy.swarm.conversationId,
        connectionId: legacy.swarm.connectionId,
        coordinator: legacy.swarm.coordinator,
        scope: legacy.swarm.scope,
        actor: legacy.swarm.actor,
        generation: legacy.swarm.generation,
      },
    );
    expect(JSON.parse(readFileSync(join(root, "personas.json"), "utf8")).personas).toHaveLength(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
