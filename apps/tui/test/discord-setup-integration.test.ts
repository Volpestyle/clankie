import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { ClankieApiClient, DiscordSetupClient } from "@clankie/api-client";
import { DiscordSettingsSchema, parseProtocolResponse } from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { personaStatus, personaUpdate } from "../src/command/persona.ts";
import { createPersonaVoiceSettingsRoutes } from "../../clankie/src/persona-voice-settings-routes.ts";
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
async function fixture(beforeReply?: (path: string) => Promise<void>) {
  // The real owner can update links while this suite runs. Plant a descriptor
  // in Vitest's private parent HOME instead of snapshotting a live owner file.
  // The CLI gets its own HOME/state below, so neither descriptor may change.
  const parentDescriptorPath = join(homedir(), ".clankie", "links", "default-local.json");
  expect(ownerDescriptorPaths).not.toContain(parentDescriptorPath);
  await mkdir(join(homedir(), ".clankie", "links"), { recursive: true });
  const parentDescriptor = Buffer.from(
    '{"schemaVersion":2,"authentication":"local-process","url":"http://127.0.0.1:1","socket":"/fixture/parent.sock"}\n',
  );
  await writeFile(parentDescriptorPath, parentDescriptor, { flag: "wx" });
  resources.push(async () => {
    try {
      expect(await readFile(parentDescriptorPath)).toEqual(parentDescriptor);
    } finally {
      await rm(parentDescriptorPath, { force: true });
    }
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
  app.route(
    "/",
    createPersonaVoiceSettingsRoutes({
      settings,
      authorizePersona: async (request) =>
        authorized && request.headers.get("authorization") === "Bearer fixture-operator"
          ? true
          : "authentication_required",
      operator: async (request) =>
        authorized && request.headers.get("authorization") === "Bearer fixture-operator"
          ? "fixture-owner"
          : undefined,
      voiceSettingsEnv: {},
    }),
  );
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
    await beforeReply?.(path);
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
      { env, cwd: repoRoot },
    );
    expect(result.stderr).toBe("");
    expect(await readFile(descriptorPath)).toEqual(descriptor);
    return JSON.parse(result.stdout);
  }
  function shell(persona?: Parameters<typeof buildDiscordCommands>[0]["persona"]) {
    let revision: string | undefined;
    const commands = buildDiscordCommands({
      persona: persona ?? {
        read: async () => {
          const snapshot = await personaStatus({ env, host: url });
          revision = snapshot.revision;
          return snapshot.persona;
        },
        update: async (patch) => {
          if (!revision) throw new Error("Read persona before changing it");
          return personaUpdate(patch, { env, host: url, expectedRevision: revision });
        },
      },
      setup: api,
      env,
      host: url,
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
const commandsInFlight = new WeakMap<ClankieFaceShell, Promise<void>>();
async function prompt(shell: ClankieFaceShell, contains: string) {
  const running = commandsInFlight.get(shell);
  if (!running) throw new Error("Start a command before waiting for its prompt");
  let observe!: () => void;
  const ready = new Promise<InteractiveSelectPrompt | InteractiveTextPrompt>((resolve) => {
    observe = () => {
      const focused = shell.tui.getFocusedComponent();
      if (!(focused instanceof InteractiveSelectPrompt || focused instanceof InteractiveTextPrompt)) return;
      if (
        !stripVTControlCharacters(focused.render(180).join("\n"))
          .toLocaleLowerCase()
          .includes(contains.toLocaleLowerCase())
      )
        return;
      resolve(focused);
    };
  });
  // The real setup flow requests a render after focusing each overlay. Observe
  // that event, preserving rendering, rather than timing HTTP/FS work at 1s.
  const render = shell.tui.requestRender.bind(shell.tui);
  const observer = vi.spyOn(shell.tui, "requestRender").mockImplementation((...args) => {
    render(...args);
    observe();
  });
  try {
    observe();
    return await Promise.race([
      ready,
      running.then(() => {
        throw new Error(`Command ended before prompt: ${contains}`);
      }),
    ]);
  } finally {
    observer.mockRestore();
  }
}
async function choose(shell: ClankieFaceShell, contains: string, filter: string) {
  const current = await prompt(shell, contains);
  current.handleInput("\x15");
  for (const char of filter) current.handleInput(char);
  // Fleet help also mentions Advanced; select the actual Advanced row.
  if (filter === "Advanced") current.handleInput("\x1b[B");
  current.handleInput("\r");
}
const submit = (shell: ClankieFaceShell, text: string) => {
  const running = (shell as unknown as { submitEditorText(text: string): Promise<void> }).submitEditorText(
    text,
  );
  commandsInFlight.set(shell, running);
  return running;
};

it("the real CLI and HTTP API require explicit household author confirmation, preserve omissions and fence stale writes", async () => {
  const f = await fixture();
  const initial = await f.api.discordSettings();
  const flags = ["legacy-author", "--household", "existing", "--user", "30002", "--author", "Legacy author"];
  await expect(f.cli(...flags)).rejects.toThrow();
  expect((await f.settings.load()).discord.houseHuntingAuthorBindings).toEqual([]);
  const added = await f.cli(...flags, "--confirm");
  const binding = {
    household: "existing",
    userId: "30002",
    legacyAuthor: "Legacy author",
    ownerConfirmed: true,
  };
  expect(added.discord.houseHuntingAuthorBindings).toEqual([binding]);
  const snapshot = await f.api.discordSettings();
  const post = (settings: unknown, expectedRevision = snapshot.revision, authenticated = true) =>
    fetch(`${f.url}/v1/discord/settings`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authenticated ? { authorization: "Bearer fixture-operator" } : {}),
      },
      body: JSON.stringify({ settings, expectedRevision }),
    });
  expect((await post(snapshot.settings, initial.revision)).status).toBe(409);
  expect((await post(snapshot.settings, snapshot.revision, false)).status).toBe(403);
  for (const invalid of [
    { household: "existing", userId: "30002", legacyAuthor: "Legacy author" },
    { ...binding, ownerConfirmed: false },
    { ...binding, legacyAuthor: "30003" },
    { ...binding, household: "../../another" },
    { ...binding, legacyAuthor: " Legacy author" },
  ])
    expect((await post({ ...snapshot.settings, houseHuntingAuthorBindings: [invalid] })).status).toBe(400);
  expect(
    (
      await post({
        ...snapshot.settings,
        houseHuntingAuthorBindings: [binding, { ...binding, userId: "30003" }],
      })
    ).status,
  ).toBe(400);
  const old: Record<string, unknown> = { ...snapshot.settings, ambientUserIds: ["30006"] };
  delete old.houseHuntingAuthorBindings;
  expect((await post(old)).status).toBe(200);
  expect((await f.settings.load()).discord.houseHuntingAuthorBindings).toEqual([binding]);
  await f.cli(
    "legacy-author",
    "--household",
    "existing",
    "--user",
    "30003",
    "--author",
    "Legacy author",
    "--remove",
  );
  expect((await f.settings.load()).discord.houseHuntingAuthorBindings).toEqual([binding]);
  await f.cli(...flags, "--remove");
  expect((await f.settings.load()).discord.houseHuntingAuthorBindings).toEqual([]);
});

it.each(["confirm", "cancel"])(
  "the real TUI asks for every new author binding before saving (%s)",
  async (decision) => {
    const f = await fixture(),
      shell = f.shell();
    const bindings = ["First legacy author", "Second legacy author"].map((legacyAuthor, i) => ({
      household: "existing",
      userId: String(30002 + i),
      legacyAuthor,
      ownerConfirmed: true,
    }));
    let settled = false;
    const running = submit(shell, "/discord").finally(() => {
      settled = true;
    });
    try {
      await choose(shell, "Invite Clankie to a server", "Advanced");
      await choose(shell, "Discord setting", "Household author bindings");
      const editor = await prompt(shell, "houseHuntingAuthorBindings");
      editor.handleInput(JSON.stringify(bindings));
      editor.handleInput("\r");
      await choose(shell, "First legacy author", "I confirm");
      expect((await f.settings.load()).discord.houseHuntingAuthorBindings).toEqual([]);
      await choose(shell, "Second legacy author", decision === "confirm" ? "I confirm" : "Cancel");
      await choose(shell, "Invite Clankie to a server", "Done");
      await running;
      expect((await f.settings.load()).discord.houseHuntingAuthorBindings).toEqual(
        decision === "confirm" ? bindings : [],
      );
    } finally {
      if (!settled) {
        shell.setupFlow.handleSubmit("/cancel");
        await running;
      }
    }
  },
);

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
    expect(connect.snapshot.settings[key]).toContain("10002");
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
    await choose(shell, "Invite Clankie to a server", "Server owners");
    await choose(shell, "Server", "Garden");
    await choose(shell, "Clankie's role", "Admin");
    await choose(shell, "Owners here", "A Discord role");
    await choose(shell, "Owner role", "Builders");
    await choose(shell, "Invite Clankie to a server", "This room can use");
    await choose(shell, "Server", "Garden");
    await choose(shell, "Room", "general");
    await choose(shell, "This room can use", "House hunting");
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
    expect(view.snapshot.settings.servers).toContainEqual({
      serverId: "10002",
      role: "admin",
      owners: "role",
      ownerRoleId: "10003",
    });
    expect(view.snapshot.settings.roomSkills).toContainEqual({
      serverId: "10002",
      channelId: "20011",
      skill: "house-hunting",
    });
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

it("the attention section saves the wake trigger through the settings API and chattiness through the persona writer", async () => {
  const f = await fixture();
  // A trigger saved before the rename keeps its meaning and shows its new name.
  await f.settings.update((current) => ({
    ...current,
    discord: { ...current.discord, wakeTrigger: "addressed" },
  }));
  const shell = f.shell();
  let finished = false;
  const running = submit(shell, "/discord").finally(() => {
    finished = true;
  });
  try {
    await choose(shell, "Invite Clankie to a server", "What wakes him");
    const section = await prompt(shell, "whatever length fits");
    const rendered = stripVTControlCharacters(section.render(180).join("\n"));
    expect(rendered).toContain("Only an @mention");
    expect(rendered).toContain("Balanced");
    await choose(shell, "whatever length fits", "What wakes him in text");
    const wake = stripVTControlCharacters((await prompt(shell, "does not wake him")).render(180).join("\n"));
    expect(wake).toContain("An @mention or his name");
    await choose(shell, "does not wake him", "or his name");
    await choose(shell, "whatever length fits", "How readily");
    await choose(shell, "always his call", "Chatty");
    await choose(shell, "whatever length fits", "Reply policy");
    await choose(shell, "while the wake trigger is the default", "An @mention or his name");
    await choose(shell, "whatever length fits", "Done");
    await choose(shell, "Invite Clankie to a server", "Done");
    await running;
  } finally {
    for (let attempt = 0; !finished && attempt < 10; attempt++) {
      shell.setupFlow.handleSubmit("/cancel");
      await new Promise((resolveTick) => setTimeout(resolveTick, 50));
    }
    await running;
  }
  const saved = await f.settings.load();
  expect(saved.discord.wakeTrigger).toBe("name");
  expect(saved.persona.chattiness).toBe("chatty");
  expect(saved.persona.replyPolicy).toBe("addressed");
  expect(
    f.requests.filter((request) => request.path === "/v1/operator/persona" && request.method === "POST"),
  ).toHaveLength(2);
  // The CLI saves the earlier spelling under its current name.
  expect((await f.cli("set", "--wake-trigger", "addressed")).discord.wakeTrigger).toBe("mention");
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

it("CLI owners and room skills round-trip through the revision-fenced API", async () => {
  const f = await fixture();
  await f.cli("setup", "connect", "--server", "Garden");
  await f.cli("owners", "--server", "10002", "--owners", "role", "--owner-role", "10003", "--role", "admin");
  expect((await f.settings.load()).discord.servers).toContainEqual({
    serverId: "10002",
    role: "admin",
    owners: "role",
    ownerRoleId: "10003",
  });
  await f.cli("room-skill", "--server", "10002", "--channel", "20011", "--skill", "house-hunting");
  expect((await f.settings.load()).discord.roomSkills).toEqual([
    { serverId: "10002", channelId: "20011", skill: "house-hunting" },
  ]);
  const before = (await f.api.discordSettings()).revision;
  await expect(f.cli("owners", "--server", "10002", "--owners", "role")).rejects.toThrow();
  await expect(
    f.cli("room-skill", "--server", "10002", "--channel", "20011", "--skill", "bash"),
  ).rejects.toThrow();
  await expect(f.cli("set", "--system-actor-guild-ids", "10002")).rejects.toThrow();
  expect((await f.api.discordSettings()).revision).toBe(before);
  await f.cli("room-skill", "--server", "10002", "--channel", "20011", "--skill", "off");
  expect((await f.settings.load()).discord.roomSkills).toEqual([]);
});

it("overlay readiness waits for real HTTP preparation, beyond the old helper deadline", async () => {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let first = true;
  const f = await fixture(async (path) => {
    if (first && path === "/v1/discord/settings") {
      first = false;
      entered();
      await held;
    }
  });
  const shell = f.shell();
  const running = submit(shell, "/discord");
  try {
    await ready;
    let observed = false;
    const waiting = prompt(shell, "Clankie connects").then((value) => {
      observed = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(observed).toBe(false);
    expect(shell.tui.getFocusedComponent() instanceof InteractiveSelectPrompt).toBe(false);
    release();
    expect(await waiting).toBeInstanceOf(InteractiveSelectPrompt);
    await choose(shell, "Invite Clankie to a server", "Done");
    await running;
  } finally {
    release();
    shell.setupFlow.handleSubmit("/cancel");
    await running;
  }
});
