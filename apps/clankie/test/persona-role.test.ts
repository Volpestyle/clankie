import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import * as census from "../src/captain/herdr-census.ts";

it("a hire names the persona's role and a later write refuses without confirmed current membership", async () => {
  const root = mkdtempSync(join(tmpdir(), "captain-persona-role-"));
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  vi.spyOn(HerdrWatchStore.prototype, "trackSeat").mockImplementation(() => {});
  vi.spyOn(census, "readFleet").mockResolvedValue({ seats: [] });
  vi.spyOn(HerdrWatchStore.prototype, "spawnSeat").mockImplementation(
    async (_seat, _subject, _brief, _resume, _authority, adopt, flushAdoption) => {
      const result = {
        outcome: "spawned",
        seat: {
          seatId: "term_1",
          paneId: "w1:p1",
          subject: "smith",
          occupantId: `session-${"c".repeat(64)}`,
          harness: "claude",
          status: "idle",
          title: "Smith",
          workingDirectory: root,
        },
      } as const;
      adopt?.(result);
      await flushAdoption?.().catch(() => {});
      return result;
    },
  );
  const captain = createCaptain(
    { ...({} as CaptainDeps) },
    {
      repoRoot: root,
      stateDir: root,
      settings: new SettingsStore(join(root, "settings.json")),
    },
  );
  try {
    const hired = await captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "spawn_seat",
      conversationId: "global-default",
      seat: { schemaVersion: 1, harness: "claude", title: "Smith", workingDirectory: root, role: "designer" },
    });
    if (hired.op !== "spawn_seat" || hired.result.outcome !== "spawned") throw new Error("hire failed");
    const personaId = hired.result.seat.personaId;
    const personas = await captain.serveOperatorConversation({ schemaVersion: 1, op: "personas" });
    expect(personas).toMatchObject({ personas: [{ personaId, role: "designer" }] });
    await expect(
      captain.serveOperatorConversation({
        schemaVersion: 1,
        op: "set_persona_role",
        personaId,
        role: "  Sound   Designer ",
      }),
    ).rejects.toThrow("not a confirmed current member");
    expect(await captain.serveOperatorConversation({ schemaVersion: 1, op: "roles" })).toMatchObject({
      op: "roles",
      roles: expect.arrayContaining([{ role: "designer", builtIn: true, count: 1 }]),
    });
    await expect(
      captain.serveOperatorConversation({
        schemaVersion: 1,
        op: "set_persona_role",
        personaId,
        role: null,
      }),
    ).rejects.toThrow("not a confirmed current member");
    await expect(
      captain.serveOperatorConversation({
        schemaVersion: 1,
        op: "set_persona_role",
        personaId: "agent-nobody",
        role: "tester",
      }),
    ).rejects.toThrow("Unknown agent");
  } finally {
    await captain.close();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(["save_failed", "commit_unknown", "journal_failed"] as const)(
  "keeps exactly one confirmed hire when its role is %s",
  async (failure) => {
    const root = mkdtempSync(join(tmpdir(), "captain-role-failure-"));
    const settings = new SettingsStore(join(root, "settings.json"));
    const update = settings.update.bind(settings);
    if (failure !== "journal_failed")
      vi.spyOn(settings, "update").mockImplementation(async (...args) => {
        if (failure === "commit_unknown") await update(...args);
        throw new Error("role write unavailable");
      });
    vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
    vi.spyOn(HerdrWatchStore.prototype, "trackSeat").mockImplementation(() => {});
    vi.spyOn(census, "readFleet").mockResolvedValue({ seats: [] });
    const spawn = vi
      .spyOn(HerdrWatchStore.prototype, "spawnSeat")
      .mockImplementation(async (_seat, _subject, _brief, _resume, _authority, adopt, flushAdoption) => {
        if (failure === "journal_failed" && _seat.role !== undefined) {
          const { mkdirSync } = await import("node:fs");
          const { createHash } = await import("node:crypto");
          mkdirSync(
            join(
              root,
              `persona-project-roles-${createHash("sha256").update(join(root, "personas.json")).digest("hex")}.pending.json`,
            ),
          );
        }
        const result = {
          outcome: "spawned",
          seat: {
            seatId: "term_1",
            paneId: "w1:p1",
            subject: "smith",
            occupantId: `session-${"c".repeat(64)}`,
            harness: "claude",
            status: "idle",
            title: "Smith",
            workingDirectory: root,
          },
        } as const;
        adopt?.(result);
        await flushAdoption?.().catch(() => {});
        return result;
      });
    const captain = createCaptain({ ...({} as CaptainDeps) }, { repoRoot: root, stateDir: root, settings });
    try {
      const result = await captain.serveOperatorConversation({
        schemaVersion: 1,
        op: "spawn_seat",
        conversationId: "global-default",
        seat: {
          schemaVersion: 1,
          harness: "claude",
          title: "Smith",
          workingDirectory: root,
          role: "designer",
        },
      });
      expect(result).toMatchObject({
        op: "spawn_seat",
        result: {
          outcome: "spawned",
          seat: { seatId: "term_1" },
          roleAssignment: { outcome: failure === "journal_failed" ? "unsaved" : "pending" },
        },
      });
      expect(spawn).toHaveBeenCalledTimes(1);
      if (failure === "journal_failed") {
        const observed = {
          seatId: "term_1",
          paneId: "w1:p1",
          subject: "smith",
          occupantId: `session-${"c".repeat(64)}`,
          harness: "claude",
          status: "idle",
          title: "Smith",
          workingDirectory: root,
        } as const;
        vi.mocked(census.readFleet).mockResolvedValue({ seats: [observed] });
        await captain.serveOperatorConversation({ schemaVersion: 1, op: "personas" });
        const move = vi.spyOn(HerdrWatchStore.prototype, "moveSeat").mockResolvedValue({
          outcome: "spawned",
          seat: { ...observed, seatId: "term_2", workingDirectory: join(root, "moved") },
        });
        const moved = await captain.serveOperatorConversation({
          schemaVersion: 1,
          op: "move_seat",
          move: { schemaVersion: 1, seatId: "term_1", workingDirectory: join(root, "moved") },
        });
        expect(moved).toMatchObject({
          op: "move_seat",
          result: { outcome: "moved", seat: { seatId: "term_2" } },
        });
        if (moved.op !== "move_seat") throw new Error("Expected a move result");
        expect(moved.result).not.toHaveProperty("roleAssignment");
        expect(move).toHaveBeenCalledTimes(1);
        expect(spawn).toHaveBeenCalledTimes(1);
        const roleless = await captain.serveOperatorConversation({
          schemaVersion: 1,
          op: "spawn_seat",
          conversationId: "global-default",
          seat: { schemaVersion: 1, harness: "claude", title: "Smith", workingDirectory: root },
        });
        if (roleless.op !== "spawn_seat" || roleless.result.outcome !== "spawned")
          throw new Error("Expected the role-less hire");
        expect(roleless.result).not.toHaveProperty("roleAssignment");
        expect(spawn).toHaveBeenCalledTimes(2);
      }
      const { OperatorConversationServiceResultSchema } = await import("@clankie/protocol");
      expect(OperatorConversationServiceResultSchema.parse(result)).toEqual(result);
      const { readFileSync } = await import("node:fs");
      expect(JSON.parse(readFileSync(join(root, "personas.json"), "utf8")).personas[0]).not.toHaveProperty(
        "role",
      );
    } finally {
      await captain.close();
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it.each(["pending", "unsaved", "saved"] as const)(
  "attributes overlapping same-persona role writes to each hire (first %s)",
  async (firstOutcome) => {
    const firstUnsaved = firstOutcome === "unsaved";
    const root = mkdtempSync(join(tmpdir(), "captain-role-overlap-"));
    const settings = new SettingsStore(join(root, "settings.json"));
    const update = settings.update.bind(settings);
    vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
    vi.spyOn(HerdrWatchStore.prototype, "trackSeat").mockImplementation(() => {});
    vi.spyOn(census, "readFleet").mockResolvedValue({ seats: [] });
    const { createHash } = await import("node:crypto");
    const { mkdirSync, readFileSync } = await import("node:fs");
    const journal = join(
      root,
      `persona-project-roles-${createHash("sha256").update(join(root, "personas.json")).digest("hex")}.pending.json`,
    );
    let admit!: () => void;
    const admitted = new Promise<void>((resolve) => {
      admit = resolve;
    });
    let adopted!: () => void;
    const bothAdopted = new Promise<void>((resolve) => {
      adopted = resolve;
    });
    let firstAdopted!: () => void;
    const firstAdoption = new Promise<void>((resolve) => {
      firstAdopted = resolve;
    });
    let flushing!: () => void;
    const firstFlush = new Promise<void>((resolve) => {
      flushing = resolve;
    });
    let writes = 0;
    vi.spyOn(settings, "update").mockImplementation(async (...args) => {
      if (++writes === 1 && firstOutcome === "saved") {
        flushing();
        await bothAdopted;
        return update(...args);
      }
      throw new Error("settings unavailable");
    });
    let calls = 0;
    let adoptions = 0;
    const spawn = vi
      .spyOn(HerdrWatchStore.prototype, "spawnSeat")
      .mockImplementation(async (_seat, _subject, _brief, _resume, _authority, adopt, flushAdoption) => {
        calls += 1;
        const number = _seat.role === "designer" ? 1 : 2;
        await admitted;
        if (number === 2) await firstAdoption;
        if (number === 2 && firstOutcome === "saved") await firstFlush;
        if (number === 1 && firstUnsaved) mkdirSync(journal);
        const result = {
          outcome: "spawned",
          seat: {
            seatId: "term_1",
            paneId: "w1:p1",
            subject: "smith",
            occupantId: `session-${"c".repeat(64)}`,
            harness: "claude",
            status: "idle",
            title: "Smith",
            workingDirectory: root,
          },
        } as const;
        adopt?.(result);
        if (number === 1 && firstUnsaved) rmSync(journal, { recursive: true });
        if (number === 1) firstAdopted();
        if (++adoptions === 2) adopted();
        if (firstOutcome !== "saved") await bothAdopted;
        await flushAdoption?.().catch(() => {});
        return result;
      });
    const captain = createCaptain({ ...({} as CaptainDeps) }, { repoRoot: root, stateDir: root, settings });
    const hire = (role: "designer" | "reviewer") =>
      captain.serveOperatorConversation({
        schemaVersion: 1,
        op: "spawn_seat",
        conversationId: "global-default",
        seat: { schemaVersion: 1, harness: "claude", title: "Smith", workingDirectory: root, role },
      });
    try {
      const first = hire("designer");
      const second = hire("reviewer");
      await vi.waitFor(() => expect(calls).toBe(2));
      admit();
      const [a, b] = await Promise.all([first, second]);
      if (
        a.op !== "spawn_seat" ||
        a.result.outcome !== "spawned" ||
        b.op !== "spawn_seat" ||
        b.result.outcome !== "spawned"
      )
        throw new Error("expected actual started seats");
      expect(a.result.seat.personaId).toBe(b.result.seat.personaId);
      const pending = JSON.parse(readFileSync(journal, "utf8")) as { id: string; role: string }[];
      expect(a.result.roleAssignment).toEqual(
        firstOutcome === "saved"
          ? undefined
          : firstUnsaved
            ? { outcome: "unsaved" }
            : { outcome: "pending", operationId: pending.find((p) => p.role === "designer")?.id },
      );
      expect(b.result.roleAssignment).toEqual({
        outcome: "pending",
        operationId: pending.find((p) => p.role === "reviewer")?.id,
      });
      expect(spawn).toHaveBeenCalledTimes(2);
    } finally {
      admit();
      adopted();
      flushing();
      firstAdopted();
      await captain.close();
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
