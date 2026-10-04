import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import {
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceResultSchema,
  SUPERVISE_GRANTS,
  TAKE_CONTROL_GRANTS,
} from "@clankie/protocol";
import type {
  WorkItemWriteCommand,
  WorkItemWriteRequest,
  WorkItemWriteReceipt,
} from "@clankie/protocol/work-item-write";
import { writeConvention } from "@clankie/work-items";
import { expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain, type LaneTool } from "../src/captain/port.ts";
import { DeviceSessionSigner, mintDeviceSessionClaims } from "../src/device-session.ts";
import { createMcpHost, type McpHostOptions } from "../src/mcp-host.ts";
import { LinearWriteReceipts, linearWriteIssue } from "../src/linear-webhook.ts";
import { projectWorkRepoId } from "../src/project-work-items.ts";
import { createWorkItemsService } from "../src/work-items.ts";
import { WorkItemsResultSchema as frozenWorkItemsResult } from "../../../packages/protocol/test/fixtures/work-items-8d982a93.ts";
import { parseProtocolResponse as frozenReadResponse } from "../../../packages/protocol/test/fixtures/response-8d982a93.ts";

function pause() {
  let enter!: () => void, release!: () => void;
  return {
    entered: new Promise<void>((resolve) => {
      enter = resolve;
    }),
    finished: new Promise<void>((resolve) => {
      release = resolve;
    }),
    enter: () => enter(),
    release: () => release(),
  };
}
type Pause = ReturnType<typeof pause>;

/** A controlled broker wait still reads the actual temporary credential file. */
class PausableCredentials extends FileCredentialStore {
  public held: Pause | undefined;
  public override async get(provider: string) {
    const value = await super.get(provider);
    if (provider === "linear" && this.held) {
      const held = this.held;
      this.held = undefined;
      held.enter();
      await held.finished;
    }
    return value;
  }
}

