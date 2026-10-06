import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { HerdrBinding } from "@clankie/protocol";
import type { FleetResourcePolicy } from "@clankie/fleet-resources";

export interface FleetLoadServiceConfig {
  sourceRoot: string;
  root: string;
  workspace: string;
  socket: string;
  herdr: string;
  provider: string;
  bearer: string;
  /** Explicit private registry for the separate manual resource burst only. */
  fleetResources?: { directory: string; policy: FleetResourcePolicy };
}

/** Target modules resolve their dependencies in sourceRoot's own real install. */
export async function startFleetLoadService(config: FleetLoadServiceConfig) {
  const load = (path: string) => import(pathToFileURL(join(config.sourceRoot, path)).href);
  const [
    appModule,
    captainModule,
    settingsModule,
    credentialsModule,
    mcpModule,
    workerModule,
    linkModule,
    proofModule,
    workModule,
    sessionsModule,
    memoryModule,
    captainMemoryModule,
    membershipModule,
    nativeModule,
  ] = await Promise.all([
    load("apps/clankie/src/app.ts") as Promise<typeof import("../src/app.ts")>,
    load("apps/clankie/src/captain/captain.ts") as Promise<typeof import("../src/captain/captain.ts")>,
    load("packages/settings/src/index.ts") as Promise<typeof import("@clankie/settings")>,
    load("packages/credential-broker/src/index.ts") as Promise<typeof import("@clankie/credential-broker")>,
    load("apps/clankie/src/mcp-host.ts") as Promise<typeof import("../src/mcp-host.ts")>,
    load("apps/clankie/src/worker-mcp.ts") as Promise<typeof import("../src/worker-mcp.ts")>,
    load("apps/clankie/src/local-fleet-link.ts") as Promise<typeof import("../src/local-fleet-link.ts")>,
    load("apps/clankie/src/local-fleet-proof.ts") as Promise<typeof import("../src/local-fleet-proof.ts")>,
    load("apps/clankie/src/work-items.ts") as Promise<typeof import("../src/work-items.ts")>,
    load("apps/clankie/src/agent-sessions.ts") as Promise<typeof import("../src/agent-sessions.ts")>,
    load("apps/clankie/src/memory.ts") as Promise<typeof import("../src/memory.ts")>,
    load("apps/clankie/src/captain-memory.ts") as Promise<typeof import("../src/captain-memory.ts")>,
    load("apps/clankie/src/fleet-project-membership.ts") as Promise<
      typeof import("../src/fleet-project-membership.ts")
    >,
    load("apps/clankie/src/fleet-project-membership-native.ts") as Promise<
      typeof import("../src/fleet-project-membership-native.ts")
    >,
  ]);
  const settings = new settingsModule.SettingsStore(join(config.root, "settings.json"));
  const fleetResources = config.fleetResources
    ? await (async () => {
        const [runtime, resources] = await Promise.all([
          load("apps/clankie/src/fleet-resource-runtime.ts") as Promise<
            typeof import("../src/fleet-resource-runtime.ts")
          >,
          load("packages/fleet-resources/src/index.ts") as Promise<typeof import("@clankie/fleet-resources")>,
        ]);
        const fixture = config.fleetResources!;
        return runtime.createFleetResourceRuntime({
          governor: resources.createResourceGovernor({ directory: fixture.directory }),
          policy: async () => fixture.policy,
        });
      })()
    : undefined;
  const binding = async (): Promise<HerdrBinding> => ({
    runtime: "external",
    session: "default",
    socketPath: config.socket,
  });
  const credentials = new credentialsModule.FileCredentialStore(join(config.root, "credentials.json"));
  await credentials.set("linear", {
    type: "api",
    key: "fixture-only",
    account: {
      provider: "linear",
      actor: "app",
      connectionId: randomUUID(),
      userId: randomUUID(),
      workspaceId: randomUUID(),
      name: "Fleet fixture",
      email: "fixture@oauthapp.linear.app",
      workspaceName: "Fixture",
      verifiedAt: new Date().toISOString(),
    },
  });
  const host = mcpModule.createMcpHost({
    credentials,
    settings,
    curated: [
      {
        id: "linear",
        credential: "linear",
        transport: "http",
        url: config.provider,
        lane: "operator",
        enabled: true,
        args: [],
        initialTools: [],
      },
    ],
    logger: {
      info() {},
      warn(context, message) {
        process.stderr.write(`${message} ${JSON.stringify(context)}\n`);
      },
    },
  });
  const workItems = workModule.createWorkItemsService({
    stateDirectory: join(config.root, "work"),
    workspace: () => config.workspace,
    mcpHost: host,
  });
  const agentSessions = sessionsModule.createAgentSessions(settings);
  const memory = memoryModule.createFileMemory({ dataDir: join(config.root, "memory") });
  const worker = new workerModule.WorkerMcp({
    directory: join(config.root, "grants"),
    credentials,
    host,
    projects: async () => (await settings.load()).projects,
    fleetTools: async () => (await settings.load()).fleet.tools,
    fleetToolsSnapshot: async () => {
      const snapshot = await settings.loadFenced();
      return { tools: snapshot.settings.fleet.tools, assertCurrent: snapshot.assertCurrent };
    },
  });
  let membership: InstanceType<typeof membershipModule.FleetProjectMembership> | undefined;
  // No substituted captain, census runner, admission proof or MCP connection.
  // Capabilities outside this fleet/read workload are absent in this embedding.
  const captain = captainModule.createCaptain(
    {
      herdrAvailable: () => true,
      mcp: host,
      workItems,
      agentSessions,
      memory: captainMemoryModule.createCaptainMemory(memory),
    } as unknown as CaptainDeps,
    {
      repoRoot: config.sourceRoot,
      stateDir: join(config.root, "captain"),
      workingDirectory: config.workspace,
      settings,
      fleetProjectMembership: () => membership,
      workerBridgeStatus: (fleet, pane) => worker.bridgeStatus(fleet, pane),
      fleetHireTools: () => worker.expectedFleetToolNames(),
      projectHireTools: (project) => worker.expectedProjectToolNames(project),
      ...(fleetResources ? { fleetResources } : {}),
    },
  );
  fleetResources?.start();
  membership = new membershipModule.FleetProjectMembership({
    settings: async () => (await settings.load()).projects,
    binding,
    ...nativeModule.fleetMembershipNative(binding),
    hires: captain,
  });
  let admissions = 0;
  const link = new linkModule.LocalFleetLink({
    directory: join(config.root, "state", "links"),
    binding,
    prove: proofModule.localFleetProof({ binding, herdrBinary: config.herdr }),
    projectProof: proofModule.localProjectProof({ binding, herdrBinary: config.herdr }),
  });
  const auth = (request: Request) => request.headers.get("authorization") === `Bearer ${config.bearer}`;
  const app = await appModule.createClankieApp({
    captain,
    settings,
    workerMcp: worker,
    workItems,
    agentSessions,
    localFleet: link,
    fleetProjectMembership: membership,
    eventLogPath: join(config.root, "events.jsonl"),
    herdrBinding: () => ({ runtime: "external", session: "default", socketPath: config.socket }),
    ...(fleetResources ? { fleetResources } : {}),
    authenticateCaptain: async (request) =>
      auth(request) ? { captainId: "fleet-load", steerSourceLane: "api" } : undefined,
    authenticateOperator: async (request) => (auth(request) ? { operatorId: "fleet-load" } : undefined),
  });
  const servers: Server[] = [];
  const listen = async (fetch: Parameters<typeof serve>[0]["fetch"]) => {
    const server = serve({ fetch, port: 0, hostname: "127.0.0.1" }) as Server;
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Service listener has no address");
    return address.port;
  };
  const port = await listen(app.app.fetch);
  const forward = link.fetch(app.app.fetch);
  const localPort = await listen(async (request, env) => {
    const response = await forward(request, env);
    if (response.status === 401 || response.status === 403) {
      admissions++;
      process.send?.({ kind: "admission", count: admissions });
    }
    return response;
  });
  await link.publish(localPort);
  await host.warm();
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let previousCpu = process.cpuUsage();
  let previousAt = performance.now();
  let measuring = false;
  const timer = setInterval(() => {
    const cpu = process.cpuUsage();
    const at = performance.now();
    if (measuring)
      process.send?.({
        kind: "sample",
        at: Date.now(),
        cpuPercent:
          ((cpu.user - previousCpu.user + cpu.system - previousCpu.system) / 1000 / (at - previousAt)) * 100,
        admissions,
        eventLoopP95Ms: delay.percentile(95) / 1e6,
      });
    previousCpu = cpu;
    previousAt = at;
    delay.reset();
  }, 1000);
  process.send?.({ kind: "ready", port, localPort, pid: process.pid });
  const close = async () => {
    clearInterval(timer);
    delay.disable();
    app.close();
    await captain.close();
    await fleetResources?.close();
    await worker.close();
    await host.close();
    await link.close();
    for (const server of servers) server.closeAllConnections();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  };
  process.on("message", (message) => {
    if (message === "measure") {
      measuring = true;
      previousCpu = process.cpuUsage();
      previousAt = performance.now();
      delay.reset();
    }
    if (message === "stop") void close().finally(() => process.exit());
  });
  process.once("disconnect", () => void close().finally(() => process.exit()));
}
