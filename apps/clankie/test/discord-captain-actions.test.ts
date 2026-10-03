import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordTurnReceipts } from "../src/captain/discord-turn-receipts.ts";
import { describe, expect, it } from "vitest";
import { createDiscordCaptainActionClient } from "../src/discord-captain-actions.ts";

describe("createDiscordCaptainActionClient", () => {
  it("posts only host-grounded action context to the active body", async () => {
    const calls: unknown[] = [];
    const client = createDiscordCaptainActionClient(
      { DISCORD_ACTIVE_BODY: "bot", CLANKIE_DISCORD_BRIDGE_CONTROL_PORT: "4313" },
      async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true, message: "Reacted." }));
      },
    );
    await expect(
      client.execute({
        action: "react",
        callId: "call-1",
        actorId: "user-1",
        guildId: "guild-1",
        channelId: "channel-1",
        messageId: "message-1",
        emoji: "👍",
      }),
    ).resolves.toEqual({ ok: true, message: "Reacted." });
    expect(calls).toEqual([
      expect.objectContaining({ actorId: "user-1", channelId: "channel-1", messageId: "message-1" }),
    ]);
  });
});

it("persists the required final guard before dispatch and fails closed after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "clankie-discord-guard-"));
  try {
    const path = join(root, "receipts.json");
    const receipts = new DiscordTurnReceipts(path);
    let authorized = true;
    let effects = 0;
    const key = "captain:guarded:react";
    const client = createDiscordCaptainActionClient(
      { DISCORD_ACTIVE_BODY: "bot", CLANKIE_DISCORD_BRIDGE_CONTROL_PORT: "4313" },
      async () => {
        expect(receipts.get(`guard:${key}`)?.requiredGuard).toBe(true);
        authorized = false; // Revocation during transport/credential work.
        await receipts.enforceGuard(key);
        effects += 1;
        return new Response(JSON.stringify({ ok: true, message: "Reacted." }));
      },
      receipts,
    );
    const result = await client.execute(
      {
        action: "react",
        callId: "guarded",
        actorId: "actor",
        guildId: "guild",
        channelId: "room",
        messageId: "message",
        emoji: "👍",
      },
      async () => {
        if (!authorized) throw new Error("revoked");
      },
    );
    expect(result.ok).toBe(false);
    expect(effects).toBe(0);
    const restored = new DiscordTurnReceipts(path);
    await expect(restored.enforceGuard(key)).rejects.toThrow();
    await expect(restored.enforceGuard("ordinary-social-reply")).resolves.toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
