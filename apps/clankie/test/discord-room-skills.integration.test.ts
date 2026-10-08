import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { DiscordSettingsSchema } from "@clankie/protocol";
import { SettingsStore, resolveDiscordSettings } from "@clankie/settings";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { planDiscordTurnSession } from "../src/captain/system-authority.ts";
import {
  discordAllowedToolNames,
  discordSessionTools,
  houseHuntingInstructions,
} from "../src/captain/room-skill-tools.ts";
import { CaptainResourceLoader } from "../src/captain/skill-catalog.ts";

const SERVER = "1052402897645752351",
  ROOM = "1551975693582336060",
  OWNER = "100000",
  OTHER = "200000";
const roots: string[] = [];
const sessions: Array<{ dispose(): void }> = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) session.dispose();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "discord-room-skills-"));
  roots.push(path);
  return path;
}

it("loads the recorded legacy household as a skill grant, retains owners, and persists the migration once", async () => {
  const store = new SettingsStore(join(await root(), "settings.json"));
  const legacy = {
    schemaVersion: 1,
    discord: {
      ownerUserId: OWNER,
      systemActorUserIds: [OWNER],
      ingressGuildIds: [SERVER],
      swarmGuildId: "866430493889134672",
      systemActorGuildIds: [SERVER],
      systemActorChannelIds: [ROOM],
    },
  };
  await writeFile(store.path, JSON.stringify(legacy));
  const discord = (await store.load()).discord;
  expect(discord.servers).toEqual([
    { serverId: SERVER, role: "participant", owners: "me" },
    { serverId: "866430493889134672", role: "admin", owners: "me" },
  ]);
  expect(discord.roomSkills).toEqual([
    { serverId: SERVER, channelId: ROOM, skill: "house-hunting", household: "existing" },
  ]);
  expect(discord.systemActorGuildIds).toEqual([]);
  const plan = planDiscordTurnSession({
    baseSessionKey: "room",
    durable: true,
    actorId: OTHER,
    guildId: SERVER,
    channelId: ROOM,
    transportKind: "bot",
    settings: discord,
  });
  expect(plan.systemTools).toBe(false);
  expect(
    planDiscordTurnSession({
      baseSessionKey: "room",
      durable: true,
      actorId: OWNER,
      guildId: SERVER,
      channelId: ROOM,
      transportKind: "bot",
      settings: discord,
    }).kind,
  ).toBe("system_turn");
  expect(
    resolveDiscordSettings(discord, {
      DISCORD_SYSTEM_ACTOR_GUILD_IDS: SERVER,
      DISCORD_SYSTEM_ACTOR_CHANNEL_IDS: ROOM,
    }).settings.roomSkills,
  ).toEqual(discord.roomSkills);
  await store.update((current) => current);
  expect((await store.load()).discord).toEqual(discord);
  expect(JSON.parse(await readFile(store.path, "utf8")).discord.roomSkills).toEqual(discord.roomSkills);
  await store.update((current) => ({ ...current, discord: { ...current.discord, roomSkills: [] } }));
  expect((await store.load()).discord.roomSkills).toEqual([]);
});

it("rejects invalid role ownership and unknown skills at the settings boundary", () => {
  expect(DiscordSettingsSchema.safeParse({ servers: [{ serverId: SERVER, owners: "role" }] }).success).toBe(
    false,
  );
  expect(
    DiscordSettingsSchema.safeParse({ roomSkills: [{ serverId: SERVER, channelId: ROOM, skill: "bash" }] })
      .success,
  ).toBe(false);
  expect(
    DiscordSettingsSchema.safeParse({ servers: [{ serverId: SERVER }, { serverId: SERVER }] }).success,
  ).toBe(false);
});

it("a mixed audience resource loader supplies no workspace instructions or owner skill catalog", async () => {
  const cwd = await root();
  await writeFile(join(cwd, "AGENTS.md"), "Private project and fleet instructions");
  const loader = new CaptainResourceLoader({
    cwd,
    repoRoot: cwd,
    home: cwd,
    agentDir: cwd,
    quieted: new Set(),
    privateContext: false,
    noExtensions: true,
    noSkills: true,
  });
  await loader.reload();
  expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
  expect(loader.getSkills().skills).toEqual([]);
});

// Manual integration uses the real installed skill and Python/SQLite, in an isolated household.
// CI without that owner-installed dependency does not pretend to run the household flow.
const installedSkill =
  process.env.HOUSE_HUNTING_TEST_SKILL_ROOT ?? join(homedir(), ".agents", "skills", "house-hunting");
