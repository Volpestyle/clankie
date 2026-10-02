import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileCredentialStore, type ProviderCredential } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { createMcpHost } from "../src/mcp-host.ts";
import { createAccounts } from "../src/accounts.ts";
import { createAccountRoutes } from "../src/account-routes.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";
import { LinearWriteReceipts } from "../src/linear-webhook.ts";
import { publishLinearWorker } from "../src/linear-publishing.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const account = {
  provider: "linear" as const,
  actor: "app" as const,
  connectionId: "00000000-0000-4000-8000-000000000001",
  userId: "app-user",
  workspaceId: "workspace",
  name: "Clankie",
  email: "fixture@oauthapp.linear.app",
  workspaceName: "Personal",
  verifiedAt: "2026-10-02T05:00:00Z",
};
const credential: ProviderCredential = {
  type: "oauth",
  linearAuth: "app",
  access: "SECRET_app_token",
  refresh: "",
  expires: Date.now() + 86_400_000,
  clientId: "client",
  clientSecret: "SECRET_client",
  account,
};
const args = {
  personaId: "agent-azure",
  issueId: "VUH-1518",
  body: "Fixed it. Evidence: https://example.test/proof. Remaining: live check.",
};
const id = "00000000-0000-4000-8000-000000000002";
const now = new Date("2026-10-02T05:10:00Z");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "linear-publishing-"));
  roots.push(root);
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  await credentials.set("linear", credential);
  const upstream = {
    listTools: async () => [{ name: "get_issue", inputSchema: { type: "object" } }],
    callTool: vi.fn(async () => ({ content: "upstream", isError: false })),
    close: async () => undefined,
  };
  const writes = new LinearWriteReceipts(join(root, "receipts.json"));
  const linearFetch = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const kind = body.query.includes("commentCreate") ? "comment" : "issue";
    return Response.json({
      data: {
        [`${kind}Create`]: {
          success: true,
          [kind]: {
            id,
            body: args.body,
            title: "Result",
            url: "https://linear.app/test",
            updatedAt: now.toISOString(),
          },
        },
      },
    });
  });
  const author = vi.fn(async (personaId: string) =>
    personaId === args.personaId
      ? { name: "Azure", avatarUrl: "https://docs.clankie.bot/agents/clankie-azure-v1.png" }
      : undefined,
  );
  const host = createMcpHost({
    credentials,
    settings: new SettingsStore(join(root, "settings.json")),
    logger: { info() {}, warn() {} },
    connect: async () => upstream,
    linearAuthor: author,
    linearFetch,
    observeCall: (call) => writes.record(call, now),
  });
  return { root, credentials, host, upstream, writes, linearFetch, author };
}

