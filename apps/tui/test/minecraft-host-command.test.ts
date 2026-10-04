import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  FileCredentialStore,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
  mintOperatorToken,
} from "@clankie/credential-broker";
import { runMinecraftHostCommand } from "../src/command/minecraft-host.ts";

it("rejects raw console, selectors, injected subjects and disabled idle limits before I/O", async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const args of [
    ["admin", '{"operation":"op","username":"Friend"}'],
    ["admin", '{"operation":"kick","username":"@a"}'],
    ["admin", '{"operation":"say","text":"hi\\nstop"}'],
    ["admin", '{"operation":"list","discordUserId":"123"}'],
    ["configure", '{"idleTimeoutMs":900001}'],
    ["start", "world.example"],
  ])
    await expect(runMinecraftHostCommand(args, { env: {}, fetchImpl })).rejects.toThrow("Usage");
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("keeps claim approval on the official site and completes it using the operator credential", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minecraft-host-cli-"));
  try {
    const store = new FileCredentialStore(join(dir, "auth.json"));
    const key = mintOperatorToken();
    await store.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key });
    const onClaimUrl = vi.fn();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ claimUrl: "https://playit.gg/claim/test" }))
      .mockResolvedValueOnce(Response.json({ outcome: "completed" }));
    const options = {
      env: {},
      operatorCredentialStore: store,
      fetchImpl,
      onClaimUrl,
      conversationId: "operator-host",
    };
    await expect(runMinecraftHostCommand(["tunnel", "claim"], options)).resolves.toEqual({
      outcome: "completed",
    });
    expect(onClaimUrl).toHaveBeenCalledWith("https://playit.gg/claim/test");
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({ action: "claim_complete" });
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toMatchObject({
      authorization: `Bearer ${key}`,
      "x-clankie-conversation-id": "operator-host",
    });
    fetchImpl.mockResolvedValueOnce(
      Response.json({ claimUrl: "https://playit.gg.attacker.example/claim/test" }),
    );
    onClaimUrl.mockClear();
    await expect(runMinecraftHostCommand(["tunnel", "claim"], options)).rejects.toThrow(
      "Invalid playit claim",
    );
    expect(onClaimUrl).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
