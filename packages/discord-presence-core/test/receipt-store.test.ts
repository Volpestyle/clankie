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

  it("appends a suppressed narration receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-discord-receipts-suppress-"));
    roots.push(root);
    const path = join(root, "receipts.jsonl");
    const store = new DiscordBridgeReceiptStore({
      path,
      clock: () => new Date("2026-08-15T21:00:00.000Z"),
      idFactory: () => "receipt-suppress",
    });
    await store.append("discord.voice.possessor_narration_suppressed", {
      type: "possessor_narration_suppressed",
      guildId: "guild-1",
      channelId: "channel-1",
      stayId: "stay-1",
      deliveryId: "play-turn-2",
      reason: "rate_limited",
    });
    const receipt = parseDiscordBridgeReceipt(JSON.parse((await readFile(path, "utf8")).trim()));
    expect(receipt.type).toBe("discord.voice.possessor_narration_suppressed");
    expect(receipt.data.deliveryId).toBe("play-turn-2");
    expect(receipt.data.reason).toBe("rate_limited");
  });

  it("appends the ADR 0057 floor and volition receipt types", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-discord-receipts-0057-"));
    roots.push(root);
    const path = join(root, "receipts.jsonl");
    let nextId = 0;
    const store = new DiscordBridgeReceiptStore({
      path,
      clock: () => new Date("2026-07-25T16:15:00.000Z"),
      idFactory: () => `receipt-${(nextId += 1)}`,
    });

    await store.append("discord.voice.floor", {
      guildId: "guild-1",
      channelId: "channel-1",
      state: "engaged",
      reason: "addressed",
    });
    await store.append("discord.voice.volition", {
      guildId: "guild-1",
      channelId: "channel-1",
      offered: 4,
      taken: 1,
      suppressed: 3,
    });

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    const receipts = lines.map((line) => parseDiscordBridgeReceipt(JSON.parse(line)));
    expect(receipts.map((receipt) => receipt.type)).toEqual([
      "discord.voice.floor",
      "discord.voice.volition",
    ]);
    expect(receipts[1]?.data).toEqual({
      guildId: "guild-1",
      channelId: "channel-1",
      offered: 4,
      taken: 1,
      suppressed: 3,
    });
  });

  it("extends the forbidden-key fence over the ADR 0057 receipt types", () => {
    for (const type of ["discord.voice.floor", "discord.voice.volition"] as const) {
      for (const key of ["transcript", "response", "prompt", "audio", "pcm"]) {
        expect(() =>
          parseDiscordBridgeReceipt({
            schemaVersion: 1,
            id: "receipt-fence",
            occurredAt: "2026-07-25T16:15:00.000Z",
            type,
            data: { [key]: "smuggled" },
          }),
        ).toThrow(`cannot contain ${key}`);
      }
    }
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

  it("makes jpeg and image fields unrepresentable in stream receipts", () => {
    const base = {
      schemaVersion: 1,
      id: "receipt-stream",
      occurredAt: "2026-08-15T16:15:00.000Z",
      type: "discord.stream.frame",
    } as const;
    expect(() => parseDiscordBridgeReceipt({ ...base, data: { jpeg: "...." } })).toThrow(
      "cannot contain jpeg",
    );
    expect(
      parseDiscordBridgeReceipt({ ...base, data: { width: 1280, height: 720, userId: "u1" } }).data,
    ).toMatchObject({ width: 1280, height: 720 });
  });
});
