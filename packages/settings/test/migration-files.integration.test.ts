import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptySettings, SettingsStore } from "../src/index.ts";

const guild = "123456789012345678";
const otherGuild = "234567890123456789";
const remote = {
  id: "fixture",
  session: "work",
  ssh: { host: "fixture.invalid", shell: "posix" },
};

// #337: saved bytes are the input, not a pre-normalized schema object. Each
// kept reader must also survive an ordinary save and a fresh process/store read.
const cases = [
  {
    id: "S1/S7 retired keys leave explicit access and current controls intact",
    raw: {
      schemaVersion: 1,
      linear: { defaultTeamId: "retired" },
      swarm: { enabled: true },
      skills: { opinionated: false },
      execution: {
        workerMode: "retired",
        workerHarness: "retired",
        budget: -1,
        relay: { old: true },
        connections: [
          { ...remote, workerMode: "retired", workerHarness: "retired", budget: -1, relay: { old: true } },
        ],
      },
      machineAccess: { fixture: "portal" },
      gameplay: { pokemonEmulatorEnabled: true, rivalsUrl: "retired", pokeagentMmoEnabled: false },
      discord: { possessorVoiceEnabled: true, officialBotEnabled: true },
      email: { provider: "clankie", fromAddress: "retired@example.invalid" },
      linearWebhook: { actorEmail: "retired@example.invalid" },
      fleet: { remoteGates: { retired: true }, tools: "off", peerMessages: "off" },
    },
    expected: {
      machineAccess: { fixture: "portal" },
      fleet: { tools: "off", peerMessages: "off" },
      gameplay: { pokeagentMmoEnabled: false },
    },
    absent: [
      "linear",
      "swarm",
      "skills",
      "execution.workerMode",
      "execution.workerHarness",
      "execution.budget",
      "execution.relay",
      "execution.connections.0.workerMode",
      "execution.connections.0.workerHarness",
      "execution.connections.0.budget",
      "execution.connections.0.relay",
      "discord.possessorVoiceEnabled",
      "discord.officialBotEnabled",
      "gameplay.pokemonEmulatorEnabled",
      "gameplay.rivalsUrl",
      "email.provider",
      "email.fromAddress",
      "linearWebhook.actorEmail",
      "fleet.remoteGates",
    ],
  },
  {
    id: "S1 an owner's IMAP address survives retiring the provider selector",
    raw: { schemaVersion: 1, email: { provider: "imap", fromAddress: "owner@example.invalid" } },
    expected: { email: { fromAddress: "owner@example.invalid" } },
    absent: ["email.provider"],
  },
  {
    id: "S5 old social server lists become participant ownership records",
    raw: { schemaVersion: 1, discord: { ingressGuildIds: [guild], systemActorGuildIds: [otherGuild] } },
    expected: {
      discord: {
        servers: [
          { serverId: guild, role: "participant", owners: "me" },
          { serverId: otherGuild, role: "participant", owners: "me" },
        ],
        systemActorGuildIds: [],
        systemActorChannelIds: [],
      },
    },
    absent: [],
  },
  {
    id: "S6 a saved flat server keeps its selected role and disabled fleet",
    raw: {
      schemaVersion: 1,
      discord: {
        servers: [],
        serverId: guild,
        role: "participant",
        fleetEnabled: false,
        trackingLevel: "off",
      },
    },
    expected: {
      discord: { guilds: { [guild]: { role: "participant", fleetEnabled: false, trackingLevel: "off" } } },
    },
    absent: [],
  },
  {
    id: "S8/S9 a saved linked machine without a ceiling receives only workers",
    raw: { schemaVersion: 1, execution: { connections: [remote] } },
    expected: {
      machines: [{ id: "fixture", ssh: "fixture.invalid", shell: "posix", aliases: [] }],
      machineAccess: { fixture: "workers" },
    },
    absent: [],
  },
  {
    id: "S11 a legacy gateway host ID is retained rather than replaced",
    raw: {
      schemaVersion: 1,
      publicGateway: { url: "https://gateway.example.invalid", hostId: "fixture_host_12345678" },
    },
    expected: { publicGateway: { url: "https://gateway.example.invalid", hostId: "fixture_host_12345678" } },
    absent: ["publicGateway.installationId"],
  },
  {
    id: "S12 saved retired pressure floors remain decodable",
    raw: {
      schemaVersion: 1,
      fleet: {
        resources: {
          maxLoadRatio: 2,
          minAvailableMemoryMb: 512,
          minFreeDiskGb: 3,
          warnFreeDiskGb: 4,
          warnFreeDiskPercent: 5,
        },
      },
    },
    expected: {
      fleet: {
        resources: {
          maxLoadRatio: 2,
          minAvailableMemoryMb: 512,
          minFreeDiskGb: 3,
          warnFreeDiskGb: 4,
          warnFreeDiskPercent: 5,
        },
      },
    },
    absent: [],
  },
  {
    id: "P12 explicit auto profile leaves remain inherited after a saved project loads",
    raw: {
      schemaVersion: 1,
      projects: {
        projects: [
          {
            id: "fixture",
            name: "Fixture",
            hiring: {
              worker: {
                harness: "auto",
                model: "auto",
                effort: "auto",
                account: "auto",
                subagents: { model: "auto", effort: "auto" },
              },
            },
          },
        ],
      },
    },
    expected: { projects: { projects: [{ id: "fixture", hiring: { worker: {} } }] } },
    absent: [
      "projects.projects.0.hiring.worker.harness",
      "projects.projects.0.hiring.worker.model",
      "projects.projects.0.hiring.worker.effort",
      "projects.projects.0.hiring.worker.account",
      "projects.projects.0.hiring.worker.subagents.model",
      "projects.projects.0.hiring.worker.subagents.effort",
    ],
  },
];

it.each(cases)("$id through real load, save and reopen", async ({ raw, expected, absent }) => {
  const root = await mkdtemp(join(tmpdir(), "migration-settings-"));
  const path = join(root, "settings.json");
  const bytes = `${JSON.stringify(raw)}\n`;
  try {
    await writeFile(path, bytes);
    const store = new SettingsStore(path);
    const loaded = await store.load();
    expect(loaded).toMatchObject(expected);
    for (const key of absent) expect(loaded).not.toHaveProperty(key);
    expect(await readFile(path, "utf8")).toBe(bytes);
    await store.update((current) => current);
    expect(await new SettingsStore(path).load()).toEqual(loaded);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    for (const key of absent) expect(persisted).not.toHaveProperty(key);
    expect(persisted.agentHosts).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("current settings preserve an explicit owner ceiling and a completed empty migration receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "migration-current-"));
  const path = join(root, "settings.json");
  try {
    const current = emptySettings();
    current.machineAccess = { fixture: "portal" };
    current.fleet.tools = "off";
    current.fleet.peerMessages = "off";
    const bytes = `${JSON.stringify(current)}\n`;
    await writeFile(path, bytes);
    const store = new SettingsStore(path);
    expect(await store.load()).toEqual(current);
    expect(await readFile(path, "utf8")).toBe(bytes);
    await store.update((s) => s);
    expect(await new SettingsStore(path).load()).toEqual(current);
    expect(current.retiredWorkingPreferences).toEqual({ schemaVersion: 1, fleet: {}, projects: {} });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
