import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { ClankieApiClient, DiscordSetupClient } from "@clankie/api-client";
import { DiscordSettingsSchema, parseProtocolResponse } from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { createDiscordRoomRoutes } from "../../clankie/src/discord-room-routes.ts";
import { DiscordRoomObservations } from "../../clankie/src/discord-room-observations.ts";
import { ClankieFaceShell } from "../src/shell/shell.ts";
import { buildDiscordCommands } from "../src/discord-commands.ts";
import { InteractiveSelectPrompt, InteractiveTextPrompt } from "../src/face/clankie-interactive-flow.ts";
import { botCache } from "../../discord-bridge/test/fixtures/directory.ts";
import { readBotDiscordDirectory } from "../../discord-bridge/src/directory.ts";
import { ownerDescriptorPaths } from "../../../scripts/testing/vitest-setup.ts";

const execute = promisify(execFile);
const resources: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of resources.splice(0).reverse()) await cleanup();
});
const repoRoot = resolve(import.meta.dirname, "../../..");
const readBytes = (path: string) =>
  readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });

async function fixture() {
  const before = await Promise.all(ownerDescriptorPaths.map(readBytes));
  resources.push(async () => {
    expect(await Promise.all(ownerDescriptorPaths.map(readBytes))).toEqual(before);
  });
  const root = await mkdtemp(join(tmpdir(), "discord-sentences-"));
  resources.push(() => rm(root, { recursive: true, force: true }));
  const state = join(root, "private-state");
  const descriptorPath = join(state, "links", "default-local.json");
  await mkdir(join(state, "links"), { recursive: true });
  const descriptor = Buffer.from(
    '{"schemaVersion":2,"authentication":"local-process","url":"http://127.0.0.1:1","socket":"/fixture/no.sock"}\n',
  );
  await writeFile(descriptorPath, descriptor);
  resources.push(async () => {
    expect(await readFile(descriptorPath)).toEqual(descriptor);
  });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    USERPROFILE: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    CLANKIE_STATE: state,
    CLANKIE_OPERATOR_TOKEN: "fixture-operator",
    CLANKIE_SETTINGS_FILE: join(root, "client-settings.json"),
    CLANKIE_CREDENTIALS_FILE: join(root, "credentials.json"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
  };
  const settings = new SettingsStore(join(root, "host-settings.json"));
  await settings.update((current) => ({
    ...current,
    discord: {
      ...current.discord,
      applicationId: "90001",
      ownerUserId: "30002",
      swarmGuildId: "10001",
      teamVisible: false,
      ingressChannelIds: ["20001"],
      voiceChannelIds: ["20004"],
      systemActorUserIds: ["30005"],
    },
  }));
  const cache = botCache(true);
  let authorized = true;
  const requests: { method: string; path: string }[] = [];
  const app = createDiscordRoomRoutes({
    settings,
    machineName: "Fixture’s Mac",
    environment: {},
    observations: new DiscordRoomObservations(join(root, "rooms.json")),
    captain: { serveOperatorConversation: async () => ({ schemaVersion: 1, op: "list", conversations: [] }) },
    authorize: async (request) =>
      authorized && request.headers.get("authorization") === "Bearer fixture-operator"
        ? {
            current: () => authorized,
            guard: async () => {
              if (!authorized) throw new Error("revoked");
            },
          }
        : undefined,
    directory: async (query) => readBotDiscordDirectory(cache.client, { ...query, limit: 1 }),
  });
  const server: Server = createServer(async (request, response) => {
    const path = request.url ?? "/";
    requests.push({ method: request.method ?? "GET", path });
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const result = await app.request(`http://127.0.0.1${path}`, {
      method: request.method ?? "GET",
      headers: new Headers(
        Object.entries(request.headers).flatMap(([key, value]): [string, string][] =>
          value ? [[key, String(value)]] : [],
        ),
      ),
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    response.writeHead(result.status, Object.fromEntries(result.headers));
    // A future host changes display copy and adds optional metadata. Real clients
    // must render its definition and tolerate the additive response fields.
    if (path === "/v1/discord/settings" && result.ok) {
      const wire = await result.json();
      wire.setup.definition.sentences[0].parts[0].text = "Clankie connects to ";
      wire.futureOptional = { example: true };
      response.end(JSON.stringify(wire));
    } else response.end(Buffer.from(await result.arrayBuffer()));
  });
  resources.push(
    () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
        server.closeAllConnections();
      }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback host");
  const url = `http://127.0.0.1:${address.port}`;
  env.CLANKIE_CONTROL_PLANE_URL = url;
  const api = new ClankieApiClient({ baseUrl: url, operatorToken: "fixture-operator" });
  async function cli(...args: string[]) {
    const result = await execute(
      process.execPath,
      [
        "--import",
        resolve(repoRoot, "apps/tui/node_modules/tsx/dist/loader.mjs"),
        resolve(repoRoot, "apps/tui/bin/clankie.ts"),
        "discord",
        ...args,
      ],
      { env, cwd: repoRoot, timeout: 15_000 },
    );
    expect(result.stderr).toBe("");
    expect(await readFile(descriptorPath)).toEqual(descriptor);
    return JSON.parse(result.stdout);
  }
  function shell() {
    const commands = buildDiscordCommands({
      setup: api,
      settings: new SettingsStore(env.CLANKIE_SETTINGS_FILE),
      localAdvanced: false,
      listCredentials: async () => ({}),
      removeCredential: async () => undefined,
      setCredential: async () => {},
    });
    return new ClankieFaceShell({ commands, cwd: root, env, bannerFields: { title: "Clankie" } });
  }
  return {
    root,
    cli,
    settings,
    shell,
    api,
    requests,
    url,
    disconnect: cache.disconnect,
    revoke: () => {
      authorized = false;
    },
  };
}
async function prompt(shell: ClankieFaceShell, contains: string) {
  let current!: InteractiveSelectPrompt | InteractiveTextPrompt;
  await vi.waitFor(() => {
    const focused = shell.tui.getFocusedComponent();
    expect(focused instanceof InteractiveSelectPrompt || focused instanceof InteractiveTextPrompt).toBe(true);
    expect(stripVTControlCharacters(focused!.render(180).join("\n")).toLocaleLowerCase()).toContain(
      contains.toLocaleLowerCase(),
    );
    current = focused as InteractiveSelectPrompt | InteractiveTextPrompt;
  });
  return current;
}
async function choose(shell: ClankieFaceShell, contains: string, filter: string) {
  const current = await prompt(shell, contains);
  current.handleInput("\x15");
  for (const char of filter) current.handleInput(char);
  // Fleet help also mentions Advanced; select the actual Advanced row.
  if (filter === "Advanced") current.handleInput("\x1b[B");
  current.handleInput("\r");
}
const submit = (shell: ClankieFaceShell, text: string) =>
  (shell as unknown as { submitEditorText(text: string): Promise<void> }).submitEditorText(text);

it("the real CLI connects a server and role, toggles fleet and selects tracking without room lists or machine grants", async () => {
  const f = await fixture();
  const initial = await f.cli("setup");
  expect(initial.sentences[0].text).toBe(
    "Clankie connects to no selected server with Clankie as Participant.",
  );
  expect(initial.sentences).toHaveLength(3);
  const connect = await f.cli("setup", "connect", "--server", "@2", "--role", "participant");
  expect(connect.sentences[0].text).toBe("Clankie connects to Garden with Clankie as Participant.");
  expect(connect.snapshot.settings.serverId).toBe("10002");
  for (const key of ["ingressGuildIds", "presenceGuildIds", "voiceGuildIds", "userSessionGuildIds"])
    expect(connect.snapshot.settings[key]).toEqual(["10002"]);
  for (const key of [
    "ingressChannelIds",
    "presenceChannelIds",
    "voiceChannelIds",
    "userSessionChannelIds",
    "userSessionVoiceChannelIds",
  ])
    expect(connect.snapshot.settings[key]).toEqual([]);
  expect(connect.snapshot.settings.textIngressEnabled).toBe(true);
  expect(connect.snapshot.settings.voiceEnabled).toBe(true);
  expect(connect.snapshot.settings.systemActorUserIds).toEqual(["30005"]);
  expect(connect.snapshot.settings.userSessionEnabled).toBe(false);
  expect(connect.snapshot.settings.userSessionVoiceEnabled).toBe(false);
  expect(connect.snapshot.settings.swarmGuildId).toBeUndefined();
  const choices = await f.cli("setup", "choices", "connect");
  expect(choices.pickers.map((part: { kind: string }) => part.kind)).toEqual(["server", "role"]);
  expect(choices.pickers[1].choices.map((choice: { choice: string }) => choice.choice)).toEqual([
    "participant",
    "admin",
  ]);
  const fleet = await f.cli("setup", "fleet", "--enabled", "on");
  expect(fleet.snapshot.settings.fleetEnabled).toBe(true);
  const tracking = await f.cli("setup", "tracking", "--level", "project_activity");
  expect(tracking.snapshot.settings.trackingLevel).toBe("project_activity");
  const invite = await f.cli("setup", "invite", "--role", "admin");
  expect(new URL(invite.url).searchParams.get("permissions")).toBe("8");
  expect((await f.settings.load()).discord.role).toBe("admin");
  expect((await f.settings.load()).discord.swarmGuildId).toBe("10002");
  const hidden = await f.cli("setup", "fleet", "--enabled", "off");
  expect(hidden.snapshot.settings.serverId).toBe("10002");
  expect(hidden.snapshot.settings.teamVisible).toBe(false);
  const beforeInvalid = (await f.api.discordSettings()).revision;
  await expect(f.cli("setup", "connect", "--server", "not in the directory")).rejects.toThrow();
  expect((await f.api.discordSettings()).revision).toBe(beforeInvalid);
  expect((await f.settings.load()).discord.systemActorUserIds).toEqual(["30005"]);
  expect(
    f.requests
      .filter(({ path }) => path.startsWith("/v1/discord/directory"))
      .every(({ path }) => new URL(path, f.url).searchParams.get("kind") === "servers"),
  ).toBe(true);
  expect(
    f.requests.every(
      ({ path }) => path.startsWith("/v1/discord/settings") || path.startsWith("/v1/discord/directory"),
    ),
  ).toBe(true);
});

it("real TUI overlays use the shared role, fleet and tracking writer and keep raw IDs in Advanced", async () => {
  const f = await fixture();
  const shell = f.shell();
  let finished = false;
  let running = submit(shell, "/discord").finally(() => {
    finished = true;
  });
  try {
    const main = await prompt(shell, "Clankie connects to");
    const before = stripVTControlCharacters(main.render(180).join("\n"));
    expect(before).toContain("not checked");
    expect(before).not.toContain("He talks with");
    expect(before).not.toContain("can ask him to use");
    await choose(shell, "Invite Clankie to a server", "Clankie connects to");
    await choose(shell, "Participant follows", "Garden");
    await choose(shell, "Participant / Admin", "Admin");
    await choose(shell, "Invite Clankie to a server", "Fleet in Discord");
    await choose(shell, "Admin creates fleet channels", "on");
    await choose(shell, "Invite Clankie to a server", "Project tracking");
    await choose(shell, "published updates", "project activity");
    await choose(shell, "Invite Clankie to a server", "Advanced");
    await choose(shell, "Discord setting", "Participant fleet channel ID");
    const raw = await prompt(shell, "fleetChannelId");
    for (const char of "20011") raw.handleInput(char);
    raw.handleInput("\r");
    await choose(shell, "Invite Clankie to a server", "Done");
    await running;
    const view = await f.cli("setup");
    expect(view.sentences[0].text).toBe(
      "Clankie connects to Garden with Clankie as Admin · dedicated server.",
    );
    expect(view.snapshot.settings.role).toBe("admin");
    expect(view.snapshot.settings.fleetEnabled).toBe(true);
    expect(view.snapshot.settings.trackingLevel).toBe("project_activity");
    expect(view.snapshot.settings.fleetChannelId).toBe("20011");
    expect(view.snapshot.settings.systemActorUserIds).toEqual(["30005"]);
    expect(view.snapshot.settings.swarmGuildId).toBe("10002");
    f.disconnect();
    finished = false;
    running = submit(shell, "/discord").finally(() => {
      finished = true;
    });
    await choose(shell, "Invite Clankie to a server", "Fleet in Discord");
    await choose(shell, "Admin creates fleet channels", "off");
    await choose(shell, "Invite Clankie to a server", "Done");
    await running;
    expect((await f.settings.load()).discord.fleetEnabled).toBe(false);
    expect((await f.settings.load()).discord.serverId).toBe("10002");
    expect((await f.settings.load()).discord.swarmGuildId).toBe("10002");
  } finally {
    for (let attempt = 0; !finished && attempt < 10; attempt++) {
      shell.setupFlow.handleSubmit("/cancel");
      await new Promise((resolveTick) => setTimeout(resolveTick, 50));
    }
    await running;
  }
});

it("stale or revoked writes fail and a disconnected account never reports successful checks", async () => {
  const f = await fixture();
  const client = new DiscordSetupClient(f.api);
  const stale = await client.read();
  await f.cli("setup", "connect", "--server", "Studio");
  await expect(client.apply(stale, "fleet", 0, { value: "on" })).rejects.toThrow(
    /409|settings_revision_conflict/u,
  );
  expect((await f.settings.load()).discord.teamVisible).toBe(false);
  f.disconnect();
  const view = await client.read();
  expect(
    view.sentences.flatMap((sentence) => sentence.checks).every((check) => check.status === "not_checked"),
  ).toBe(true);
  await expect(f.cli("setup", "connect", "--server", "Studio")).rejects.toThrow();
  f.revoke();
  await expect(client.apply(view, "fleet", 0, { value: "on" })).rejects.toThrow(/403/u);
  expect((await f.settings.load()).discord.teamVisible).toBe(false);
});

it("an older four-sentence client refuses the incompatible setup model version explicitly", async () => {
  const f = await fixture();
  // The display contract before VUH-1628: no enables, accessFields or directoryKinds.
  const key = z.enum(Object.keys(DiscordSettingsSchema.shape) as [string, ...string[]]);
  const oldPart = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), text: z.string() }).strict(),
    z.object({ kind: z.literal("machine") }).strict(),
    z
      .object({
        kind: z.literal("picker"),
        picker: z.enum(["server", "channels", "computer_access", "team_visibility"]),
        fields: z.array(key),
        placeholder: z.string(),
      })
      .strict(),
  ]);
  const oldSnapshot = z
    .object({
      settings: DiscordSettingsSchema,
      revision: z.string(),
      setup: z
        .object({
          machineName: z.string(),
          definition: z
            .object({
              schemaVersion: z.literal(1),
              sentences: z.array(
                z
                  .object({
                    id: z.string(),
                    parts: z.array(oldPart),
                    help: z.string(),
                    checks: z.array(z.string()),
                    explicitComputerAccess: z.boolean().optional(),
                  })
                  .strict(),
              ),
              advancedGroups: z.array(
                z
                  .object({
                    title: z.string(),
                    fields: z.array(
                      z
                        .object({
                          key,
                          label: z.string(),
                          help: z.string().optional(),
                          kind: z.string(),
                          choices: z.array(z.string()).optional(),
                        })
                        .strict(),
                    ),
                  })
                  .strict(),
              ),
              choiceLabels: z.record(z.string(), z.string()),
            })
            .strict(),
        })
        .strict(),
    })
    .strict();
  const response = await fetch(`${f.url}/v1/discord/settings`, {
    headers: { authorization: "Bearer fixture-operator" },
  });
  const wire = await response.json();
  expect(oldSnapshot.safeParse(wire).success).toBe(false);
  expect(() => parseProtocolResponse(oldSnapshot, wire)).toThrow();
  expect(wire.setup.definition.schemaVersion).toBe(2);
  expect(wire.setup.definition.sentences.map((sentence: { id: string }) => sentence.id)).toEqual([
    "connect",
    "fleet",
    "tracking",
  ]);
});
