import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  FileCredentialStore,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
} from "@clankie/credential-broker";
import { SettingsStore, projectRoleForPersona, setProjectRole } from "@clankie/settings";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceRequestSchema,
  OperatorConversationServiceResultSchema,
  createOperatorConversationServiceClient,
  type HerdrBinding,
} from "@clankie/protocol";
import { FLEET_PROJECT_MEMBERSHIP_PATH, ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { runAgentsCommand } from "../../tui/src/command/agents.ts";
import { createBearerAuthenticator, createClankieApp } from "../src/app.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { ProjectHires } from "../src/captain/project-hires.ts";
import { occupantIdForHerdrSession, parseHerdrAgentList } from "../src/captain/herdr-census.ts";
import { FleetProjectMembership } from "../src/fleet-project-membership.ts";
import type { ProjectProcessProof } from "../src/project-process-proof.ts";

// Integration across real CLI/client schemas, HTTP authorization, captain,
// persona binding, confirmed hire ledger, membership producer and settings.
// Native OS/Herdr observations are fixtures; no agent or server is launched.
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "persona-project-role-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const settings = new SettingsStore(join(directory, "settings.json"));
  const projects = ProjectsSettingsSchema.parse({
    projects: [
      { id: "default", name: "Default" },
      { id: "repo", name: "Repository" },
    ],
  });
  await settings.update((current) => ({ ...current, projects }));
  const binding: HerdrBinding = {
    runtime: "external",
    socketPath: "/fixture/owned.sock",
    session: "original",
  };
  const panes = ["Pixel Smith", "Default Member", "Unconfirmed Worker"].map((name, index) => ({
    pane_id: `w1:p${index + 1}`,
    terminal_id: `term_${index + 1}`,
    name,
    agent: "codex",
    agent_status: "idle",
    terminal_title: name,
    cwd: directory,
    agent_session: { source: "herdr:codex", kind: "id", value: `native-${index + 1}` },
  }));
  const proofs: ProjectProcessProof[] = panes.map((pane, index) => ({
    fleet: "default",
    pane: pane.pane_id,
    nativeOccupantId: occupantIdForHerdrSession({ ...pane.agent_session, kind: "id" }),
    binding: { socketPath: binding.socketPath, session: binding.session },
    shell: { pid: 100 + index, startTime: "Sun Oct  4 10:00:00 2026" },
    processes: [{ pid: 200 + index, startTime: "Sun Oct  4 10:00:01 2026" }],
  }));
  const hires = new ProjectHires(join(directory, "herdr-watches.json.project-hires.json"));
  for (const index of [0, 1]) {
    const allocation = hires.reserve(projects, index === 0 ? "repo" : "default", {
      schemaVersion: 1,
      harness: "codex",
      title: panes[index]!.name,
      workingDirectory: join(directory, String(index)),
      role: "builder",
    });
    hires.launch(allocation.id, projects);
    hires.pane(allocation.id, panes[index]!.pane_id);
    hires.observe(allocation.id, panes[index]!.terminal_id, proofs[index]!.nativeOccupantId, proofs[index]);
    hires.confirmed(allocation.id);
  }
  const native = async (args: readonly string[]) => {
    if (args[0] === "agent" && args[1] === "list") return JSON.stringify({ result: { agents: panes } });
    if (args[0] === "agent" && args[1] === "get")
      return JSON.stringify({ result: { agent: panes.find((pane) => pane.pane_id === args[2]) } });
    if (args[0] === "pane" && args[1] === "list") return JSON.stringify({ result: { panes } });
    if (args[0] === "api" && args[1] === "snapshot") return JSON.stringify({ result: { panes: [] } });
    throw new Error("Unexpected native fixture operation");
  };
  let membership: FleetProjectMembership | undefined;
  const unused = (): never => {
    throw new Error("Unexpected captain dependency");
  };
  const deps: CaptainDeps = {
    mcp: { catalog: unused, call: unused },
    email: { list: unused, read: unused, search: unused, send: unused },
    browser: { catalog: unused, call: unused },
    media: { generateImage: unused, generateVideo: unused, finishedRenders: unused },
    embodiment: { submitIntent: unused, getSession: unused, getLiveSession: unused },
    activity: { current: unused },
    presence: { listSessions: unused, listVoiceHistory: unused, listRecentVoiceSpeech: unused },
    memory: { appendEpisode: unused, recallEpisodeCard: unused, searchEpisodeCard: unused },
  };
  const captain = createCaptain(deps, {
    repoRoot: directory,
    stateDir: directory,
    settings,
    nativeHerdrRunner: createHerdrWatchRunner(undefined, native),
    nativeCensusRunner: async (_command, args) => ({ stdout: await native(args), stderr: "" }),
    nativeSummariesPath: join(directory, "summaries.json"),
    fleetProjectMembership: () => membership,
  });
  cleanups.push(() => captain.close());
  let onObserve: (() => Promise<void>) | undefined;
  membership = new FleetProjectMembership({
    settings: async () => (await settings.load()).projects,
    binding: async () => binding,
    hires: captain,
    roster: async () => parseHerdrAgentList(await native(["agent", "list"])),
    observe: async (pane) => {
      await onObserve?.();
      return structuredClone(proofs.find((proof) => proof.pane === pane));
    },
  });
  let authenticated = true;
  const operatorToken = mintOperatorToken();
  const captainAuth = createBearerAuthenticator("captain", { captainId: "fixture-captain" });
  const service = await createClankieApp({
    captain,
    settings,
    fleetProjectMembership: membership,
    eventLogPath: join(directory, "events.jsonl"),
    deviceSessionKey: Buffer.alloc(32, 1),
    authenticateCaptain: (request) => (authenticated ? captainAuth(request) : Promise.resolve(undefined)),
    authenticateOperator: createBearerAuthenticator(operatorToken, { operatorId: "fixture-owner" }),
  });
  cleanups.push(() => service.close());
  const fetchImpl: typeof fetch = async (url, init) => service.app.fetch(new Request(url, init));
  const credentials = new FileCredentialStore(join(directory, "credentials.json"));
  await credentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: operatorToken });
  const catalog = join(directory, "models.json");
  await writeFile(catalog, JSON.stringify({ openai: { models: {} } }));
  const options = {
    env: {
      CLANKIE_CAPTAIN_TOKEN: "captain",
      CLANKIE_OPERATOR_TOKEN: operatorToken,
      CLANKIE_MODELS_PATH: catalog,
    },
    host: "http://fixture",
    fetchImpl,
    operatorCredentialStore: credentials,
  };
  const dispatch = async (input: unknown) => {
    const response = await fetchImpl(new URL(OPERATOR_CONVERSATION_DISPATCH_PATH, options.host), {
      method: "POST",
      headers: { authorization: "Bearer captain", "content-type": "application/json" },
      body: JSON.stringify(OperatorConversationServiceRequestSchema.parse(input)),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(result));
    return OperatorConversationServiceResultSchema.parse(result);
  };
  const client = createOperatorConversationServiceClient(dispatch);
  const fleet = await client.fleet!();
  const ids = panes.map((pane) => fleet.personas.find((persona) => persona.name === pane.name)!.personaId);
  await settings.update((current) => ({
    ...current,
    projects: ids
      .slice(0, 2)
      .reduce(
        (saved, id, index) => setProjectRole(saved, id, "builder", index === 0 ? "repo" : "default"),
        current.projects,
      ),
  }));
  const readMembership = async (index: number) => {
    const response = await fetchImpl(new URL(FLEET_PROJECT_MEMBERSHIP_PATH, options.host), {
      method: "POST",
      headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        seats: [
          {
            seatId: panes[index]!.terminal_id,
            occupantId: proofs[index]!.nativeOccupantId,
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  return {
    directory,
    settings,
    client,
    ids,
    options,
    readMembership,
    panes,
    onObserve: (callback: () => Promise<void>) => {
      onObserve = callback;
    },
    revoke: () => {
      authenticated = false;
    },
  };
}

it("writes and clears a nondefault member's role through the owner CLI and projects the current station", async () => {
  const f = await fixture();
  const ledger = await readFile(join(f.directory, "herdr-watches.json.project-hires.json"), "utf8");
  expect(
    await runAgentsCommand(["role", "Pixel", "Smith", "tester", "--project", "repo"], f.options),
  ).toMatchObject({ personaId: f.ids[0], role: "tester" });
  expect(projectRoleForPersona((await f.settings.load()).projects, f.ids[0]!, "repo")).toBe("tester");
  expect(projectRoleForPersona((await f.settings.load()).projects, f.ids[0]!)).toBeUndefined();
  expect(await f.readMembership(0)).toMatchObject({
    seats: [
      {
        membership: {
          outcome: "member",
          projectId: "repo",
          role: "tester",
        },
      },
    ],
  });
  await f.client.setPersonaRole!(f.ids[0]!, null, "repo");
  const cleared = await f.readMembership(0);
  expect(cleared.seats[0].membership).toEqual({ outcome: "member", source: "hire", projectId: "repo" });
  expect(await readFile(join(f.directory, "herdr-watches.json.project-hires.json"), "utf8")).toBe(ledger);
  const identities = JSON.parse(await readFile(join(f.directory, "personas.json"), "utf8"));
  expect(identities.personas.every((persona: Record<string, unknown>) => !("role" in persona))).toBe(true);
});

it("keeps old-client omission on a real default member and refuses foreign or unconfirmed members", async () => {
  const f = await fixture();
  expect(await f.client.setPersonaRole!(f.ids[1]!, "reviewer")).toMatchObject({
    personaId: f.ids[1],
    role: "reviewer",
  });
  expect(await f.readMembership(1)).toMatchObject({
    seats: [
      {
        membership: {
          outcome: "member",
          projectId: "default",
          role: "reviewer",
        },
      },
    ],
  });
  const before = await readFile(f.settings.path, "utf8");
  await expect(f.client.setPersonaRole!(f.ids[0]!, "designer")).rejects.toThrow(
    "not a confirmed current member",
  );
  await expect(f.client.setPersonaRole!(f.ids[1]!, "designer", "repo")).rejects.toThrow(
    "not a confirmed current member",
  );
  await expect(f.client.setPersonaRole!(f.ids[2]!, "designer", "repo")).rejects.toThrow(
    "not a confirmed current member",
  );
  expect(await readFile(f.settings.path, "utf8")).toBe(before);
});

it("refuses revocation during the native membership read before durable role intent", async () => {
  const f = await fixture();
  const before = await readFile(f.settings.path, "utf8");
  f.onObserve(async () => f.revoke());
  await expect(f.client.setPersonaRole!(f.ids[0]!, "tester", "repo")).rejects.toThrow(
    "captain_authentication_required",
  );
  expect(await readFile(f.settings.path, "utf8")).toBe(before);
  const journal = (await readdir(f.directory)).find((file) => file.endsWith(".pending.json"));
  expect(journal && (await readFile(join(f.directory, journal), "utf8"))).toBeUndefined();
});

it.each(["occupant", "project"] as const)(
  "refuses a %s change without recording a role intent",
  async (change) => {
    const f = await fixture();
    const before = await readFile(f.settings.path, "utf8");
    const assignments = (await f.settings.load()).projects.assignments;
    f.onObserve(async () => {
      if (change === "occupant") f.panes[0]!.agent_session.value = "replacement-native-session";
      else
        await f.settings.update((current) => ({
          ...current,
          projects: {
            ...current.projects,
            projects: current.projects.projects.map((project) => ({ ...project, name: "Owner edit" })),
          },
        }));
    });
    await expect(f.client.setPersonaRole!(f.ids[0]!, "tester", "repo")).rejects.toThrow(/member/);
    if (change === "occupant") expect(await readFile(f.settings.path, "utf8")).toBe(before);
    expect((await f.settings.load()).projects.assignments).toEqual(assignments);
    expect((await readdir(f.directory)).filter((file) => file.endsWith(".pending.json"))).toEqual([]);
  },
);

it("keeps one-positional role profile editing on the existing owner settings API", async () => {
  const f = await fixture();
  await runAgentsCommand(
    ["role", "builder", "--project", "repo", "--harness", "codex", "--effort", "medium"],
    f.options,
  );
  const projects = (await f.settings.load()).projects;
  expect(
    projects.projects.find((project) => project.id === "repo")!.roles.find((role) => role.role === "builder"),
  ).toMatchObject({ role: "builder", harness: "codex", effort: "medium" });
  expect(projectRoleForPersona(projects, f.ids[0]!, "repo")).toBe("builder");
  await expect(
    runAgentsCommand(
      ["role", "Pixel", "Smith", "tester", "--project", "repo", "--harness", "codex"],
      f.options,
    ),
  ).rejects.toThrow("Usage");
});
