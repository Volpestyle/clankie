import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { createLocalTracker } from "@clankie/work-items";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";
import { createWorkItemsService } from "../src/work-items.ts";

/**
 * VUH-1916 at the tool boundary: a fleet worker's clankie_call and Clankie's own
 * operator-lane call reach the real built-in tracker through the real host.
 */
async function surface(root: string) {
  const settings = new SettingsStore(join(root, "settings.json"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  let workItems!: ReturnType<typeof createWorkItemsService>;
  const host = createMcpHost({
    credentials,
    settings,
    localTracker: createLocalTracker({ directory: join(root, "tracker") }),
    curated: [
      {
        id: "linear",
        credential: "linear",
        transport: "http",
        url: "http://127.0.0.1:1/mcp",
        args: [],
        lane: "everywhere",
        initialTools: [],
        enabled: true,
      },
    ],
    trackerForRepo: ({ name, args, repo, local, ...publication }) =>
      workItems.callTracker(name, args, { repo, local, ...publication }),
    trackerRepoForCall: (name, args) => workItems.resolveTrackerRepo(name, args),
    logger: { info() {}, warn() {} },
  });
  workItems = createWorkItemsService({
    stateDirectory: join(root, "work"),
    globalTrackerDirectory: join(root, "tracker"),
    workspace: () => repo,
    mcpHost: host,
  });
  const worker = new WorkerMcp({
    directory: join(root, "grants"),
    credentials,
    host,
    fleetTools: async () => (await settings.load()).fleet.tools,
    fleetToolsSnapshot: async () => {
      const snapshot = await settings.loadFenced();
      return { tools: snapshot.settings.fleet.tools, assertCurrent: snapshot.assertCurrent };
    },
  });
  const app = await createClankieApp({
    captain: createStubCaptain(),
    workerMcp: worker,
    workItems,
    fleetLinks: {
      identity: () => undefined,
      authenticate: (token) => (token === "local-fleet-test" ? "test-fleet" : undefined),
    },
  });
  let sequence = 0;
  let session: string | undefined;
  const rpc = (method: string, params: unknown) =>
    app.app.request("/v1/fleet/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer local-fleet-test",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    });
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "tracker-core-integration", version: "1" },
  });
  expect(initialized.status).toBe(200);
  session = initialized.headers.get("mcp-session-id")!;
  /** The worker's raw clankie_call reply: settled content, or a refusal with its detail. */
  async function raw(name: string, args: Record<string, unknown>) {
    const response = await rpc("tools/call", { name: "clankie_call", arguments: { name, arguments: args } });
    expect(response.status).toBe(200);
    const result = (await response.json()).result as { content: { text: string }[] };
    return JSON.parse(result.content[0]!.text) as {
      outcome: string;
      content?: string;
      isError?: boolean;
      detail?: string;
    };
  }
  async function call(name: string, args: Record<string, unknown>) {
    const reply = await raw(name, args);
    expect(reply, JSON.stringify(reply)).toMatchObject({ outcome: "ok", isError: false });
    return JSON.parse(reply.content!);
  }
  return {
    host,
    raw,
    call,
    close: async () => {
      app.close();
      await worker.close();
      await host.close();
    },
  };
}

