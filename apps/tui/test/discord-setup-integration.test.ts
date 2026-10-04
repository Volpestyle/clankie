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
      ownerUserId: "30002",
      swarmGuildId: "10001",
      teamVisible: false,
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
      wire.setup.definition.sentences[0].parts[0].text = "Clankie makes his home in ";
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
  current.handleInput("\r");
}
const submit = (shell: ClankieFaceShell, text: string) =>
  (shell as unknown as { submitEditorText(text: string): Promise<void> }).submitEditorText(text);

it("the real CLI sets all four sentences by name on a loopback host without granting computer access implicitly", async () => {
  const f = await fixture();
  const initial = await f.cli("setup");
  expect(initial.sentences[0].text).toBe("Clankie makes his home in no selected server.");
  expect(initial.sentences[2].text).toContain("Ivo");
  expect(initial.sentences[3].text).toBe("The team’s rooms stay hidden in Studio.");
  const home = await f.cli("setup", "home", "--server", "@2");
  expect(home.sentences[0].text).toBe("Clankie makes his home in Garden.");
  const choices = await f.cli("setup", "choices", "talk");
  expect(choices.pickers[0].choices[0].name).toContain("#general");
  const talk = await f.cli("setup", "talk", "--channel", "general", "--channel", "Talk");
  expect(talk.snapshot.settings.ingressChannelIds).toEqual(["20011", "20014"]);
  expect(talk.snapshot.settings.voiceChannelIds).toEqual(["20014"]);
  expect(talk.snapshot.settings.textIngressEnabled).toBe(true);
  expect(talk.snapshot.settings.voiceEnabled).toBe(true);
  expect(talk.snapshot.settings.systemActorUserIds).toEqual(["30005"]);
  expect(talk.snapshot.settings.userSessionEnabled).toBe(false);
  expect(talk.snapshot.settings.userSessionVoiceEnabled).toBe(true);
  expect(
    talk.sentences[1].checks.find((check: { kind: string }) => check.kind === "send_messages").status,
  ).toBe("not_checked");
  const people = await f.cli("setup", "computer", "--access", "people", "--person", "James");
  expect(people.snapshot.settings.systemActorUserIds).toEqual(["30002"]);
  const serverGrant = await f.cli("setup", "computer", "--access", "servers", "--server", "Garden");
  expect(serverGrant.snapshot.settings.systemActorGuildIds).toEqual(["10002"]);
  expect(serverGrant.snapshot.settings.systemActorUserIds).toEqual([]);
  const me = await f.cli("setup", "computer", "--access", "me");
  expect(me.sentences[2].text).toBe("Only me can ask him to use Fixture’s Mac.");
  expect(me.snapshot.settings.systemActorGuildIds).toEqual([]);
  const team = await f.cli("setup", "team", "--visible", "on", "--server", "Garden");
  expect(team.sentences[3].text).toBe("The team’s rooms show up in Garden.");
  const hidden = await f.cli("setup", "team", "--visible", "off");
  expect(hidden.snapshot.settings.swarmGuildId).toBe("10002");
  const afterHidden = (await f.api.discordSettings()).revision;
  await expect(
    f.cli("setup", "team", "--visible", "on", "--server", "not in the directory"),
  ).rejects.toThrow();
  expect((await f.api.discordSettings()).revision).toBe(afterHidden);
  expect(
    f.requests.filter(({ method, path }) => method === "POST" && path === "/v1/discord/settings"),
  ).toHaveLength(7);
  await f.cli("setup", "computer", "--access", "nobody");
  expect((await f.settings.load()).discord.systemActorUserIds).toEqual([]);
  expect(
    f.requests.every(
      ({ path }) => path.startsWith("/v1/discord/settings") || path.startsWith("/v1/discord/directory"),
    ),
  ).toBe(true);
});

it("real TUI overlays render host copy, pick names, retain Advanced and use the same writer as the CLI", async () => {
  const f = await fixture();
  const shell = f.shell();
  let finished = false;
  let running = submit(shell, "/discord").finally(() => {
    finished = true;
  });
  try {
    const main = await prompt(shell, "Clankie makes his home in");
    const before = stripVTControlCharacters(main.render(180).join("\n"));
    expect(before).toContain("not checked");
    expect(before).toContain("Fixture’s Mac");
    await choose(shell, "Discord", "Clankie makes his home");
    await choose(shell, "Choose a server", "Garden");
    await choose(shell, "Discord", "He talks with");
    await choose(shell, "Computer access is a separate choice", "general");
    await choose(shell, "Computer access is a separate choice", "Save selection");
    await choose(shell, "Discord", "can ask him to use");
    await choose(shell, "Choose explicitly", "Only me");
    await choose(shell, "Discord", "The team’s rooms");
    await choose(shell, "Hiding keeps", "show up");
    await choose(shell, "Hiding keeps", "Garden");
    await choose(shell, "Discord", "Advanced");
    await choose(shell, "Discord setting", "Owner user ID");
    const raw = await prompt(shell, "ownerUserId");
    for (const char of "30005") raw.handleInput(char);
    raw.handleInput("\r");
    await choose(shell, "Discord", "Done");
    await running;
    const view = await f.cli("setup");
    expect(view.sentences[0].text).toBe("Clankie makes his home in Garden.");
    expect(view.sentences[1].text).toContain("#general");
    expect(view.snapshot.settings.voiceChannelIds).toEqual([]);
    expect(view.snapshot.settings.systemActorUserIds).toEqual(["30002"]);
    expect(view.snapshot.settings.ownerUserId).toBe("30005");
    expect(view.snapshot.settings.swarmGuildId).toBe("10002");
    expect(view.snapshot.settings.teamVisible).toBe(true);
    f.disconnect();
    finished = false;
    running = submit(shell, "/discord").finally(() => {
      finished = true;
    });
    await choose(shell, "Discord", "The team’s rooms");
    await choose(shell, "Hiding keeps", "stay hidden");
    await choose(shell, "Hiding keeps", "Keep the current choice");
    await choose(shell, "Discord", "Done");
    await running;
    expect((await f.settings.load()).discord.teamVisible).toBe(false);
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
  await f.cli("setup", "home", "--server", "Studio");
  await expect(client.apply(stale, "team", 0, { visible: true })).rejects.toThrow(
    /409|settings_revision_conflict/u,
  );
  expect((await f.settings.load()).discord.teamVisible).toBe(false);
  f.disconnect();
  const view = await client.read();
  expect(
    view.sentences.flatMap((sentence) => sentence.checks).every((check) => check.status === "not_checked"),
  ).toBe(true);
  await expect(f.cli("setup", "home", "--server", "Studio")).rejects.toThrow();
  f.revoke();
  await expect(client.apply(view, "team", 0, { visible: true })).rejects.toThrow(/403/u);
  expect((await f.settings.load()).discord.teamVisible).toBe(false);
});

it("an older client strips additive picker bindings and field metadata from a new host response", async () => {
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
  const parsed = parseProtocolResponse(oldSnapshot, wire);
  expect(parsed.setup.definition.sentences).toHaveLength(4);
  expect(parsed.setup.definition.sentences[1]!.parts[1]).not.toHaveProperty("enables");
  expect(parsed.setup.definition.sentences[2]!.parts[0]).not.toHaveProperty("accessFields");
  expect(
    parsed.setup.definition.advancedGroups
      .flatMap((group) => group.fields)
      .find((field) => field.key === "voiceChannelIds"),
  ).not.toHaveProperty("directoryKinds");
  expect(parsed.settings.teamVisible).toBe(false);
});
