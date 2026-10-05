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
    ["configure", '{"backend":{"kind":"aws-ec2","profile":"clankie"}}'],
    ["configure", '{"backend":{"kind":"local","secretAccessKey":"secret"}}'],
    ["start", "world.example"],
  ])
    await expect(runMinecraftHostCommand(args, { env: {}, fetchImpl })).rejects.toThrow("Usage");
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("sends AWS backend selection through the authenticated host configuration API", async () => {
  const dir = await mkdtemp(join(tmpdir(), "minecraft-host-cli-"));
  try {
    const store = new FileCredentialStore(join(dir, "auth.json"));
    const key = mintOperatorToken();
    await store.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key });
    const backend = {
      kind: "aws-ec2",
      accountId: "123456789012",
      instanceId: "i-0123456789abcdef0",
      region: "us-east-1",
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ backend }));
    await runMinecraftHostCommand(["configure", JSON.stringify({ backend })], {
      env: {},
      operatorCredentialStore: store,
      fetchImpl,
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      action: "configure",
      settings: { backend },
    });
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: `Bearer ${key}` });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("returns the official claim URL immediately and polls only on an explicit completion command", async () => {
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
      claimUrl: "https://playit.gg/claim/test",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(runMinecraftHostCommand(["tunnel", "complete"], options)).resolves.toEqual({
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

it("crosses the real HTTP, command-schema and broker boundary without a TTY or automatic polling", async () => {
  const { createServer } = await import("node:http");
  const { MinecraftHostCommandSchema, MinecraftTunnelClaimStatusSchema } = await import("@clankie/protocol");
  const directory = await mkdtemp(join(tmpdir(), "minecraft-claim-http-"));
  const store = new FileCredentialStore(join(directory, "auth.json"));
  const key = mintOperatorToken();
  await store.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key });
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    if (request.url !== "/v1/minecraft/host" || request.headers.authorization !== `Bearer ${key}`) {
      response.writeHead(403).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const command = MinecraftHostCommandSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
    requests.push(command.action);
    response.setHeader("content-type", "application/json");
    const claimUrl = "https://playit.gg/claim/abcdef1234";
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    response.end(
      JSON.stringify(
        command.action === "claim"
          ? MinecraftTunnelClaimStatusSchema.parse({ phase: "preparing", claimed: false })
          : MinecraftTunnelClaimStatusSchema.parse({
              phase: command.action === "claim_complete" ? "claimed" : "pending",
              claimed: command.action === "claim_complete",
              ...(command.action === "claim_status" ? { claimUrl, expiresAt } : {}),
            }),
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP listener unavailable");
    const options = {
      env: {},
      operatorCredentialStore: store,
      host: `http://127.0.0.1:${address.port}`,
      onClaimUrl: () => {},
    };
    expect(await runMinecraftHostCommand(["tunnel", "claim"], options)).toEqual({
      phase: "preparing",
      claimed: false,
    });
    expect(requests).toEqual(["claim"]);
    expect(await runMinecraftHostCommand(["tunnel", "status"], options)).toMatchObject({
      phase: "pending",
      claimed: false,
    });
    expect(await runMinecraftHostCommand(["tunnel", "complete"], options)).toEqual({
      phase: "claimed",
      claimed: true,
    });
    expect(requests).toEqual(["claim", "claim_status", "claim_complete"]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