it("records actors and chains, replays keyed writes, refuses stale updates and keeps an append-only audit log", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-tracker-core-"));
  const f = await surface(root);
  try {
    const workerActor = {
      type: "agent-worker",
      id: "fleet:test-fleet:pane:unverified",
      onBehalfOf: [
        { type: "human", id: "owner", name: "Owner" },
        { type: "agent-worker", id: "clankie", name: "Clankie" },
      ],
    };

    // Exactly-once: the same key and arguments return the original result and write once.
    const create = { team: "LOCAL", title: "Exactly once", idempotencyKey: "worker-create-0001" };
    const first = await f.call("linear_save_issue", create);
    const retried = await f.call("linear_save_issue", create);
    expect(retried).toEqual(first);
    const listed = await f.call("linear_list_issues", { team: "LOCAL" });
    expect(listed.issues.filter((issue: { title: string }) => issue.title === "Exactly once")).toHaveLength(
      1,
    );
    const applied = await f.call("linear_get_write_receipt", { idempotencyKey: "worker-create-0001" });
    expect(applied).toMatchObject({ state: "applied", tool: "save_issue" });
    expect(applied.result.id).toBe(first.id);

    // A reused key for a different change is refused, never applied as a second write.
    const conflict = await f.raw("linear_save_issue", { ...create, title: "Different" });
    expect(conflict.outcome).toBe("refused");
    expect(conflict.detail).toContain("idempotency_conflict");

    // Unknown: nothing was applied or refused under this key by this caller.
    expect(await f.call("linear_get_write_receipt", { idempotencyKey: "never-sent-0001" })).toEqual({
      idempotencyKey: "never-sent-0001",
      state: "unknown",
    });

    // Actor and chain come from the authenticated worker grant, not from arguments.
    const issue = await f.call("linear_get_issue", { id: first.id });
    expect(issue.createdByActor).toEqual(workerActor);
    expect(issue.updatedByActor).toEqual(workerActor);

    // Clankie's own operator-lane write: lead acting for the owner, with the turn's model.
    const lead = await f.host.call({
      lane: "operator",
      server: "linear",
      tool: "save_issue",
      arguments: { id: first.id, priority: 2, ifUpdatedAt: issue.updatedAt },
      model: "anthropic/claude-test",
      resultMode: "data",
    });
    expect(lead).toMatchObject({ outcome: "ok", isError: false });
    const afterLead = JSON.parse((lead as { content: string }).content);
    expect(afterLead.updatedByActor).toEqual({
      type: "agent-worker",
      id: "clankie",
      name: "Clankie",
      model: "anthropic/claude-test",
      onBehalfOf: [{ type: "human", id: "owner", name: "Owner" }],
    });
    expect(afterLead.createdByActor).toEqual(workerActor);
    expect(afterLead.updatedAt > issue.updatedAt).toBe(true);

    // Patch-safe: a stale updatedAt is refused and changes nothing; a keyed refusal replays.
    const stale = {
      id: first.id,
      title: "Lost update",
      ifUpdatedAt: issue.updatedAt,
      idempotencyKey: "worker-stale-0001",
    };
    const refused = await f.raw("linear_save_issue", stale);
    expect(refused.outcome).toBe("refused");
    expect(refused.detail).toContain("precondition_failed");
    expect((await f.call("linear_get_issue", { id: first.id })).title).toBe("Exactly once");
    expect(await f.call("linear_get_write_receipt", { idempotencyKey: "worker-stale-0001" })).toMatchObject({
      state: "refused",
      reason: "precondition_failed",
    });
    expect((await f.raw("linear_save_issue", stale)).detail).toContain("precondition_failed");
    const current = await f.call("linear_save_issue", {
      id: first.id,
      title: "Fresh update",
      ifUpdatedAt: afterLead.updatedAt,
    });
    expect(current.title).toBe("Fresh update");

    // Audit: every applied and refused write, newest first, each with its actor.
    const audit = await f.call("linear_list_audit_events", { entityId: first.id });
    expect(
      audit.events.map((event: { outcome: string; actor: { id: string } }) => [
        event.outcome,
        event.actor.id,
      ]),
    ).toEqual([
      ["applied", workerActor.id],
      ["refused", workerActor.id],
      ["applied", "clankie"],
      ["applied", workerActor.id],
    ]);
    expect(audit.events[1]).toMatchObject({ reason: "precondition_failed", target: first.id });
    expect(audit.events[2].fields).toEqual(["id", "ifUpdatedAt", "priority"]);

    // Append-only: later writes extend the log without changing earlier entries.
    const path = join(root, "tracker", "tracker.json");
    const before = JSON.parse(await readFile(path, "utf8")).audit;
    await f.call("linear_save_comment", { issueId: first.id, body: "Evidence ready" });
    const store = JSON.parse(await readFile(path, "utf8"));
    expect(store.audit.slice(0, before.length)).toEqual(before);
    expect(store.audit).toHaveLength(before.length + 1);
    expect(store.audit.at(-1).prevHash).toBe(before.at(-1).hash);

    // An edited entry breaks the chain: the tracker refuses to read or extend it.
    store.audit[0].actor = { ...store.audit[0].actor, id: "someone-else" };
    await writeFile(path, JSON.stringify(store));
    const tampered = await f.raw("linear_get_issue", { id: first.id });
    expect(tampered.outcome).toBe("refused");
    expect(tampered.detail).toContain("audit log is not intact");
  } finally {
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
});