if (process.env.HOUSE_HUNTING_TEST_SKILL_ROOT && !existsSync(join(installedSkill, "homes.py")))
  throw new Error("The explicitly selected house-hunting dependency is missing");
it.skipIf(!existsSync(join(installedSkill, "homes.py")))(
  "a non-owner can research and maintain the real household ledger without shell or fleet tools",
  async () => {
    const home = await root();
    const grant = { serverId: SERVER, channelId: ROOM, skill: "house-hunting" as const };
    let granted = true;
    const access = {
      privateContext: false,
      actorId: OTHER,
      skillGrant: grant,
      home,
      skillRoot: installedSkill,
      authorize: async () => granted,
    };
    const bank = discordSessionTools([], false, access);
    expect(bank.map((tool) => tool.name)).toEqual(["house_hunting"]);
    expect(
      bank.some((tool) => ["bash", "read", "write", "edit", "hire_agent", "herdr_watch"].includes(tool.name)),
    ).toBe(false);
    const loader = new CaptainResourceLoader({
      cwd: home,
      repoRoot: home,
      home,
      agentDir: home,
      privateContext: false,
      quieted: new Set(),
      noExtensions: true,
      noSkills: true,
    });
    await loader.reload();
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const { session } = await createAgentSession({
      cwd: home,
      agentDir: home,
      resourceLoader: loader,
      modelRuntime,
      settingsManager: SettingsManager.inMemory(),
      sessionManager: SessionManager.inMemory(home),
      customTools: bank,
      tools: discordAllowedToolNames(bank, loader),
    });
    sessions.push(session);
    session.setActiveToolsByName(["house_hunting", "bash", "read", "write", "edit", "hire_agent"]);
    expect(session.getCallableToolNames()).toEqual(["house_hunting"]);
    expect(session.getAllTools().map((tool) => tool.name)).toEqual(["house_hunting"]);
    const tool = session.getToolDefinition("house_hunting")!;
    expect(tool.parameters).toMatchObject({
      properties: { zpid: { type: "string", pattern: "^\\d{1,32}$" } },
    });
    const call = (input: unknown) =>
      tool.execute("integration", input as never, undefined, undefined, undefined as never);
    expect(await houseHuntingInstructions(access)).toContain("Use house_hunting");
    await call({
      operation: "criteria_update",
      expected: "",
      text: "Partner: a private fenced yard matters. Budget undecided.",
    });
    expect(JSON.stringify(await call({ operation: "criteria" }))).toContain("Budget undecided");
    const imported = await call({
      operation: "import",
      observations: [
        {
          address: "123 Example St, Wheaton, IL 60187",
          source_url: "https://example.com/listing/123",
          observed_at: "2026-10-07T12:00:00Z",
          facts: { price: 450000, yard: null },
        },
      ],
    });
    const result = JSON.parse(imported.content.find((part) => part.type === "text")!.text);
    const id = result.ids[0];
    await call({ operation: "feedback", id, decision: "reject", note: "Yard remains unverified" });
    expect(JSON.stringify(await call({ operation: "show", id }))).toContain(OTHER);
    expect(JSON.stringify(await call({ operation: "list" }))).not.toContain("123 Example");
    // Real legacy author data remains independent of the authenticated ID.
    await promisify(execFile)("python3", [
      join(installedSkill, "homes.py"),
      "--home",
      home,
      "feedback",
      id,
      "--by",
      "Legacy author",
      "--decision",
      "reject",
      "--note",
      "Existing rejection",
    ]);
    await call({
      operation: "feedback",
      id,
      decision: "reconsider",
      note: "Reopen only my ID-attributed decision",
    });
    expect(JSON.stringify(await call({ operation: "show", id }))).toContain("Legacy author");
    expect(JSON.stringify(await call({ operation: "list" }))).not.toContain("123 Example");
    await expect(call({ operation: "bash", command: "pwd" })).rejects.toThrow();
    await expect(call({ operation: "list", home: "/tmp/another-household" })).rejects.toThrow();
    await expect(call({ operation: "criteria_update", expected: "stale", text: "replace" })).rejects.toThrow(
      "household_criteria_changed",
    );
    granted = false;
    await expect(call({ operation: "criteria" })).rejects.toThrow("room_skill_grant_revoked");
  },
);
