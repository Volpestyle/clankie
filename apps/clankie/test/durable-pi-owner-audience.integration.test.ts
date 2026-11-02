import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { DiscordPresenceChannelTurnRequest } from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { updateGlobalConfig } from "../../../packages/model-provider/src/config.ts";
import { createCaptain } from "../src/captain/captain.ts";
import { createDiscordTurns } from "../src/captain/captain-discord-turns.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";

// ADR 0284 widened (#368): which Pi room turns are journaled. Real captain, Pi
// and journal, with a scripted loopback model; Discord's channel and guild reads
// are fixture data behind the captain's own Discord action port, so the owner-only
// audience proof runs its real checks. No restart here: the restart contract is
// proven for owner DMs in durable-pi-room-restart.integration.test.ts.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const OWNER = "11111";
const GUILD = "12345";
const PRIVATE = "67890";
const MIXED = "67891";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "durable-owner-audience-"));
  const overrides = {
    XDG_CONFIG_HOME: join(root, "config"),
    CLANKIE_CREDENTIALS_FILE: join(root, "credentials.json"),
    CLANKIE_MODELS_PATH: join(root, "catalog.json"),
    CLANKIE_DISABLE_MODELS_FETCH: "1",
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  await writeFile(overrides.CLANKIE_MODELS_PATH, "{}");
  const model = createServer(async (request, response) => {
    for await (const _ of request) {
      /* consume the provider request */
    }
    const frame = (delta: object, finish: string | null) =>
      `data: ${JSON.stringify({
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "scripted",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      frame({ role: "assistant", content: "Answered." }, null) + frame({}, "stop") + "data: [DONE]\n\n",
    );
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const address = model.address();
  if (address === null || typeof address === "string") throw new Error("Missing loopback address");
  await updateGlobalConfig((config) => {
    config.enabled_providers = ["fixture"];
    config.model = "fixture/scripted";
    config.routing = { routine_model: config.model, escalate: false };
    config.provider = {
      fixture: {
        name: "fixture",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `http://127.0.0.1:${address.port}/v1` },
        models: { scripted: { name: "scripted", limit: { context: 100000, output: 512 } } },
      },
    };
  });
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    discord: {
      ...current.discord,
      ownerUserId: OWNER,
      servers: [{ serverId: GUILD, role: "admin", owners: "me" }],
      systemActorUserIds: [OWNER],
    },
    machineAccess: { ...current.machineAccess, local: "shell" },
  }));
  const channel = (id: string) => ({
    id,
    type: 0,
    guild_id: GUILD,
    // The private room denies @everyone read access; the mixed room does not.
    permission_overwrites: id === PRIVATE ? [{ id: GUILD, type: 0, allow: "0", deny: "1024" }] : [],
  });
  const captain = createCaptain(
    {
      roomTurns: createDiscordTurns,
      herdrAvailable: () => false,
      embodiment: {},
      discordActions: {
        serverAction: async (action: { path: string }) => ({
          ok: true,
          message: "Fixture Discord metadata",
          data:
            action.path === "/users/@me"
              ? { id: "30001", bot: true }
              : action.path === `/guilds/${GUILD}`
                ? { id: GUILD, owner_id: OWNER }
                : action.path === `/guilds/${GUILD}/roles`
                  ? [{ id: GUILD, permissions: "0" }]
                  : channel(action.path.split("/").at(-1)!),
        }),
        execute: async () => {
          throw new Error("This fixture never posts");
        },
      },
      memory: {
        recallEpisodeCard: async () => "",
        searchEpisodeCard: async () => "",
        recallDiscordPerson: () => "",
      },
      mcp: { catalog: async () => [] },
      browser: { catalog: async () => ({ available: false, tools: [] }) },
    } as unknown as CaptainDeps,
    { repoRoot: root, stateDir: join(root, "captain"), settings, discordEnvironment: {} },
  );
  cleanup.push(async () => {
    await captain.close();
    model.closeAllConnections();
    await new Promise<void>((done) => model.close(() => done()));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const message = (
    deliveryId: string,
    channelId: string,
    actorId = OWNER,
    transportKind: "bot" | "user_session" = "bot",
  ): DiscordPresenceChannelTurnRequest => ({
    schemaVersion: 1,
    deliveryId,
    identity: {
      presenceSessionId: "body:room",
      correlationId: deliveryId,
      characterId: "clankie",
      credentialRef: transportKind === "bot" ? "discord_bot" : "discord_user_session",
      transportKind,
      profileHash: "fixture",
    },
    trigger: {
      kind: "mention",
      id: deliveryId,
      guildId: GUILD,
      channelId,
      actorId,
      body: "Hi.",
      attachments: [],
    },
    contextMessages: [],
  });
  const journal = (deliveryId: string) =>
    join(
      root,
      "captain/durable-pi-room",
      createHash("sha256").update(JSON.stringify(deliveryId)).digest("hex"),
      "turn.json",
    );
  return { captain, message, journal };
}

it("journals the owner's Pi turn in a proven owner-only room, and not in a mixed room", async () => {
  const f = await fixture();
  const owned = f.message("1400000000000000001", PRIVATE);
  expect(await f.captain.submitDiscordTurn(owned)).toMatchObject({ state: "settled", response: "Answered." });
  const saved = JSON.parse(await readFile(f.journal(owned.deliveryId), "utf8")) as {
    result?: unknown;
    steps: unknown[];
  };
  expect(saved.result).toMatchObject({ state: "settled", response: "Answered." });
  // Settled and compacted: a turn with no uncertain effects keeps only its answer.
  expect(saved.steps).toEqual([]);

  // The same owner in a room others can read: answered as before, with no journal.
  const mixed = f.message("1400000000000000002", MIXED);
  expect(await f.captain.submitDiscordTurn(mixed)).toMatchObject({ state: "settled" });
  expect(existsSync(f.journal(mixed.deliveryId))).toBe(false);
}, 120_000);

it("retains a recovery request only for the owner's text through the official bot", async () => {
  const f = await fixture();
  expect(f.captain.retainsDiscordTurn?.(f.message("1", PRIVATE))).toBe(true);
  expect(f.captain.retainsDiscordTurn?.(f.message("2", PRIVATE, "22222"))).toBe(false);
  expect(f.captain.retainsDiscordTurn?.(f.message("3", PRIVATE, OWNER, "user_session"))).toBe(false);
  // Nothing was journaled, so nothing resumes.
  expect(f.captain.canResumeDiscordTurn?.(f.message("1", PRIVATE))).toBe(false);
});