async function listen(service: Awaited<ReturnType<typeof createClankieApp>>) {
  const requests = new Set<Promise<Response>>();
  let closed = false;
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const response = Promise.resolve(service.app.fetch(request));
      requests.add(response);
      void response.then(
        () => requests.delete(response),
        () => requests.delete(response),
      );
      return response;
    },
  }) as HttpServer;
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture HTTP server has no address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    dropConnections: () => server.closeAllConnections(),
    drain: () => Promise.allSettled(requests),
    async close() {
      if (closed) return;
      closed = true;
      service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "work-owner-integration-")));
  const settings = new SettingsStore(join(root, "settings.json"));
  const credentials = new PausableCredentials(join(root, "credentials.json"));
  const providerToken = randomUUID();
  const teamId = randomUUID(),
    alphaId = randomUUID(),
    betaId = randomUUID();
  const boardLabel = "App board";
  const labels = [...Array.from({ length: 21 }, (_, index) => `Role ${index}`), boardLabel];
  const description =
    "**Owner:** Previous\n\n**Depends on:** VUH-OLD\n\nKeep the original summary.\n\n![Fixture native media](https://uploads.linear.app/fixture/image.png)\n\n## Acceptance Criteria\n- [ ] Preserve review\n\n## Evidence\n- link: [Fixture proof](https://example.test/proof)\n\n## Notes\nKeep this human-authored section.\n";
  const issue = {
    id: "VUH-FIXTURE",
    uuid: randomUUID(),
    title: "Controlled owner-write issue",
    status: "Backlog",
    statusType: "backlog",
    description,
    labels: [...labels],
    parentId: "VUH-PARENT",
    teamId,
    projectId: alphaId,
    updatedAt: new Date().toISOString(),
    url: "https://linear.app/fixture/issue/VUH-FIXTURE",
  };
  const foreign = { ...issue, id: "VUH-FOREIGN", uuid: randomUUID(), projectId: betaId };
  const calls: { tool: string; arguments: Record<string, unknown> }[] = [];
  const effectPath = join(root, "provider-effects.jsonl");
  const linearReceiptPath = join(root, "state", "linear-writes.json");
  type ObservedCall = Parameters<NonNullable<McpHostOptions["observeCall"]>>[0];
  const observedWrites: { call: ObservedCall; issue: NonNullable<ReturnType<typeof linearWriteIssue>> }[] =
    [];
  const observerWarnings: unknown[] = [];
  let failObserverOnSave = false;
  const pauses: Pause[] = [];
  let nextCredentialWait: Pause | undefined;
  let saveWait: Pause | undefined;
  let expectedWrite: WorkItemWriteRequest | undefined;
  let failFollowupRead = false;
  let failNextRead = false;
  let loseSavedResponse = false;
  const tool = (name: string, call: LaneTool["call"]): LaneTool => ({
    name,
    description: `Controlled provider ${name}`,
    inputSchema: { type: "object", properties: {} },
    call: async (args) => {
      calls.push({ tool: name, arguments: args });
      return call(args);
    },
  });
  const content = (record: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(record) }],
  });
  const provider = await listen(
    await createClankieApp({
      captain: createStubCaptain({
        laneToolBank: async (lane) => ({
          lane,
          tools: [
            tool("get_team", async () => content({ id: teamId, name: "Fixture team" })),
            tool("get_project", async (args) => {
              if (nextCredentialWait) {
                credentials.held = nextCredentialWait;
                nextCredentialWait = undefined;
              }
              return content(
                args.query === "Beta"
                  ? { id: "P-VUH-18", uuid: betaId, name: "Beta" }
                  : { id: "P-VUH-17", uuid: alphaId, name: "Alpha" },
              );
            }),
            tool("get_issue", async (args) => {
              if (failNextRead) {
                failNextRead = false;
                return { ...content({ message: "Fixture followup unavailable" }), isError: true };
              }
              return args.id === foreign.id || args.id === foreign.uuid
                ? content(foreign)
                : args.id === issue.id || args.id === issue.uuid
                  ? content(issue)
                  : { ...content({ message: "Entity not found" }), isError: true };
            }),
            tool("list_issues", async (args) => {
              const candidate = args.project === "Beta" ? foreign : issue;
              const matches =
                args.label === undefined ||
                candidate.labels.some(
                  (name) => name.toLowerCase() === String(args.label).trim().toLowerCase(),
                );
              return content({ issues: matches ? [candidate] : [], hasNextPage: false });
            }),
            tool("save_issue", async (args) => {
              expect(args.id).toBe(issue.id);
              if (!expectedWrite) throw new Error("Provider write has no admitted test intent");
              const journal = JSON.parse(
                await readFile(join(root, "state", "work-write-receipts.json"), "utf8"),
              ) as unknown;
              expect(journal).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    id: expectedWrite.requestId,
                    state: "uncertain",
                    scope: expect.objectContaining({
                      owner: { kind: "device", id: "control" },
                      repoId: expectedWrite.repoId,
                      itemId: expectedWrite.itemId,
                    }),
                    result: expect.objectContaining({
                      requestId: expectedWrite.requestId,
                      outcome: "uncertain",
                    }),
                  }),
                ]),
              );
              if (typeof args.description === "string") issue.description = args.description;
              if (Array.isArray(args.patch)) {
                for (const operation of args.patch as {
                  op: string;
                  old_string?: string;
                  new_string?: string;
                  text?: string;
                }[]) {
                  if (operation.op === "append") issue.description += operation.text ?? "";
                  else {
                    expect(operation.op).toBe("replace");
                    expect(issue.description).toContain(operation.old_string);
                    issue.description = issue.description.replace(
                      operation.old_string!,
                      operation.new_string ?? "",
                    );
                  }
                }
              }
              if (Array.isArray(args.labels)) issue.labels = args.labels as string[];
              issue.updatedAt = new Date().toISOString();
              await appendFile(effectPath, `${JSON.stringify({ arguments: args, returned: issue })}\n`);
              if (failFollowupRead) {
                failFollowupRead = false;
                failNextRead = true;
              }
              if (loseSavedResponse) {
                loseSavedResponse = false;
                provider.dropConnections();
              }
              const held = saveWait;
              saveWait = undefined;
              if (held) {
                held.enter();
                await held.finished;
              }
              return content(issue);
            }),
          ],
        }),
      }),
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === `Bearer ${providerToken}`
          ? { operatorId: "fixture-provider" }
          : undefined,
    }),
  );
  const account = {
    provider: "linear" as const,
    actor: "app" as const,
    connectionId: randomUUID(),
    userId: randomUUID(),
    workspaceId: randomUUID(),
    name: "Fixture Clankie app",
    workspaceName: "Controlled workspace",
    verifiedAt: new Date().toISOString(),
  };
  await credentials.set("linear", { type: "api", key: providerToken, account });
  const paths = Object.fromEntries(["alpha", "beta"].map((id) => [id, join(root, id)]));
  for (const id of ["alpha", "beta"] as const) {
    await mkdir(paths[id]!, { recursive: true });
    await writeConvention(paths[id]!, {
      schemaVersion: 1,
      backend: "linear",
      linear: { team: "VUH", project: id === "alpha" ? "Alpha" : "Beta", label: boardLabel },
      decidedBy: "owner",
      decidedAt: new Date().toISOString(),
    });
  }
  await settings.update((current) => ({
    ...current,
    projects: {
      ...current.projects,
      projects: ["alpha", "beta"].map((id) => ({
        id,
        name: id,
        workspaces: [{ id: "repo", machineId: "local", platform: "posix" as const, path: paths[id]! }],
        worktreeRoots: [],
        trackerRef: { workspaceId: "repo", path: ".clankie/tracking.json" as const },
        roles: [],
        grants: [],
        labelRoleMap: [],
      })),
    },
  }));

  let now = Math.floor(Date.now() / 1000) * 1000;
  const key = randomBytes(32),
    signer = new DeviceSessionSigner(key);
  const eventPath = join(root, "events.jsonl");
  const devices = ["control", "other", "read"];
  const tokens = Object.fromEntries(
    devices.map((deviceId) => [
      deviceId,
      signer.issue(mintDeviceSessionClaims({ deviceId, nowEpochSeconds: now / 1000, ttlSeconds: 600 })),
    ]),
  );
  const events = devices.flatMap((deviceId) => {
    const grants = deviceId === "read" ? SUPERVISE_GRANTS : TAKE_CONTROL_GRANTS;
    const base = {
      occurredAt: new Date(now).toISOString(),
      missionId: `device:${deviceId}`,
      correlationId: "fixture",
      profileHash: "fixture",
    };
    return [
      {
        ...base,
        id: randomUUID(),
        type: "device.pairing.redeemed",
        data: {
          schemaVersion: 1,
          deviceId,
          offerId: deviceId,
          name: deviceId,
          platform: "ios",
          offeredGrants: grants,
          mintedBy: "local-operator",
          pendingExpiresAt: new Date(now + 600_000).toISOString(),
        },
      },
      {
        ...base,
        id: randomUUID(),
        type: "device.activated",
        data: { schemaVersion: 1, deviceId, grants, sessionExpiresAt: new Date(now + 600_000).toISOString() },
      },
    ];
  });
  await writeFile(eventPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  const hosts: ReturnType<typeof createMcpHost>[] = [];
  const endpoints: Awaited<ReturnType<typeof listen>>[] = [];
  let endpoint: Awaited<ReturnType<typeof listen>>;
  const boot = async () => {
    const linearWrites = new LinearWriteReceipts(linearReceiptPath);
    const host = createMcpHost({
      credentials,
      settings,
      curated: [
        {
          id: "linear",
          transport: "http",
          url: `${provider.url}/v1/mcp`,
          credential: "linear",
          lane: "operator",
          args: [],
          initialTools: ["get_team", "get_project", "get_issue", "list_issues", "save_issue"],
          enabled: true,
        },
      ],
      logger: { info() {}, warn: (context) => void observerWarnings.push(context) },
      observeCall: (call) => {
        const now = new Date();
        linearWrites.record(call, now);
        const writtenIssue = linearWriteIssue(call);
        if (writtenIssue) observedWrites.push({ call, issue: writtenIssue });
        if (call.tool === "save_issue" && failObserverOnSave) {
          failObserverOnSave = false;
          throw new Error("Fixture attribution observer failed after its durable write");
        }
      },
    });
    hosts.push(host);
    await host.warm();
    const workItems = createWorkItemsService({
      stateDirectory: join(root, "state"),
      workspace: () => paths.alpha,
      mcpHost: host,
      localMachineId: "local",
      projects: async () => (await settings.load()).projects,
      projectsFence: async () => {
        const snapshot = await settings.loadFenced();
        return { projects: snapshot.settings.projects, assertCurrent: snapshot.assertCurrent };
      },
    });
    endpoint = await listen(
      await createClankieApp({
        captain: createStubCaptain(),
        workItems,
        settings,
        eventLogPath: eventPath,
        deviceSessionKey: key,
        clock: () => new Date(now),
        authenticateOperator: async (request) =>
          request.headers.get("authorization") === "Bearer fixture-owner"
            ? { operatorId: "owner" }
            : undefined,
        authenticateCaptain: async (request) =>
          request.headers.get("authorization") === "Bearer fixture-captain"
            ? { captainId: "captain", steerSourceLane: "api" }
            : undefined,
      }),
    );
    endpoints.push(endpoint);
  };
  await boot();
  const raw = async (request: unknown, token = tokens.control!) => {
    const response = await fetch(`${endpoint.url}${OPERATOR_CONVERSATION_DISPATCH_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    return { status: response.status, body: (await response.json()) as unknown };
  };
  const receipt = async (request: unknown, token?: string): Promise<WorkItemWriteReceipt> => {
    const response = await raw(request, token);
    expect(response.status).toBe(200);
    const result = OperatorConversationServiceResultSchema.parse(response.body);
    if (result.op !== "work_item_write" && result.op !== "work_item_write_receipt")
      throw new Error(`Unexpected ${result.op}`);
    expect(result.outcome).toBe("accepted");
    return result.receipt;
  };
  return {
    root,
    issue,
    account,
    observedWrites,
    observerWarnings,
    reloadedLinearReceipts: () => new LinearWriteReceipts(linearReceiptPath),
    labels,
    description,
    calls,
    raw,
    settings,
    tokens,
    request: (
      command: WorkItemWriteCommand,
      extra: Partial<WorkItemWriteRequest> = {},
    ): WorkItemWriteRequest => ({
      repoId: projectWorkRepoId("alpha"),
      itemId: issue.id,
      requestId: randomUUID(),
      command,
      ...extra,
    }),
    write: (request: WorkItemWriteRequest, token?: string) => {
      expectedWrite = request;
      return receipt({ op: "work_item_write", schemaVersion: 1, request }, token);
    },
    read: (request: Pick<WorkItemWriteRequest, "repoId" | "itemId" | "requestId">, token?: string) =>
      receipt(
        {
          op: "work_item_write_receipt",
          schemaVersion: 1,
          repoId: request.repoId,
          itemId: request.itemId,
          requestId: request.requestId,
        },
        token,
      ),
    effects: async () => {
      try {
        return (await readFile(effectPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { arguments: Record<string, unknown> });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    },
    holdCredentialsAfterScope: () => {
      const held = pause();
      pauses.push(held);
      nextCredentialWait = held;
      return held;
    },
    holdSavedResponse: () => {
      const held = pause();
      pauses.push(held);
      saveWait = held;
      return held;
    },
    failFollowupRead: () => {
      failFollowupRead = true;
    },
    loseSavedResponse: () => {
      loseSavedResponse = true;
    },
    failObserverOnSave: () => {
      failObserverOnSave = true;
    },
    changeTrackerLabel: async () => {
      const path = join(paths.alpha!, ".clankie", "tracking.json");
      const convention = JSON.parse(await readFile(path, "utf8")) as { linear: { label: string } };
      convention.linear.label = "Changed board after admission";
      await writeFile(path, JSON.stringify(convention));
    },
    revoke: async () => {
      const response = await fetch(`${endpoint.url}/v1/devices/control/revoke`, {
        method: "POST",
        headers: { authorization: "Bearer fixture-owner" },
      });
      expect(response.status).toBe(200);
    },
    expire: () => {
      now += 601_000;
    },
    restart: async () => {
      await endpoint.close();
      await boot();
    },
    async close() {
      for (const held of pauses) held.release();
      await Promise.all(endpoints.map((instance) => instance.drain()));
      for (const host of hosts) await host.close();
      for (const instance of endpoints) await instance.close();
      await provider.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("applies device owner metadata and full native label sets, retaining one receipt per intent", async () => {
  const f = await fixture();
  try {
    const labelRequest = f.request({ action: "add_label", label: "Designer" });
    const duplicates = await Promise.all(Array.from({ length: 3 }, () => f.write(labelRequest)));
    for (const result of duplicates)
      expect(result).toMatchObject({
        requestId: labelRequest.requestId,
        outcome: "applied",
        item: { id: f.issue.id, parent: "VUH-PARENT" },
      });
    expect((await f.effects())[0]?.arguments).toEqual({ id: f.issue.id, labels: [...f.labels, "Designer"] });
    expect(f.observedWrites).toHaveLength(1);
    expect(f.observedWrites[0]).toMatchObject({
      issue: { organizationId: f.account.workspaceId, issueId: f.issue.uuid },
      call: { account: f.account, tool: "save_issue", arguments: { id: f.issue.id } },
    });
    expect(f.observedWrites[0]?.call.owner).toBeUndefined();
    expect(f.observedWrites[0]?.call.recipient).toBeUndefined();
    expect(f.observedWrites[0]?.call.worker).toBeUndefined();
    const revisions = f.reloadedLinearReceipts();
    const attribution = revisions.author(f.account.workspaceId, "Issue", f.issue.uuid, new Date());
    expect(attribution).toMatchObject({
      id: f.issue.uuid,
      organizationId: f.account.workspaceId,
      actorId: f.account.userId,
      connectionId: f.account.connectionId,
    });
    expect(attribution).not.toHaveProperty("owner");
    expect(attribution).not.toHaveProperty("recipient");
    expect(attribution).not.toHaveProperty("worker");
    expect(revisions.recipient(f.account.workspaceId, "Issue", f.issue.uuid, new Date())).toBeUndefined();
    const response = await f.raw(
      { op: "work_items", schemaVersion: 1, repoId: labelRequest.repoId, label: "ROLE 20" },
      "fixture-captain",
    );
    expect(response.status).toBe(200);
    const currentRead = OperatorConversationServiceResultSchema.parse(response.body);
    if (currentRead.op !== "work_items" || currentRead.result.outcome !== "ready")
      throw new Error("Work read failed");
    const wire = { repo: currentRead.result.repo, items: currentRead.result.items };
    expect(wire.items).toHaveLength(1);
    expect(wire.items[0]?.labels).not.toContain("Role 20");
    expect(f.calls.filter((call) => call.tool === "list_issues").at(-1)?.arguments.label).toBe("App board");
    expect(wire.items[0]?.parent).toBe("VUH-PARENT");
    expect(frozenWorkItemsResult.safeParse(wire).success).toBe(false);
    const oldRead = frozenReadResponse(frozenWorkItemsResult, wire);
    expect(oldRead.items[0]).toMatchObject({ id: f.issue.id, status: "todo" });
    expect(oldRead.items[0]).not.toHaveProperty("parent");
    expect(() =>
      frozenReadResponse(frozenWorkItemsResult, { ...wire, items: [{ ...wire.items[0], status: "future" }] }),
    ).toThrow();
    const before = f.calls.length;
    expect(await f.write(labelRequest)).toMatchObject({
      requestId: labelRequest.requestId,
      outcome: "applied",
    });
    expect(await f.read(labelRequest)).toMatchObject({
      requestId: labelRequest.requestId,
      outcome: "applied",
    });
    expect(f.calls).toHaveLength(before);
    expect(
      await f.write({ ...labelRequest, command: { action: "remove_label", label: "Designer" } }),
    ).toMatchObject({ requestId: labelRequest.requestId, outcome: "refused", message: expect.any(String) });
    expect(await f.effects()).toHaveLength(1);

    expect(await f.write(f.request({ action: "remove_label", label: "role 0" }))).toMatchObject({
      outcome: "applied",
    });
    expect(f.issue.labels).toEqual([...f.labels.slice(1), "Designer"]);
    expect(await f.write(f.request({ action: "assign", owner: "Kai" }))).toMatchObject({
      outcome: "applied",
      item: { owner: "Kai" },
    });
    expect(f.issue.description).toContain("**Owner:** Kai");
    const dependency = await f.write(f.request({ action: "add_dependency", id: "VUH-DEP" }));
    expect(dependency).toMatchObject({
      outcome: "applied",
      item: { owner: "Kai", dependsOn: ["VUH-OLD", "VUH-DEP"] },
    });
    const unassigned = await f.write(f.request({ action: "assign", owner: null }));
    expect(unassigned.outcome).toBe("applied");
    expect(unassigned.item).not.toHaveProperty("owner");
    expect(f.issue.description).not.toContain("**Owner:**");
    expect(f.issue.description).toContain("**Depends on:** VUH-OLD, VUH-DEP");
    expect(f.issue.description).toContain("## Acceptance Criteria\n- [ ] Preserve review");
    expect(f.issue.description).toContain("[Fixture proof](https://example.test/proof)");
    expect(f.issue.description).toContain(
      "![Fixture native media](https://uploads.linear.app/fixture/image.png)",
    );
    expect(f.issue.description).toContain("## Notes\nKeep this human-authored section.");
    expect(await f.effects()).toHaveLength(5);
    expect(
      f.calls
        .filter((call) => call.tool === "get_issue")
        .every((call) => Object.keys(call.arguments).join() === "id"),
    ).toBe(true);
    expect(
      (await f.effects()).every(
        (effect) =>
          !Object.hasOwn(effect.arguments, "assignee") && !Object.hasOwn(effect.arguments, "blocks"),
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

it("refuses captain and read-only writes, cross-project items, and receipt ID reuse outside its exact owner scope", async () => {
  const f = await fixture();
  try {
    const request = f.request({ action: "assign", owner: "Kai" });
    const body = { op: "work_item_write", schemaVersion: 1, request };
    expect(await f.write(request, f.tokens.read)).toMatchObject({
      requestId: request.requestId,
      outcome: "refused",
      message: expect.stringMatching(/owner|control/iu),
    });
    expect(await f.read(request, f.tokens.read)).toMatchObject({
      requestId: request.requestId,
      outcome: "refused",
      message: expect.stringMatching(/owner|control/iu),
    });
    expect(await f.write(request, "fixture-captain")).toMatchObject({
      outcome: "refused",
      message: expect.any(String),
    });
    expect(
      await f.write(f.request({ action: "assign", owner: "Kai" }, { itemId: "VUH-FOREIGN" })),
    ).toMatchObject({ outcome: "refused" });
    expect(
      await f.write(f.request({ action: "assign", owner: "Kai" }, { repoId: projectWorkRepoId("beta") })),
    ).toMatchObject({ outcome: "refused" });
    expect(await f.effects()).toHaveLength(0);
    expect(
      (await f.raw({ ...body, request: { ...request, principal: { kind: "operator", id: "owner" } } }))
        .status,
    ).toBe(400);
    expect((await f.raw({ ...body, request: { ...request, repoId: f.root } })).status).toBe(400);
    expect(await f.write(request)).toMatchObject({ outcome: "applied" });
    for (const [scope, token] of [
      [{ ...request, itemId: "VUH-FOREIGN" }, f.tokens.control],
      [{ ...request, repoId: projectWorkRepoId("beta") }, f.tokens.control],
      [request, f.tokens.other],
    ] as const) {
      const { command: _command, ...query } = scope;
      expect(await f.read(query, token)).toMatchObject({ requestId: request.requestId, outcome: "refused" });
      expect(await f.write(scope, token)).toMatchObject({ requestId: request.requestId, outcome: "refused" });
    }
    expect(await f.effects()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it.each(["revoke", "expire", "project", "tracker_label"] as const)(
  "does not dispatch after %s while the real credential read is waiting",
  async (change) => {
    const f = await fixture();
    try {
      const held = f.holdCredentialsAfterScope();
      const request = f.request({ action: "add_label", label: "Designer" });
      const pending = f.write(request);
      await held.entered;
      if (change === "revoke") await f.revoke();
      else if (change === "expire") f.expire();
      else if (change === "tracker_label") await f.changeTrackerLabel();
      else
        await f.settings.update((current) => ({
          ...current,
          projects: {
            ...current.projects,
            projects: current.projects.projects.map((project) =>
              project.id === "alpha" ? { ...project, name: "Changed after admission" } : project,
            ),
          },
        }));
      held.release();
      expect(await pending).toMatchObject({ requestId: request.requestId, outcome: "refused" });
      expect(await f.effects()).toHaveLength(0);
    } finally {
      await f.close();
    }
  },
);

it("keeps a settled device write applied after its attribution observer fails without replaying the intent", async () => {
  const f = await fixture();
  try {
    f.failObserverOnSave();
    const request = f.request({ action: "assign", owner: "Kai" });
    const receipt = await f.write(request);
    expect(receipt).toMatchObject({
      requestId: request.requestId,
      outcome: "applied",
      item: { owner: "Kai" },
    });
    expect(f.observerWarnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ event: "mcp.host.observer_failed" })]),
    );
    expect(f.observedWrites).toHaveLength(1);
    const before = f.calls.length;
    expect(await f.read(request)).toEqual(receipt);
    expect(await f.write(request)).toEqual(receipt);
    expect(f.calls).toHaveLength(before);
    expect(await f.effects()).toHaveLength(1);
    expect(f.issue.labels).toEqual(f.labels);
  } finally {
    await f.close();
  }
});

it("retains the intent ID through an actual reply loss and restart without dispatching pending work again", async () => {
  const f = await fixture();
  try {
    const held = f.holdSavedResponse();
    const request = f.request({ action: "add_label", label: "Designer" });
    const original = f.write(request).then(
      (receipt) => ({ receipt }),
      (error: unknown) => ({ error }),
    );
    await held.entered;
    expect(await f.effects()).toHaveLength(1);
    await f.restart();
    expect(await original).toHaveProperty("error");
    expect(await f.read(request)).toMatchObject({ requestId: request.requestId, outcome: "uncertain" });
    expect(await f.write(request)).toMatchObject({ requestId: request.requestId, outcome: "uncertain" });
    expect(await f.effects()).toHaveLength(1);
    held.release();
    const receipt = await f.read(request);
    expect(receipt.requestId).toBe(request.requestId);
    expect(["uncertain", "applied"]).toContain(receipt.outcome);
    expect(await f.effects()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

it("keeps a confirmed write applied when its followup read fails and preserves uncertainty after native reply loss", async () => {
  const f = await fixture();
  try {
    f.failFollowupRead();
    const confirmed = f.request({ action: "add_label", label: "Confirmed" });
    const result = await f.write(confirmed);
    expect(result).toMatchObject({ requestId: confirmed.requestId, outcome: "applied" });
    expect(result).not.toHaveProperty("item");
    expect(await f.read(confirmed)).toEqual(result);
    expect(await f.effects()).toHaveLength(1);

    f.loseSavedResponse();
    const lost = f.request({ action: "add_label", label: "Reply lost" });
    expect(await f.write(lost)).toMatchObject({ requestId: lost.requestId, outcome: "uncertain" });
    expect(f.issue.labels).toContain("Reply lost");
    expect(await f.read(lost)).toMatchObject({ requestId: lost.requestId, outcome: "uncertain" });
    expect(await f.write(lost)).toMatchObject({ requestId: lost.requestId, outcome: "uncertain" });
    expect(await f.effects()).toHaveLength(2);
  } finally {
    await f.close();
  }
});
