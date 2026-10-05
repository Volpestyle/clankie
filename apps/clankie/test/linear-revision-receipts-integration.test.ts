import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { ConversationJournal } from "../src/captain/conversation-journal.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { LinearWriteReceipts, type LinearActivityEvent } from "../src/linear-webhook.ts";
import { createMcpHost } from "../src/mcp-host.ts";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const SECRET = "fixture-only-linear-webhook-signing-secret";

async function listen(service: Awaited<ReturnType<typeof createClankieApp>>) {
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => service.app.fetch(request),
  }) as HttpServer;
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture HTTP server has no address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Native provider SDK transport and host observer; only the external provider's issue data is controlled. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "linear-revision-integration-"));
  const receiptPath = join(root, "linear-writes.json");
  const bearer = randomUUID();
  const account = {
    provider: "linear" as const,
    actor: "app" as const,
    connectionId: randomUUID(),
    userId: randomUUID(),
    workspaceId: randomUUID(),
    name: "Fixture Clankie app",
    email: "fixture@oauthapp.linear.app",
    workspaceName: "Controlled fixture workspace",
    verifiedAt: NOW.toISOString(),
  };
  let returned: Record<string, unknown> = {};
  const providerWrites: Record<string, unknown>[] = [];
  const provider = await listen(
    await createClankieApp({
      captain: createStubCaptain({
        laneToolBank: async (lane) => ({
          lane,
          tools: [
            {
              name: "save_issue",
              description: "Save the controlled issue and return its native record.",
              inputSchema: {
                type: "object",
                properties: { id: { type: "string" }, state: { type: "string" } },
                required: ["id"],
              },
              call: async (args) => {
                providerWrites.push(args);
                return { content: [{ type: "text", text: JSON.stringify(returned) }] };
              },
            },
          ],
        }),
      }),
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === `Bearer ${bearer}`
          ? { operatorId: "fixture-provider" }
          : undefined,
    }),
  );
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  await credentials.set("linear", { type: "api", key: bearer, account });
  const writes = new LinearWriteReceipts(receiptPath);
  const host = createMcpHost({
    credentials,
    settings: new SettingsStore(join(root, "settings.json")),
    curated: [
      {
        id: "linear",
        transport: "http",
        url: `${provider.url}/v1/mcp`,
        credential: "linear",
        lane: "operator",
        args: [],
        initialTools: ["save_issue"],
        enabled: true,
      },
    ],
    logger: { info() {}, warn() {} },
    observeCall: (call) => writes.record(call, NOW),
  });
  const store = new ConversationStore(join(root, "conversations"), async () => {});
  const admitted: LinearActivityEvent[] = [];
  const recorded: LinearActivityEvent[] = [];
  const hooks: Awaited<ReturnType<typeof listen>>[] = [];
  let delivery = 0;
  const revision = (id = randomUUID()) => ({
    id,
    title: "Controlled connected-provider issue",
    description: "Exact fixture revision; no real Linear issue is changed.",
    updatedAt: NOW.toISOString(),
  });
  return {
    account,
    revision,
    store,
    external: () =>
      new ConversationJournal(join(root, "conversations"))
        .read("global-default")
        .filter((event) => event.type === "message" && event.role === "external"),
    admitted,
    recorded,
    providerWrites,
    receipts: async () =>
      JSON.parse(await readFile(receiptPath, "utf8")) as { id: string; worker?: unknown }[],
    async write(record: Record<string, unknown>, worker = false) {
      returned = record;
      const delegation = worker
        ? {
            binding: (await host.account("linear", "operator")).binding,
            grantId: randomUUID(),
            principalId: "fixture-worker",
            workId: randomUUID(),
          }
        : undefined;
      expect(
        await host.call({
          lane: "operator",
          server: "linear",
          tool: "save_issue",
          arguments: { id: "VUH-FIXTURE", state: "Done" },
          ...(delegation ? { delegation } : {}),
        }),
      ).toMatchObject({ outcome: "ok", isError: false });
      return delegation;
    },
    async reloadHook() {
      // A fresh service receives only the journal reloaded from disk, never the writer's in-memory receipt.
      const reloaded = new LinearWriteReceipts(receiptPath);
      const hook = await listen(
        await createClankieApp({
          captain: createStubCaptain({
            receiveLinearActivity: (activity, following) => {
              admitted.push(activity);
              return store.receiveLinearActivity(activity, following);
            },
          }),
          linearWebhook: {
            secret: async () => SECRET,
            writes: reloaded,
            recordActivity: (activity) => {
              recorded.push(activity);
            },
          },
          clock: () => NOW,
        }),
      );
      hooks.push(hook);
      return async (data: Record<string, unknown>, overrides: Record<string, unknown> = {}) => {
        const body = JSON.stringify({
          action: "update",
          type: "Issue",
          webhookTimestamp: NOW.getTime(),
          createdAt: NOW.toISOString(),
          organizationId: account.workspaceId,
          actor: { id: account.userId, name: account.name, email: account.email },
          updatedFrom: { title: "Before this fixture revision" },
          data,
          ...overrides,
        });
        const response = await fetch(`${hook.url}/v1/hooks/linear`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "linear-event": "Issue",
            "linear-delivery": `fixture-${delivery++}`,
            "linear-signature": createHmac("sha256", SECRET).update(body).digest("hex"),
          },
          body,
        });
        expect(response.status).toBe(200);
        return response.json();
      };
    },
    async close() {
      await host.close();
      for (const hook of hooks) await hook.close();
      await provider.close();
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("correlates a native display-ID issue write after durable reload, while human activity stays in the ordinary chat and worker echoes stay quiet", async () => {
  const f = await fixture();
  try {
    const revision = f.revision();
    await f.write({ ...revision, id: "VUH-FIXTURE", uuid: revision.id });
    const post = await f.reloadHook();
    expect(await post(revision)).toMatchObject({ ingested: false });
    expect(f.admitted).toHaveLength(0);
    expect(f.recorded).toHaveLength(1);
    expect(f.external()).toHaveLength(0);
    expect(await f.receipts()).toEqual([expect.objectContaining({ id: revision.id })]);
    expect(f.providerWrites).toEqual([{ id: "VUH-FIXTURE", state: "Done" }]);

    const visible = [
      [revision, { actor: { id: randomUUID(), name: f.account.name, email: f.account.email } }],
      [revision, { organizationId: randomUUID() }],
      [{ ...revision, updatedAt: new Date(NOW.getTime() + 1).toISOString() }, {}],
      [{ ...revision, description: "A human correction in the same millisecond" }, {}],
    ] as const;
    for (const [data, envelope] of visible)
      expect(await post(data, envelope)).toMatchObject({ ingested: true });
    expect(f.external()).toHaveLength(visible.length);

    const workerRevision = f.revision();
    const worker = await f.write({ ...workerRevision, id: "VUH-FIXTURE", uuid: workerRevision.id }, true);
    expect(await (await f.reloadHook())(workerRevision)).toMatchObject({ ingested: false });
    expect(f.recorded.at(-1)?.worker).toEqual({
      grantId: worker!.grantId,
      principalId: worker!.principalId,
      workId: worker!.workId,
    });
    expect(f.external()).toHaveLength(visible.length);
  } finally {
    await f.close();
  }
});

it("retains UUID-id compatibility without hiding activity from ambiguous native issue identities", async () => {
  const f = await fixture();
  try {
    const legacy = f.revision();
    await f.write(legacy);
    expect(await (await f.reloadHook())(legacy)).toMatchObject({ ingested: false });
    expect(f.admitted).toHaveLength(0);
    expect(f.recorded).toHaveLength(1);
    expect(f.external()).toHaveLength(0);
    expect(await f.receipts()).toEqual([expect.objectContaining({ id: legacy.id })]);
    const missing = f.revision();
    const invalid = f.revision();
    const conflict = f.revision();
    const otherId = randomUUID();
    const cases = [
      [{ ...missing, id: "VUH-FIXTURE" }, [missing]],
      [{ ...invalid, id: "VUH-FIXTURE", uuid: "not-a-resource-uuid" }, [invalid]],
      [{ ...conflict, uuid: otherId }, [conflict, { ...conflict, id: otherId }]],
    ] as const;
    for (const [returned, activities] of cases) {
      await f.write(returned);
      const post = await f.reloadHook();
      for (const activity of activities) expect(await post(activity)).toMatchObject({ ingested: true });
    }
    expect(f.admitted).toHaveLength(4);
    expect(f.external()).toHaveLength(4);
  } finally {
    await f.close();
  }
});
