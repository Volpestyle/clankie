import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect } from "vitest";
import {
  FileCredentialStore,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
} from "@clankie/credential-broker";
import { SettingsStore, setProjectRole } from "@clankie/settings";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceRequestSchema,
  OperatorConversationServiceResultSchema,
  createOperatorConversationServiceClient,
  type HerdrBinding,
} from "@clankie/protocol";
import { FLEET_PROJECT_MEMBERSHIP_PATH, ProjectsSettingsSchema } from "@clankie/protocol/projects";
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

export async function personaProjectRoleFixture(mode: "hire" | "workspace" | "remote" | "free" = "hire") {
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
  const nativeHome = join(directory, "sessions", "2026", "10", "08");
  if (mode === "free") {
    await mkdir(nativeHome, { recursive: true });
    for (let index = 1; index <= 3; index++)
      await writeFile(
        join(nativeHome, `rollout-${index}.jsonl`),
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-10-08T12:00:00.000Z",
          payload: {
            id: `01a107e9-f3b1-7181-ad0e-744661b1896${index}`,
            timestamp: "2026-10-08T12:00:00.000Z",
            thread_source: "user",
          },
        }) + "\n",
      );
  }
  const panes = ["Pixel Smith", "Default Member", "Unconfirmed Worker"].map((name, index) => ({
    pane_id: `w1:p${index + 1}`,
    terminal_id: mode === "remote" && index === 0 ? "pc/term_1" : `term_${index + 1}`,
    name,
    agent: "codex",
    agent_status: "idle",
    terminal_title: name,
    cwd: directory,
    agent_session: {
      source: "herdr:codex",
      kind: mode === "free" ? ("path" as const) : ("id" as const),
      value: mode === "free" ? join(nativeHome, `rollout-${index + 1}.jsonl`) : `native-${index + 1}`,
    },
  }));
  const proofs: ProjectProcessProof[] = panes.map((pane, index) => ({
    fleet: mode === "remote" && index === 0 ? "pc" : "default",
    ...(mode === "remote" && index === 0
      ? { workspace: { machineId: "pc", platform: "windows" as const, canonicalPath: "C:\\Project" } }
      : {}),
    pane: pane.pane_id,
    nativeOccupantId: occupantIdForHerdrSession(pane.agent_session),
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
      ...(mode === "remote" && index === 0 ? { fleet: "pc" } : {}),
      role: "builder",
    });
    hires.launch(allocation.id, projects);
    // Remote allocations retain fleet-qualified addresses; the native census stays host-local.
    const pane = mode === "remote" && index === 0 ? `pc/${panes[index]!.pane_id}` : panes[index]!.pane_id;
    hires.pane(allocation.id, pane);
    hires.observe(
      allocation.id,
      mode === "remote" && index === 0 ? "term_1" : panes[index]!.terminal_id,
      proofs[index]!.nativeOccupantId,
      { ...proofs[index]!, pane },
    );
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
    memory: {
      writeMemory: unused,
      recallMemoryCard: unused,
      searchMemory: unused,
      editMemory: unused,
      forgetMemory: unused,
    },
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
  const membershipOptions = {
    settings: async () => (await settings.load()).projects,
    binding: async () => binding,
    hires: captain,
    roster: async () => parseHerdrAgentList(await native(["agent", "list"])),
    observe: async (pane: string) => {
      await onObserve?.();
      return structuredClone(proofs.find((proof) => proof.pane === pane));
    },
    ...(mode === "workspace"
      ? {
          workspace: async (proof: ProjectProcessProof) =>
            proof.pane === panes[2]!.pane_id ? "repo" : undefined,
        }
      : {}),
  };
  membership = new FleetProjectMembership({
    ...membershipOptions,
    ...(mode === "remote"
      ? {
          remoteOptions: async (fleet: string) =>
            fleet === "pc" ? { ...membershipOptions, fleet: "pc" } : undefined,
        }
      : {}),
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
  if (mode === "free")
    await client.create({
      scope: { kind: "persona", personaId: ids[0]! },
      title: "Original World recipient",
    });
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
            ...(mode === "remote" && index === 0 ? { fleet: "pc" } : {}),
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
    captain,
    fetchImpl,
    operatorToken,
    proofs,
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
