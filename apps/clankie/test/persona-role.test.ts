import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import * as census from "../src/captain/herdr-census.ts";

it("a hire names the persona's role, and set_persona_role reassigns or clears it (ADR 0208)", async () => {
  const root = mkdtempSync(join(tmpdir(), "captain-persona-role-"));
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  vi.spyOn(HerdrWatchStore.prototype, "trackSeat").mockImplementation(() => {});
  vi.spyOn(census, "readFleet").mockResolvedValue({ seats: [] });
  vi.spyOn(HerdrWatchStore.prototype, "spawnSeat").mockResolvedValue({
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
  });
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
      seat: { schemaVersion: 1, harness: "claude", title: "Smith", workingDirectory: root, role: "designer" },
    });
    if (hired.op !== "spawn_seat" || hired.result.outcome !== "spawned") throw new Error("hire failed");
    const personaId = hired.result.seat.personaId;
    const personas = await captain.serveOperatorConversation({ schemaVersion: 1, op: "personas" });
    expect(personas).toMatchObject({ personas: [{ personaId, role: "designer" }] });
    expect(
      await captain.serveOperatorConversation({
        schemaVersion: 1,
        op: "set_persona_role",
        personaId,
        role: "reviewer",
      }),
    ).toMatchObject({ op: "set_persona_role", persona: { personaId, role: "reviewer" } });
    const cleared = await captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "set_persona_role",
      personaId,
      role: null,
    });
    expect(cleared.op === "set_persona_role" ? cleared.persona : undefined).not.toHaveProperty("role");
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
