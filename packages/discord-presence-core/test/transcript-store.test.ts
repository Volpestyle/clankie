import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  discordVoiceTranscriptLogPath,
  DiscordVoiceTranscriptLogEntrySchema,
  DiscordVoiceTranscriptStore,
  type DiscordVoiceTranscript,
} from "../src/index.ts";

const roots: string[] = [];
afterAll(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

function transcript(text: string, deliveryId: string): DiscordVoiceTranscript {
  return {
    occurredAt: "2026-08-18T04:24:21.550Z",
    guildId: "866430493889134672",
    channelId: "866430493889134676",
    stayId: "stay-1",
    deliveryId,
    speakerId: "830574404453793842",
    displayName: "James",
    text,
  };
}

describe("DiscordVoiceTranscriptStore", () => {
  it("refuses a relative state root", () => {
    expect(() => discordVoiceTranscriptLogPath({ XDG_STATE_HOME: "relative" })).toThrow(/absolute/u);
  });

  it("keeps full attributed transcripts ordered in a private JSONL file", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-transcripts-"));
    roots.push(root);
    const path = join(root, "state", "discord-voice-transcripts.jsonl");
    const store = new DiscordVoiceTranscriptStore(path);

    await Promise.all([
      store.append("bot", transcript("first exact line", "delivery-1")),
      store.append("bot", transcript("second exact line", "delivery-2")),
    ]);

    const entries = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => DiscordVoiceTranscriptLogEntrySchema.parse(JSON.parse(line)));
    expect(entries.map(({ deliveryId, text }) => ({ deliveryId, text }))).toEqual([
      { deliveryId: "delivery-1", text: "first exact line" },
      { deliveryId: "delivery-2", text: "second exact line" },
    ]);
    expect(entries[0]).toMatchObject({ body: "bot", speakerId: "830574404453793842" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "state"))).mode & 0o777).toBe(0o700);

    const recent = await store.read(undefined, 1);
    expect(recent.entries.map((entry) => entry.text)).toEqual(["second exact line"]);
    expect(recent.nextCursor).toBe("000000000002");
    expect(recent.hasMore).toBe(false);

    await store.append("bot", transcript("third exact line", "delivery-3"));
    const tail = await store.read(recent.nextCursor, 1);
    expect(tail.entries.map((entry) => entry.text)).toEqual(["third exact line"]);
  });

  it("refuses a symlink target", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-transcripts-link-"));
    roots.push(root);
    const target = join(root, "target.jsonl");
    const path = join(root, "transcripts.jsonl");
    await writeFile(target, "", "utf8");
    await symlink(target, path);

    await expect(
      new DiscordVoiceTranscriptStore(path).append("bot", transcript("nope", "delivery-1")),
    ).rejects.toThrow(/regular file/u);
  });
});
