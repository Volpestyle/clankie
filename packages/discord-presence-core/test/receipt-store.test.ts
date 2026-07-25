import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DiscordBridgeReceiptStore, parseDiscordBridgeReceipt } from "../src/receipt-store.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DiscordBridgeReceiptStore", () => {
  it("appends content-free replayable receipts with private filesystem modes", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-discord-receipts-"));
    roots.push(root);
    const path = join(root, "state", "receipts.jsonl");
    const store = new DiscordBridgeReceiptStore({
      path,
      clock: () => new Date("2026-07-25T16:15:00.000Z"),
      idFactory: () => "receipt-1",
    });

    await store.append("discord.text.reply", {
      deliveryId: "message-1",
      responseMessageId: "reply-1",
      channelId: "channel-1",
    });

    const raw = await readFile(path, "utf8");
    const receipt = parseDiscordBridgeReceipt(JSON.parse(raw.trim()));
    expect(receipt).toMatchObject({
      id: "receipt-1",
      type: "discord.text.reply",
      data: { deliveryId: "message-1", responseMessageId: "reply-1" },
    });
    expect(raw).not.toContain("message body");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "state"))).mode & 0o777).toBe(0o700);
  });

  it("refuses a symlink target", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-discord-receipts-link-"));
    roots.push(root);
    const target = join(root, "target");
    const path = join(root, "receipts.jsonl");
    await symlink(target, path);
    const store = new DiscordBridgeReceiptStore({ path });

    await expect(store.append("discord.bridge.ready", { commandCount: 8 })).rejects.toThrow("not a symlink");
  });

  it("makes transcript and audio fields unrepresentable in voice receipts", () => {
    const base = {
      schemaVersion: 1,
      id: "receipt-voice",
      occurredAt: "2026-07-25T16:15:00.000Z",
      type: "discord.voice.utterance",
    } as const;
    expect(() => parseDiscordBridgeReceipt({ ...base, data: { transcript: "private words" } })).toThrow(
      "cannot contain transcript",
    );
    expect(() => parseDiscordBridgeReceipt({ ...base, data: { audio: "base64" } })).toThrow(
      "cannot contain audio",
    );
  });
});