describe("worker Linear publishing", () => {
  it("keeps a thread reply and an issue creation under their separate existing personas", async () => {
    const f = await fixture();
    const reply = { ...args, parentId: id };
    expect(
      await f.host.call({
        lane: "operator",
        server: "linear",
        tool: "create_worker_comment",
        arguments: reply,
      }),
    ).toMatchObject({ outcome: "ok", isError: false });
    f.author.mockResolvedValueOnce({
      name: "Amber",
      avatarUrl: "https://docs.clankie.bot/agents/clankie-amber-v1.png",
    });
    expect(
      await f.host.call({
        lane: "operator",
        server: "linear",
        tool: "create_worker_issue",
        arguments: {
          personaId: "agent-amber",
          teamId: id,
          title: "A worker result",
          description: "Evidence.",
        },
      }),
    ).toMatchObject({ outcome: "ok", isError: false });
    const requests = f.linearFetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(requests[0].variables.input).toMatchObject({ parentId: id, createAsUser: "Azure" });
    expect(requests[1].query).toContain("IssueCreateInput!");
    expect(requests[1].variables.input).toEqual({
      teamId: id,
      title: "A worker result",
      description: "Evidence.",
      createAsUser: "Amber",
      displayIconUrl: "https://docs.clankie.bot/agents/clankie-amber-v1.png",
    });
    expect(f.writes.author("workspace", "Issue", id, now)).toMatchObject({ personaId: "agent-amber" });
    await f.host.close();
  });

  it("posts through the app with the existing persona, retaining a durable reply target", async () => {
    const f = await fixture();
    expect((await f.host.catalog("operator")).map((tool) => tool.name)).toContain("create_worker_comment");
    const result = await f.host.call({
      lane: "operator",
      server: "linear",
      tool: "create_worker_comment",
      arguments: args,
    });
    expect(result).toMatchObject({ outcome: "ok", isError: false });
    const request = f.linearFetch.mock.calls[0]![1]!;
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer SECRET_app_token");
    expect(JSON.parse(String(request.body)).variables.input).toEqual({
      issueId: args.issueId,
      body: args.body,
      createAsUser: "Azure",
      displayIconUrl: "https://docs.clankie.bot/agents/clankie-azure-v1.png",
    });
    expect(f.upstream.callTool).not.toHaveBeenCalled();
    expect(
      new LinearWriteReceipts(join(f.root, "receipts.json")).author("workspace", "Comment", id, now),
    ).toMatchObject({ personaId: args.personaId, actorId: "app-user" });
    await f.host.close();
  });

  it("requires a grant to pin the worker persona, and rejects a changed account before writing", async () => {
    const f = await fixture();
    const worker = new WorkerMcp({
      directory: join(f.root, "grants"),
      credentials: f.credentials,
      host: f.host,
    });
    await expect(
      worker.issue({
        principalId: "worker-a",
        workId: "task-a",
        server: "linear",
        tools: [{ name: "create_worker_comment" }],
      }),
    ).rejects.toThrow("exact personaId");
    const issued = await worker.issue({
      principalId: "worker-a",
      workId: "task-a",
      server: "linear",
      tools: [
        { name: "create_worker_comment", arguments: { personaId: args.personaId, issueId: args.issueId } },
      ],
    });
    const delegation = {
      binding: issued.grant.profileHash,
      grantId: issued.grant.grantId,
      principalId: "worker-a",
      workId: "task-a",
    };
    await f.credentials.set("linear", {
      ...credential,
      account: { ...account, connectionId: "00000000-0000-4000-8000-000000000003" },
    });
    expect(
      await f.host.call({
        lane: "operator",
        server: "linear",
        tool: "create_worker_comment",
        arguments: args,
        delegation,
      }),
    ).toMatchObject({ outcome: "refused" });
    expect(f.linearFetch).not.toHaveBeenCalled();
    await f.host.close();
  });

  it("keeps ordinary MCP working for a user connection without offering app attribution", async () => {
    const f = await fixture();
    await f.credentials.set("linear", {
      type: "api",
      key: "personal",
      account: { ...account, actor: "user" },
    });
    expect((await f.host.catalog("operator")).map((tool) => tool.name)).toEqual(["get_issue"]);
    expect(
      await f.host.call({ lane: "operator", server: "linear", tool: "get_issue", arguments: {} }),
    ).toMatchObject({ outcome: "ok", content: "upstream" });
    expect(
      await f.host.call({
        lane: "operator",
        server: "linear",
        tool: "create_worker_comment",
        arguments: args,
      }),
    ).toMatchObject({ outcome: "refused" });
    expect(f.linearFetch).not.toHaveBeenCalled();
    await f.host.close();
  });

  it("rejects invented authors and author-field overrides without a provider write", async () => {
    const f = await fixture();
    for (const changed of [
      { ...args, personaId: "unknown" },
      { ...args, createAsUser: "James" },
    ]) {
      expect(
        await f.host.call({
          lane: "operator",
          server: "linear",
          tool: "create_worker_comment",
          arguments: changed,
        }),
      ).toMatchObject({ outcome: "refused" });
    }
    expect(f.linearFetch).not.toHaveBeenCalled();
    await f.host.close();
  });

  it("checks the selected connection again after resolving the author and never retries a mutation", async () => {
    const call = vi.fn<typeof fetch>(async () => Response.json({ errors: [{ message: "SECRET_echo" }] }));
    const input = {
      tool: "create_worker_comment",
      args,
      credential,
      author: async () => ({ name: "Azure", avatarUrl: "https://example.test/a.png" }),
      beforeWrite: async () => {
        throw new Error("account replaced");
      },
      fetch: call,
    };
    await expect(publishLinearWorker(input)).rejects.toThrow("account replaced");
    expect(call).not.toHaveBeenCalled();
    await expect(publishLinearWorker({ ...input, beforeWrite: async () => undefined })).rejects.toThrow(
      "not confirmed",
    );
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("authenticates app setup, hides credentials, and retains the previous connection on rejection", async () => {
    const f = await fixture();
    const fetchImpl: typeof fetch = async () => Response.json({ error: "SECRET_echo" }, { status: 400 });
    const accounts = createAccounts({
      store: f.credentials,
      apps: async () => ({ github: {}, linear: {} }),
      fetch: fetchImpl,
    });
    const denied = createAccountRoutes(accounts, async () => "forbidden");
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: "new-app", clientSecret: "SECRET_new" }),
    };
    expect((await denied.request("/v1/accounts/linear/app", request)).status).toBe(403);
    const allowed = createAccountRoutes(accounts, async () => true);
    const result = await allowed.request("/v1/accounts/linear/app", request);
    expect(await result.json()).toEqual({ ok: false, error: "provider_rejected" });
    expect(await f.credentials.get("linear")).toEqual(credential);
    expect(JSON.stringify(await accounts.list())).not.toContain("SECRET_");
    expect((await accounts.list()).connections.find((entry) => entry.provider === "linear")).toMatchObject({
      account: "Clankie",
      actor: "app",
      workspace: "Personal",
      manageUrl: "https://linear.app/settings/api",
    });
    await f.host.close();
  });
});
