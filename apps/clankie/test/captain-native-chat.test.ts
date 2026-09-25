import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import * as census from "../src/captain/herdr-census.ts";

it("discovers agents without chats, reads native history on demand, and persists only explicit sends", async () => {
  const root = mkdtempSync(join(tmpdir(), "clankie-native-chat-"));
  const native = {
    agent: {
      paneId: "w1:p2",
      terminalId: "external",
      agent: "codex",
      status: "idle",
      title: "Codex",
      session: { source: "herdr:codex", kind: "id" as const, value: "native-session" },
    },
    transcript: {
      sessionKey: "native-session",
      entries: [
        { type: "message" as const, id: "u1", role: "operator" as const, text: "Private Codex prompt" },
        { type: "message" as const, id: "a1", role: "agent" as const, text: "Native answer" },
      ],
    },
  };
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  vi.spyOn(HerdrWatchStore.prototype, "trackSeat").mockImplementation(() => {});
  const read = vi.spyOn(HerdrWatchStore.prototype, "readNativeChat").mockResolvedValue(native);
  const send = vi.spyOn(HerdrWatchStore.prototype, "sendToSeat").mockResolvedValue(true);
  vi.spyOn(census, "readFleet").mockResolvedValue({
    seats: [
      {
        seatId: "external",
        paneId: "w1:p2",
        occupantId: "native-session",
        subject: "external",
        harness: "codex",
        status: "idle",
        title: "Codex",
        workingDirectory: root,
      },
    ],
  });
  const captain = createCaptain({} as CaptainDeps, {
    repoRoot: root,
    stateDir: root,
    settings: new SettingsStore(join(root, "settings.json")),
  });
  try {
    const roster = await captain.serveOperatorConversation({ schemaVersion: 1, op: "roster" });
    if (roster.op !== "roster") throw new Error("roster expected");
    expect(roster.seats[0]?.conversationId).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    const created = await captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "create",
      scope: { kind: "persona", personaId: roster.seats[0]!.personaId },
      title: "Codex",
    });
    if (created.op !== "create") throw new Error("create expected");
    const conversationId = created.conversation.conversationId;
    const path = join(root, "conversations", conversationId, "events.jsonl");
    const before = existsSync(path) ? readFileSync(path, "utf8") : "";
    const replay = await captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "replay",
      replay: { schemaVersion: 1, conversationId, surfaceClientId: "app" },
    });
    expect(replay).toMatchObject({
      op: "replay",
      result: {
        status: "page",
        events: [
          { type: "message", text: "Private Codex prompt" },
          { type: "message", text: "Native answer" },
          { type: "activity" },
        ],
      },
    });
    expect(existsSync(path) ? readFileSync(path, "utf8") : "").toBe(before);
    if (replay.op !== "replay" || replay.result.status !== "page") throw new Error("page expected");
    const reaction = await captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "react",
      conversationId,
      entryRef: replay.result.events[0]!.cursor,
      emoji: "👍",
      remove: false,
    });
    expect(reaction).toMatchObject({ op: "react", reacted: true });
    const invalid = await captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "react",
      conversationId,
      entryRef: "native:invalid",
      emoji: "👍",
      remove: false,
    });
    expect(invalid).toMatchObject({ op: "react", reacted: false });
    await captain.serveOperatorConversation({
      schemaVersion: 1,
      op: "send",
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId,
        surfaceClientId: "app",
        expectedRevision: 0,
        message: "From the app",
      },
    });
    expect(send).toHaveBeenCalledWith("external", "From the app");
    const stored = readFileSync(path, "utf8");
    expect(stored).toContain("From the app");
    expect(stored).not.toContain("Private Codex prompt");
    expect(stored).not.toContain("Native answer");
  } finally {
    await captain.close();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});
