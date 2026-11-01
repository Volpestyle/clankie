import { operatorSeatBindingFixture } from "../../clankie/test/fixtures/operator-seat-binding-fixture.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { createClankieApp } from "../../clankie/src/app.ts";
import { createCaptain } from "../../clankie/src/captain/captain.ts";
import { createDiscordTurns } from "../../clankie/src/captain/captain-discord-turns.ts";
import type { CaptainDeps } from "../../clankie/src/captain/deps.ts";

// VUH-2142 live golden: a room turn refused before dispatch (then a file
// without replyTo, VUH-2581 lifted that) showed only "room turn: failed." in
// the retained lead bridge. Exercise the current CLI bridge, real HTTP lane
// bank, SDK and stdio wire with a fixture that has no Discord body.
it("puts a real room-turn refusal cause in the current bridge's error text", async () => {
  const root = await mkdtemp(join(tmpdir(), "room-cause-wire-"));
  const settings = new SettingsStore(join(root, "settings.json"));
  const captain = createCaptain(
    {
      roomTurns: createDiscordTurns,
      herdrAvailable: () => false,
      embodiment: {},
      memory: {
        recallEpisodeCard: async () => "",
        searchEpisodeCard: async () => "",
        recallDiscordPerson: () => "",
      },
      mcp: { catalog: async () => [] },
      browser: { catalog: async () => ({ available: false, tools: [] }) },
    } as unknown as CaptainDeps,
    {
      repoRoot: root,
      stateDir: join(root, "captain"),
      settings,
      discordEnvironment: {},
    },
  );
  const room = captain.bodyRoomConversation("discord_presence", "40000:50000");
  const seatBinding = operatorSeatBindingFixture();
  const service = await createClankieApp({
    operatorSeatBindings: seatBinding.registry,
    captain,
    settings,
    discordEnvironment: {},
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-operator"
        ? { operatorId: "fixture-owner" }
        : undefined,
  });
  await seatBinding.register(service.app, "global-default", { authorization: "Bearer fixture-operator" });
  const noncePath = join(root, "bridge-nonce");
  await writeFile(noncePath, Object.values(seatBinding.headers("global-default"))[0]!, { mode: 0o600 });
  const http = createServer(async (incoming, outgoing) => {
    let body = "";
    for await (const chunk of incoming) body += chunk;
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers))
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(",") : value);
    const request = new Request(`http://127.0.0.1${incoming.url}`, {
      method: incoming.method!,
      headers,
      ...(body ? { body } : {}),
    });
    // Controlled kernel observation of this sole owned bridge's actual socket;
    // native process acceptance belongs to its dedicated integration fixture.
    const env = { incoming, outgoing };
    const response = await service.app.fetch(request, seatBinding.httpEnv(request, env) ?? env);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(await response.text());
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not listen");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      resolve(import.meta.dirname, "../bin/clankie.ts"),
      "mcp",
      "--lane",
      "operator",
      "--conversation",
      "global-default",
    ],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      CLANKIE_BRIDGE_NONCE_FILE: noncePath,
      CLANKIE_OPERATOR_TOKEN: "fixture-operator",
      CLANKIE_CONTROL_PLANE_URL: `http://127.0.0.1:${address.port}`,
      CLANKIE_DISABLE_MODELS_FETCH: "1",
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const client = new Client({ name: "room-cause-proof", version: "1" });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "room_turn",
      arguments: {
        room,
        brief: "Validation probe: no post should occur.",
        requestId: "vuh-2142-current-bridge-cause",
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text?: string }[])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    expect(text).toContain("room_fork_discord_unavailable");
    if (process.env.VUH_2142_BRIDGE_PROOF_PATH)
      await writeFile(
        process.env.VUH_2142_BRIDGE_PROOF_PATH,
        JSON.stringify({ result, stderr }, null, 2) + "\n",
      );
  } finally {
    await client.close();
    await service.close();
    await captain.close();
    await new Promise<void>((done) => {
      http.close(() => done());
      http.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
