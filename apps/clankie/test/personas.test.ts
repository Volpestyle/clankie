import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OperatorAgentPersonaIdSchema,
  OperatorAgentPersonaSchema,
  OperatorCodexAccountSchema,
  type OperatorConversation,
} from "@clankie/protocol";
import { z } from "zod";
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

  // Desktop-app hires once all carried the label "clankie · Work" as their name, so every
  // one bound one character and each message reached whichever seat bound last (#208).
  it("never merges two live seats that share a name into one character", () => {
    const root = mkdtempSync(join(tmpdir(), "clankie-shared-name-"));
    roots.push(root);
    const store = new PersonaStore(root);
    const desktop = (terminal: string, occupantId: string): ObservedFleetSeat => ({
      ...observed(`herdr-core/${terminal}`, occupantId, "herdr-core-clankie-work"),
      paneId: `herdr-core/${terminal}`,
      harness: "claude",
      title: "clankie · Work",
      renamed: {
        name: "clankie · Work",
        from: `adhoc-${createHash("sha256").update(`herdr-core/${terminal}`).digest("hex").slice(0, 20)}`,
      },
    });
    const seats = [desktop("t2q", OCCUPANT_ONE), desktop("t2t", OCCUPANT_TWO)];
    const first = store.reconcile(seats);
    expect(new Set(first.map((seat) => seat.personaId)).size).toBe(2);
    // Every later census keeps each seat its own character.
    for (let round = 0; round < 3; round++)
      expect(store.reconcile(seats).map((seat) => seat.personaId)).toEqual(
        first.map((seat) => seat.personaId),
      );
    // One seat alone keeps its name as usual.
    expect(store.reconcile([seats[0]!])[0]!.personaId).not.toBe(first[1]!.personaId);
  });

  it.each(["Codex Reviewer", "Claudette", "Claude Architect"])(
    "keeps the owner rename %s through repeated census and restart",
    (name) => {
      const root = mkdtempSync(join(tmpdir(), "clankie-owner-persona-name-"));
      roots.push(root);
      const original = { ...observed("term-1"), harness: "claude", title: "Claude Code" };
      const store = new PersonaStore(root);
      const seat = store.reconcile([original])[0]!;
      store.update({ schemaVersion: 1, personaId: seat.personaId, name });
      expect(store.reconcile([original])[0]!.title).toBe(name);
      const restarted = new PersonaStore(root);
      expect(restarted.reconcile([original])[0]!.title).toBe(name);
      expect(restarted.reconcile([{ ...original, title: "New native title" }])[0]!.title).toBe(name);
    },
  );

  it("keeps a Unicode owner rename through census, restart and re-adoption, without changing identity or appearance", () => {
    const root = mkdtempSync(join(tmpdir(), "clankie-persona-name-"));
    roots.push(root);
    const store = new PersonaStore(root);
    const original = observed("term-1");
    const seat = store.adoptSpawn(original, "Noor", "builder");
    const before = store.all([], () => undefined)[0]!;
    const updated = store.update({ schemaVersion: 1, personaId: seat.personaId, name: "  美咲 / نور  " });
    expect(updated.name).toBe("美咲 / نور");
    expect(updated.appearance).toEqual(before.appearance);
    const restarted = new PersonaStore(root);
    expect(restarted.reconcile([{ ...original, title: "fleet:pc/vuh1381-canary" }])[0]).toMatchObject({
      personaId: seat.personaId,
      seatId: seat.seatId,
      occupantId: seat.occupantId,
      title: updated.name,
    });
    expect(restarted.adoptSpawn(original, "Other name")).toMatchObject({
      personaId: seat.personaId,
      title: updated.name,
    });
    expect(restarted.all([], () => undefined)[0]).toMatchObject({
      name: updated.name,
      role: "builder",
      appearance: before.appearance,
    });
  });

  it("names a hire the census already filed under its pane title by the hire's name (VUH-2667)", () => {
    const root = mkdtempSync(join(tmpdir(), "clankie-persona-hire-race-"));
    roots.push(root);
    const store = new PersonaStore(root);
    // The harness titled its pane from the brief before the hire adopted it, as Rowan's did.
    const pane = {
      ...observed("term-1"),
      harness: "claude",
      title: "Clankie brief 9ffe6b76 assignment",
      subject: "adhoc-w5T-p2",
    };
    expect(store.reconcile([pane])[0]!.title).toBe("Clankie brief 9ffe6b76 assignment");
    const hired = store.adoptSpawn(
      { ...pane, subject: "rowan-1bb8", renamed: { name: "rowan-1bb8", from: pane.subject } },
      "Rowan",
    );
    expect(hired.title).toBe("Rowan");
    expect(new PersonaStore(root).all([hired], () => undefined)).toMatchObject([{ name: "Rowan" }]);
  });

  it("gives a re-adopted seat named only after its pane title a name read like a hire's, and keeps a chosen name (VUH-2667)", () => {
    const root = mkdtempSync(join(tmpdir(), "clankie-persona-adopted-"));
    roots.push(root);
    const store = new PersonaStore(root);
    const titled = (seatId: string, occupantId: string) => ({
      ...observed(seatId, occupantId, `adhoc-${seatId}`),
      harness: "claude",
      title: "Clankie captain brief assignment",
    });
    const [plain, named] = store.reconcile([titled("term-1", OCCUPANT_ONE), titled("term-2", OCCUPANT_TWO)]);
    store.nameAdopted({
      occupantId: OCCUPANT_ONE,
      title: "Clankie captain brief assignment",
      harness: "claude",
    });
    store.nameAdopted({
      occupantId: OCCUPANT_TWO,
      title: "Clankie captain brief assignment",
      harness: "claude",
      name: "basil-91c2",
    });
    const names = () =>
      new PersonaStore(root)
        .all([plain!, named!], () => undefined)
        .map((persona) => [persona.personaId, persona.name] as const);
    // Its Herdr handle reads as a hire's name does ("basil-91c2" is Basil); without one, one is
    // picked for it.
    const handle = new Map(names()).get(plain!.personaId)!;
    expect(handle).toMatch(/^[A-Z][a-z]+$/u);
    expect(new Map(names()).get(named!.personaId)).toBe("Basil");
    // Stable, and an owner's choice outlives the next adoption.
    store.nameAdopted({
      occupantId: OCCUPANT_ONE,
      title: "Clankie captain brief assignment",
      harness: "claude",
    });
    expect(new Map(names()).get(plain!.personaId)).toBe(handle);
    store.update({ schemaVersion: 1, personaId: plain!.personaId, name: "Juniper" });
    store.nameAdopted({
      occupantId: OCCUPANT_ONE,
      title: "Clankie captain brief assignment",
      harness: "claude",
    });
    expect(new Map(names()).get(plain!.personaId)).toBe("Juniper");
  });

  it("leaves a re-adopted seat's name as it was when it can't be saved (VUH-2667)", () => {
    const root = mkdtempSync(join(tmpdir(), "clankie-persona-adopted-unsaved-"));
    roots.push(root);
    const store = new PersonaStore(root);
    const title = "Clankie captain brief assignment";
    const [seat] = store.reconcile([
      { ...observed("term-1", OCCUPANT_ONE, "adhoc-term-1"), harness: "claude", title },
    ]);
    chmodSync(root, 0o500);
    try {
      expect(() =>
        store.nameAdopted({ occupantId: OCCUPANT_ONE, title, harness: "claude", name: "basil-91c2" }),
      ).toThrow();
    } finally {
      chmodSync(root, 0o700);
    }
    expect(store.all([seat!], () => undefined)).toMatchObject([{ name: title }]);
  });

  it("preserves the current name on appearance-only and avatar-only saves across restart and census", () => {
    const root = mkdtempSync(join(tmpdir(), "clankie-persona-avatar-name-"));
    roots.push(root);
    const store = new PersonaStore(root);
    const original = observed("term-1");
    const seat = store.adoptSpawn(original, "Noor", "builder");
    store.update({ schemaVersion: 1, personaId: seat.personaId, name: "美咲" });
    const appearance = { variant: "azure", accessory: "implementer", shape: "squircle" } as const;
    expect(store.update({ schemaVersion: 1, personaId: seat.personaId, appearance })).toMatchObject({
      name: "美咲",
      appearance,
    });
    const avatar = store.update({ schemaVersion: 1, personaId: seat.personaId, avatarPngBase64: PNG_BASE64 });
    expect(avatar).toMatchObject({ name: "美咲", appearance, role: "builder" });
    expect(avatar.avatarRevision).toBe(
      createHash("sha256").update(Buffer.from(PNG_BASE64, "base64")).digest("hex"),
    );
    const restarted = new PersonaStore(root);
    expect(restarted.reconcile([original])[0]).toMatchObject({ personaId: seat.personaId, title: "美咲" });
    expect(restarted.all([], () => undefined)[0]).toMatchObject({
      name: "美咲",
      appearance,
      avatarRevision: avatar.avatarRevision,
    });
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

it("loads retired contact fields as offline identity without losing native personas or threads", () => {
  const root = mkdtempSync(join(tmpdir(), "clankie-retired-personas-"));
  try {
    const store = new PersonaStore(root);
    const seats = store.reconcile([observed("native")]);
    const native = store.all(seats, () => undefined)[0]!;
    const retired = {
      ...native,
      personaId: "swarm-legacy",
      name: "Saved reviewer",
      harness: "swarm",
      swarm: { available: true },
    };
    writeFileSync(
      join(root, "personas.json"),
      JSON.stringify({ schemaVersion: 1, personas: [native, retired] }),
    );
    const restored = new PersonaStore(root);
    const personas = restored.all([], () => conversation("saved-thread"));
    expect(personas).toHaveLength(2);
    expect(personas.find((p) => p.personaId === retired.personaId)).toMatchObject({
      conversationId: "saved-thread",
    });
    expect(personas.every((p) => !("swarm" in p) && p.activeSeatId === undefined)).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "personas.json"), "utf8")).personas).toHaveLength(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("gives a Claude hire whose Herdr name was dropped back its hire's persona, as on the live fleet (LOCAL-VUH-59)", () => {
  const root = mkdtempSync(join(tmpdir(), "clankie-lost-handle-personas-"));
  try {
    // The live store on 2026-10-28: each hire's own binding, named after its handle, beside the
    // pane binding the census made once Herdr dropped the name ("Quill" was picked for it). None
    // carries a marker yet; Clankie's hire ledger says which subjects it minted.
    const sable = `session-${"4".repeat(64)}`;
    const wynn = `session-${"a".repeat(64)}`;
    const named = `session-${"c".repeat(64)}`;
    const handStarted = `session-${"d".repeat(64)}`;
    const persona = (personaId: string, name: string) => ({
      schemaVersion: 1,
      personaId,
      name,
      appearance: { variant: "azure", accessory: "implementer", shape: "squircle" },
      harness: "claude",
      createdAt: "2026-10-28T01:10:34.834Z",
      updatedAt: "2026-10-28T01:37:41.422Z",
    });
    const ids = {
      sable: "agent-f6c1903f-5787-4a45-a273-1dd247964f1b",
      quill: "agent-7a3b14ce-d31b-4905-a7ed-4fec1bd5e18b",
      wynn: "agent-c77e7445-f1f6-45b2-b8e6-5d08be5d693e",
      wynnPane: "agent-e56833a0-63cf-4f12-af3f-cb9731fc52f0",
      tess: "agent-00000000-0000-4000-8000-000000000001",
      juniper: "agent-00000000-0000-4000-8000-000000000002",
      solo: "agent-00000000-0000-4000-8000-000000000003",
    };
    writeFileSync(
      join(root, "personas.json"),
      JSON.stringify({
        schemaVersion: 2,
        personas: [
          persona(ids.sable, "sable-9e78"),
          persona(ids.quill, "Quill"),
          persona(ids.wynn, "wynn-e3f1"),
          persona(ids.wynnPane, "Clankie captain brief assignment"),
          persona(ids.tess, "tess-07c2"),
          persona(ids.juniper, "Juniper"),
          persona(ids.solo, "Build grove"),
        ],
        bindings: [
          { subject: "pc-sable-9e78", personaId: ids.sable, occupantId: sable },
          { subject: "adhoc-a718d701d04fa111e3da", personaId: ids.quill, occupantId: sable },
          { subject: "wynn-e3f1", personaId: ids.wynn, occupantId: wynn },
          { subject: "adhoc-b2192b2c6b94d951c27a", personaId: ids.wynnPane, occupantId: wynn },
          // The owner renamed this pane's own persona: it keeps it.
          { subject: "tess-07c2", personaId: ids.tess, occupantId: named },
          { subject: "adhoc-0000000000000000000c", personaId: ids.juniper, occupantId: named },
          // A pane started by hand: no hire stands behind it.
          { subject: "adhoc-0000000000000000000d", personaId: ids.solo, occupantId: handStarted },
        ],
      }),
    );
    // The owner named this pane's own persona in the app.
    writeFileSync(
      join(root, "personas.markers.json"),
      JSON.stringify({ schemaVersion: 1, hired: [], ownerNamed: [ids.juniper] }),
    );
    // The hire ledger: the title each hire's handle was minted from. The hand-started pane has none.
    const ledger = new Map([
      [sable, "Sable"],
      [wynn, "Wynn"],
      [named, "Tess"],
    ]);
    const hireTitle = (seat: ObservedFleetSeat) => ledger.get(seat.occupantId);
    const unnamed = (seatId: string, paneId: string, subject: string, occupantId: string) => ({
      seatId,
      paneId,
      subject,
      occupantId,
      harness: "claude",
      status: "working" as const,
      title: "Clankie captain brief assignment",
    });
    const live = [
      unnamed("pc/term_65edc3a6edf0325", "pc/w18:p15", "adhoc-a718d701d04fa111e3da", sable),
      unnamed("term_65edc2c43c2861d8", "w4F:p3D", "adhoc-b2192b2c6b94d951c27a", wynn),
      unnamed("term_named", "w1:p3", "adhoc-0000000000000000000c", named),
      { ...unnamed("term_solo", "w1:p4", "adhoc-0000000000000000000d", handStarted), title: "Build grove" },
    ];
    // Without the ledger nothing marks a subject as Clankie's, so nothing moves.
    const unread = mkdtempSync(join(tmpdir(), "clankie-lost-handle-unread-"));
    try {
      for (const file of ["personas.json", "personas.markers.json"])
        writeFileSync(join(unread, file), readFileSync(join(root, file)));
      expect(new PersonaStore(unread).reconcile(live).map((seat) => seat.personaId)).toEqual([
        ids.quill,
        ids.wynnPane,
        ids.juniper,
        ids.solo,
      ]);
    } finally {
      rmSync(unread, { recursive: true, force: true });
    }
    const store = new PersonaStore(root);
    const seats = store.reconcile(live, hireTitle);
    // The hires read as the names they were hired under, each bound once, so the tracker finds them.
    expect(seats.map((seat) => [seat.personaId, seat.title])).toEqual([
      [ids.sable, "Sable"],
      [ids.wynn, "Wynn"],
      [ids.juniper, "Juniper"],
      [ids.solo, "Build grove"],
    ]);
    expect(store.boundPersona(seats, "pc/term_65edc3a6edf0325", sable)?.name).toBe("Sable");
    expect(store.boundPersona(seats, "term_65edc2c43c2861d8", wynn)?.name).toBe("Wynn");
    expect(store.personaForOccupant(named)).toBeUndefined();
    const saved = JSON.parse(readFileSync(join(root, "personas.json"), "utf8")) as {
      bindings: { subject: string; occupantId: string }[];
      personas: { personaId: string; name: string }[];
    };
    // One binding for the hire, which the markers now record as Clankie's.
    expect(saved.bindings.filter((binding) => binding.occupantId === sable)).toEqual([
      expect.objectContaining({ subject: "pc-sable-9e78" }),
    ]);
    expect(markers(root)).toEqual({
      schemaVersion: 1,
      hired: ["pc-sable-9e78", "wynn-e3f1"],
      ownerNamed: [ids.juniper],
    });
    expect(saved.bindings.filter((binding) => binding.occupantId === named)).toHaveLength(2);
    // The pane personas stay as offline records; nothing is deleted or renamed but the handles.
    expect(saved.personas.find((entry) => entry.personaId === ids.quill)?.name).toBe("Quill");
    expect(saved.personas.find((entry) => entry.personaId === ids.tess)?.name).toBe("tess-07c2");
    // Herdr reports the owner-renamed hire's handle again, as a Codex hire's stays: the hire's
    // binding is observed directly, and the pane persona the owner named keeps its binding.
    store.reconcile(
      [
        {
          ...unnamed("term_named", "w1:p3", "tess-07c2", named),
          renamed: { name: "tess-07c2", from: "adhoc-0000000000000000000c" },
        },
      ],
      hireTitle,
    );
    expect(
      (JSON.parse(readFileSync(join(root, "personas.json"), "utf8")) as typeof saved).bindings.filter(
        (binding) => binding.occupantId === named,
      ),
    ).toEqual([
      expect.objectContaining({ subject: "tess-07c2" }),
      expect.objectContaining({ subject: "adhoc-0000000000000000000c", personaId: ids.juniper }),
    ]);
    expect(markers(root).hired).toEqual(["pc-sable-9e78", "wynn-e3f1", "tess-07c2"]);
    // The next census keeps all of it, from the recorded markers alone.
    expect(new PersonaStore(root).reconcile(live).map((seat) => seat.title)).toEqual([
      "Sable",
      "Wynn",
      "Juniper",
      "Build grove",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** The persona store's markers: who minted each hire's subject, and which names the owner gave. */
function markers(root: string): { schemaVersion: number; hired: string[]; ownerNamed: string[] } {
  return JSON.parse(readFileSync(join(root, "personas.markers.json"), "utf8"));
}

/** A Claude pane as the census first sees it: unnamed, under its pane's key. */
function claudePane(paneId: string, occupantId: string, title = "Claude Code"): ObservedFleetSeat {
  return {
    seatId: `term_${paneId.replaceAll(/\W/gu, "_")}`,
    paneId,
    subject: `adhoc-${createHash("sha256").update(paneId).digest("hex").slice(0, 20)}`,
    occupantId,
    harness: "claude",
    status: "working",
    title,
  };
}

/** The same pane once Herdr names its agent; a remote fleet prefixes the key, as subjectForHerdrName does. */
function herdrNamed(seat: ObservedFleetSeat, name: string): ObservedFleetSeat {
  const fleet = /^([^/]+)\//u.exec(seat.paneId)?.[1];
  return {
    ...seat,
    subject: (fleet === undefined ? name : `${fleet}-${name}`).slice(0, 32),
    renamed: { name, from: seat.subject },
  };
}

it("keeps an owner's Herdr name even when it reads like a hire handle (LOCAL-VUH-59 review)", () => {
  const root = mkdtempSync(join(tmpdir(), "clankie-owner-handle-personas-"));
  try {
    const issue = `session-${"1".repeat(64)}`;
    const later = `session-${"2".repeat(64)}`;
    const hire = `session-${"3".repeat(64)}`;
    const wynn = `session-${"4".repeat(64)}`;
    const wren = `session-${"5".repeat(64)}`;
    // Clankie's hire ledger knows only its hires: the owner started the first two panes.
    const ledger = new Map([
      [hire, "Lark"],
      [wynn, "Wynn"],
      [wren, "Wren"],
    ]);
    const hireTitle = (seat: ObservedFleetSeat) => ledger.get(seat.occupantId);
    const store = new PersonaStore(root);
    // The owner names a pane after the issue it works on, as the fleet usually does.
    const issuePane = herdrNamed(claudePane("w1:p1", issue), "vuh-2933");
    const laterPane = claudePane("w1:p2", later);
    const hirePane = herdrNamed(claudePane("w1:p3", hire), "lark-1a2b");
    expect(store.reconcile([issuePane, laterPane, hirePane], hireTitle).map((seat) => seat.title)).toEqual([
      "vuh-2933",
      "Claude Code",
      "Lark",
    ]);
    // An unnamed pane the owner then names in Herdr, with a year that is also four hex digits.
    const renamedPane = herdrNamed(laterPane, "fix-2026");
    const seats = store.reconcile([issuePane, renamedPane, hirePane], hireTitle);
    expect(seats.map((seat) => seat.title)).toEqual(["vuh-2933", "fix-2026", "Lark"]);
    // Both are recorded as the owner's, so a restart's census reads them the same way.
    expect(markers(root).ownerNamed).toEqual([seats[0]!.personaId, seats[1]!.personaId]);
    expect(
      new PersonaStore(root)
        .reconcile([issuePane, renamedPane, hirePane], hireTitle)
        .map((seat) => seat.title),
    ).toEqual(["vuh-2933", "fix-2026", "Lark"]);
    // The owner names hired panes after their hires: a stem with a tail that is not a tag, and the
    // bare stem. Neither is a handle Clankie minted, so both are the owner's.
    expect(
      store
        .reconcile(
          [herdrNamed(claudePane("w1:p4", wynn), "wynn-test"), herdrNamed(claudePane("w1:p5", wren), "wren")],
          hireTitle,
        )
        .map((seat) => seat.title),
    ).toEqual(["wynn-test", "wren"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("names a hire by the title Clankie hired it under, whichever census files it first (LOCAL-VUH-59)", () => {
  const root = mkdtempSync(join(tmpdir(), "clankie-hire-title-personas-"));
  try {
    const brief = "Clankie captain brief assignment";
    const lark = `session-${"5".repeat(64)}`;
    const wren = `session-${"6".repeat(64)}`;
    const long = `session-${"7".repeat(64)}`;
    const ledger = new Map([
      [lark, "Lark Two"],
      [wren, "Wren"],
      [long, "Persona follow-up for the tracker"],
    ]);
    const hireTitle = (seat: ObservedFleetSeat) => ledger.get(seat.occupantId);
    const store = new PersonaStore(root);

    // The census sees the handle Herdr was started with before the hire adopts the pane. The
    // handle is Clankie's, not an owner's name, so the hire's name stands in until adoption.
    const larkPane = claudePane("w2:p1", lark, brief);
    expect(store.reconcile([herdrNamed(larkPane, "lark-two-1a2b")], hireTitle)[0]!.title).toBe("Lark two");
    expect(
      store.adoptSpawn({ ...larkPane, subject: "lark-two-1a2b", title: "Lark Two" }, "Lark Two").title,
    ).toBe("Lark Two");
    expect(store.reconcile([larkPane], hireTitle)[0]!.title).toBe("Lark Two");

    // Filed under its pane and the brief's title first, then under its handle: the brief's title
    // was never a name.
    const wrenPane = claudePane("w2:p2", wren, brief);
    expect(store.reconcile([wrenPane], hireTitle)[0]!.title).toBe(brief);
    const wrenNamed = herdrNamed(wrenPane, "wren-3c4d");
    const wrenSeat = store.reconcile([wrenNamed], hireTitle)[0]!;
    expect(wrenSeat.title).toBe("Wren");
    // A name the owner gives in the app stays, even one spelled like the handle.
    store.update({ schemaVersion: 1, personaId: wrenSeat.personaId, name: "wren-3c4d" });
    expect(new PersonaStore(root).reconcile([wrenNamed], hireTitle)[0]!.title).toBe("wren-3c4d");

    // A linked PC's hire with a long title: its fleet-prefixed key is cut at 32 characters,
    // through its tag, and is still the hire's.
    const longPane = claudePane("pc/w3:p1", long, brief);
    const longNamed = herdrNamed(longPane, "persona-follow-up-for-the-t-1a2b");
    expect(longNamed.subject).toBe("pc-persona-follow-up-for-the-t-1");
    store.reconcile([longNamed], hireTitle);
    store.adoptSpawn({ ...longPane, subject: longNamed.subject }, "Persona follow-up for the tracker");
    const longSeat = store.reconcile([longPane], hireTitle)[0]!;
    expect(longSeat.title).toBe("Persona follow-up for the tracker");
    expect(store.personaForOccupant(long)).toBe(longSeat.personaId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps the persona file readable by the previous runtime, with its markers beside it (LOCAL-VUH-59 review)", () => {
  const root = mkdtempSync(join(tmpdir(), "clankie-persona-rollback-"));
  try {
    // The schemaVersion 2 file as the previous runtime (17ff7d461) reads it, strictly.
    const previousRuntimeFile = z
      .object({
        schemaVersion: z.literal(2),
        personas: z.array(OperatorAgentPersonaSchema),
        bindings: z.array(
          z
            .object({
              account: OperatorCodexAccountSchema.optional(),
              subject: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u),
              personaId: OperatorAgentPersonaIdSchema,
              occupantId: z.string().regex(/^session-[a-f0-9]{64}$/u),
            })
            .strict(),
        ),
      })
      .strict();
    const hire = `session-${"8".repeat(64)}`;
    const owned = `session-${"9".repeat(64)}`;
    const hireTitle = (seat: ObservedFleetSeat) => (seat.occupantId === hire ? "Wynn" : undefined);
    const wynn = herdrNamed(claudePane("w1:p1", hire), "wynn-e3f1");
    const store = new PersonaStore(root);
    const [hired, ownerPane] = store.reconcile([wynn, claudePane("w1:p2", owned)], hireTitle);
    store.update({ schemaVersion: 1, personaId: ownerPane!.personaId, name: "Juniper" });
    // Both markers are written, and neither reaches the file the previous runtime reads.
    expect(markers(root)).toEqual({
      schemaVersion: 1,
      hired: ["wynn-e3f1"],
      ownerNamed: [ownerPane!.personaId],
    });
    expect(
      previousRuntimeFile.safeParse(JSON.parse(readFileSync(join(root, "personas.json"), "utf8"))).success,
    ).toBe(true);
    // This runtime reads the markers back.
    const unnamed = claudePane("w1:p1", hire);
    expect(new PersonaStore(root).reconcile([unnamed]).map((seat) => seat.personaId)).toEqual([
      hired!.personaId,
    ]);
    // A marker for a persona the file no longer holds, as a rolled-back runtime can leave, is dropped.
    const stale = "agent-00000000-0000-4000-8000-00000000dead";
    writeFileSync(
      join(root, "personas.markers.json"),
      JSON.stringify({ ...markers(root), ownerNamed: [ownerPane!.personaId, stale] }),
    );
    new PersonaStore(root).update({ schemaVersion: 1, personaId: ownerPane!.personaId, name: "Juniper" });
    expect(markers(root).ownerNamed).toEqual([ownerPane!.personaId]);
    // With no markers beside it the file reads as unmarked, and the hire ledger marks the hire again.
    rmSync(join(root, "personas.markers.json"));
    const unmarked = new PersonaStore(root);
    expect(
      unmarked.reconcile([wynn, claudePane("w1:p2", owned)], hireTitle).map((seat) => seat.title),
    ).toEqual(["Wynn", "Juniper"]);
    expect(markers(root)).toEqual({ schemaVersion: 1, hired: ["wynn-e3f1"], ownerNamed: [] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
