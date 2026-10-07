import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import {
  FileCredentialStore,
  LINEAR_API_PROVIDER_ID,
  LINEAR_PROVIDER_ID,
  type ProviderAccount,
} from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { createLocalTracker } from "@clankie/work-items";
import { createLinearApiTracker } from "../src/linear-api-tracker.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { LinearRequestBudget } from "../src/linear-request-budget.ts";
import {
  API_ACCESS,
  API_REFRESH,
  DOCUMENT_ID,
  ISSUE_ID,
  USER_ID,
  createLinearApiProvider,
} from "./fixtures/linear-api-provider.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const start = Date.parse("2026-10-07T06:00:00Z");
const account = (): ProviderAccount => ({
  provider: "linear",
  connectionId: randomUUID(),
  userId: USER_ID,
  workspaceId: "personal-workspace",
  actor: "app",
  name: "Clankie",
  workspaceName: "Personal",
  verifiedAt: new Date(start).toISOString(),
});
const DELETE = "mutation Remove($id: String!) { documentDelete(id: $id) { success } }";
const READ_DOCUMENT = "query Scratch($id: String!) { document(id: $id) { id title } }";

/** Real host, credential file, request budget and a schema-validating Linear HTTP provider. */
async function setup(
  options: {
    previousRequests?: number;
    credential?: "api" | "app" | "mcp-only";
    local?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "linear-graphql-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const clock = () => start;
  const provider = await createLinearApiProvider({
    requestBudget: {
      clock,
      limit: 5_000,
      previousRequests: Array.from({ length: options.previousRequests ?? 0 }, clock),
    },
  });
  cleanups.push(provider.close);
  const credentials = new FileCredentialStore(join(directory, "credentials.json"));
  const settings = new SettingsStore(join(directory, "settings.json"));
  const credential = options.credential ?? "api";
  if (!options.local) {
    if (credential === "api")
      await credentials.set(LINEAR_API_PROVIDER_ID, {
        type: "oauth",
        access: API_ACCESS,
        refresh: API_REFRESH,
        expires: 0,
        linearAuth: "api",
        account: account(),
      });
    else if (credential === "app")
      await credentials.set(LINEAR_PROVIDER_ID, {
        type: "oauth",
        access: API_ACCESS,
        refresh: "",
        expires: 0,
        linearAuth: "app",
        account: account(),
      });
    else
      await credentials.set(LINEAR_PROVIDER_ID, {
        type: "api",
        key: "mcp-audience-only",
        account: { ...account(), actor: "user" },
      });
  }
  const budget = new LinearRequestBudget({ clock });
  const logs: Record<string, unknown>[] = [];
  const host = createMcpHost({
    credentials,
    settings,
    // The GraphQL path must not depend on Linear's MCP transport being reachable.
    curated: [
      {
        id: "linear",
        transport: "http",
        url: "http://127.0.0.1:9/unreachable-mcp",
        args: [],
        lane: "everywhere",
        credential: "linear",
        initialTools: [],
        enabled: true,
      },
    ],
    ...(options.local
      ? { localTracker: createLocalTracker({ directory: join(directory, "tracker") }) }
      : {
          linearApiTracker: createLinearApiTracker({
            credentials,
            fetch: provider.fetch,
            requestBudget: budget,
          }),
        }),
    linearRequestBudget: budget,
    linearFetch: provider.fetch,
    logger: { info: (context) => logs.push(context), warn: () => {} },
  });
  cleanups.push(async () => {
    budget.close();
    await host.close();
  });
  const graphqlRequests = () => provider.seen.filter((entry) => entry.path === "/graphql");
  return { provider, host, credentials, logs, budget, graphqlRequests };
}

it("lists linear_graphql and runs queries from rooms, but mutations only from operator tools", async () => {
  const { host, provider, graphqlRequests } = await setup();
  expect((await host.catalog("operator")).map((tool) => tool.qualifiedName)).toContain("linear_graphql");
  expect((await host.catalog("discord_presence")).map((tool) => tool.qualifiedName)).toContain(
    "linear_graphql",
  );
  for (const lane of ["operator", "discord_presence"] as const) {
    const read = await host.call({
      lane,
      server: "linear",
      tool: "graphql",
      arguments: { query: READ_DOCUMENT, variables: { id: DOCUMENT_ID } },
    });
    expect(read).toMatchObject({ outcome: "ok", isError: false });
    if (read.outcome !== "ok") throw new Error(read.detail);
    expect(JSON.parse(read.content)).toMatchObject({ data: { document: { id: DOCUMENT_ID } } });
  }
  const sent = graphqlRequests().length;
  expect(
    await host.call({
      lane: "discord_presence",
      server: "linear",
      tool: "graphql",
      arguments: { query: DELETE, variables: { id: DOCUMENT_ID }, confirm: [DOCUMENT_ID] },
    }),
  ).toMatchObject({ outcome: "refused", reason: "lane_denied", possiblyDispatched: false });
  expect(graphqlRequests()).toHaveLength(sent);
  expect(provider.rows.documents).toHaveLength(1);
  // Requests run as the app credential; the secret never reaches the result.
  expect(graphqlRequests().every((entry) => entry.authorization === `Bearer ${API_ACCESS}`)).toBe(true);
  expect(provider.validationErrors).toEqual([]);
});

it("a destructive mutation needs confirm naming exactly its targets, then runs once and is logged", async () => {
  const { host, provider, logs, graphqlRequests } = await setup();
  const call = (args: Record<string, unknown>) =>
    host.call({ lane: "operator", server: "linear", tool: "graphql", arguments: args });
  for (const confirm of [undefined, [], ["00000000-0000-4000-8000-0000000000ff"], [DOCUMENT_ID, "extra"]])
    expect(
      await call({ query: DELETE, variables: { id: DOCUMENT_ID }, ...(confirm ? { confirm } : {}) }),
    ).toMatchObject({ outcome: "refused", reason: "confirmation_required", possiblyDispatched: false });
  // Literal ids, aliases, fragments and variable defaults are all classified.
  for (const query of [
    `mutation { gone: documentDelete(id: "${DOCUMENT_ID}") { success } }`,
    `mutation { ... on Mutation { documentDelete(id: "${DOCUMENT_ID}") { success } } }`,
    `mutation M($id: String! = "${DOCUMENT_ID}") { ...Remove } fragment Remove on Mutation { documentDelete(id: $id) { success } }`,
  ])
    expect(await call({ query })).toMatchObject({ outcome: "refused", reason: "confirmation_required" });
  expect(
    await call({ query: "mutation { organizationDeleteChallenge { success } }", confirm: ["anything"] }),
  ).toMatchObject({ outcome: "refused", reason: "invalid_arguments" });
  expect(await call({ query: "query A { viewer { id } } query B { viewer { id } }" })).toMatchObject({
    outcome: "refused",
    reason: "invalid_arguments",
  });
  expect(graphqlRequests()).toHaveLength(0);

  const removed = await call({ query: DELETE, variables: { id: DOCUMENT_ID }, confirm: [DOCUMENT_ID] });
  expect(removed).toMatchObject({ outcome: "ok", isError: false });
  if (removed.outcome !== "ok") throw new Error(removed.detail);
  expect(JSON.parse(removed.content)).toEqual({
    data: { documentDelete: expect.objectContaining({ success: true }) },
  });
  expect(provider.rows.documents).toEqual([]);
  expect(graphqlRequests()).toHaveLength(1);
  expect(logs).toContainEqual(
    expect.objectContaining({
      event: "mcp.host.linear_graphql.destructive",
      fields: ["documentDelete"],
      targets: [DOCUMENT_ID],
      lane: "operator",
    }),
  );
  expect(provider.validationErrors).toEqual([]);
});

it("a mutation retires cached tracker lists; a query does not", async () => {
  const { host, graphqlRequests } = await setup();
  const list = () =>
    host.call({ lane: "operator", server: "linear", tool: "list_issues", arguments: {}, resultMode: "data" });
  const issueReads = () => graphqlRequests().filter((entry) => entry.query?.includes("issues(")).length;
  await list();
  const first = issueReads();
  await host.call({
    lane: "operator",
    server: "linear",
    tool: "graphql",
    arguments: { query: "{ viewer { id } }" },
  });
  await list();
  expect(issueReads()).toBe(first);
  const saved = await host.call({
    lane: "operator",
    server: "linear",
    tool: "graphql",
    arguments: {
      query:
        'mutation Rename($id: String!) { issueUpdate(id: $id, input: { title: "Renamed" }) { success } }',
      variables: { id: ISSUE_ID },
    },
  });
  expect(saved).toMatchObject({ outcome: "ok", isError: false });
  await list();
  expect(issueReads()).toBe(first + 1);
});

it("refuses before dispatch at the hard request budget", async () => {
  const { host, graphqlRequests } = await setup({ previousRequests: 4_998 });
  // The first response's rate-limit headers reveal other clients' usage.
  expect(
    await host.call({
      lane: "operator",
      server: "linear",
      tool: "graphql",
      arguments: { query: "{ viewer { id } }" },
    }),
  ).toMatchObject({ outcome: "ok" });
  expect(
    await host.call({
      lane: "operator",
      server: "linear",
      tool: "graphql",
      arguments: { query: DELETE, variables: { id: DOCUMENT_ID }, confirm: [DOCUMENT_ID] },
    }),
  ).toMatchObject({ outcome: "refused", reason: "linear_request_budget", possiblyDispatched: false });
  expect(graphqlRequests()).toHaveLength(1);
});

it("an uncertain mutation is reported as possibly dispatched and never retried", async () => {
  const { host, provider, graphqlRequests } = await setup();
  provider.reject(true);
  const settled: unknown[] = [];
  const result = await host.call({
    lane: "operator",
    server: "linear",
    tool: "graphql",
    arguments: { query: DELETE, variables: { id: DOCUMENT_ID }, confirm: [DOCUMENT_ID] },
    onSettled: (value) => settled.push(value),
  });
  expect(result).toMatchObject({
    outcome: "refused",
    reason: "server_unavailable",
    possiblyDispatched: true,
  });
  if (result.outcome !== "refused") throw new Error("expected refusal");
  expect(result.detail).toMatch(/outcome unknown.*before any retry/u);
  expect(result.detail).not.toContain(API_ACCESS);
  expect(graphqlRequests()).toHaveLength(1);
  expect(settled).toEqual([]);
});

it("returns a schema rejection as a definite tool error with Linear's message", async () => {
  const { host } = await setup();
  const result = await host.call({
    lane: "operator",
    server: "linear",
    tool: "graphql",
    arguments: { query: "{ viewer { noSuchField } }" },
  });
  expect(result).toMatchObject({ outcome: "ok", isError: true });
  if (result.outcome !== "ok") throw new Error(result.detail);
  expect(result.content).toContain("noSuchField");
});

it("runs as a workspace app stored as linear, and fails loudly without a GraphQL app", async () => {
  const app = await setup({ credential: "app" });
  expect(
    await app.host.call({
      lane: "operator",
      server: "linear",
      tool: "graphql",
      arguments: { query: "{ viewer { id } }" },
    }),
  ).toMatchObject({ outcome: "ok", isError: false });

  const mcpOnly = await setup({ credential: "mcp-only" });
  const refused = await mcpOnly.host.call({
    lane: "operator",
    server: "linear",
    tool: "graphql",
    arguments: { query: "{ viewer { id } }" },
  });
  expect(refused).toMatchObject({
    outcome: "refused",
    reason: "server_unavailable",
    possiblyDispatched: false,
  });
  if (refused.outcome !== "refused") throw new Error("expected refusal");
  expect(refused.detail).toMatch(/needs the connected Linear API app/u);
  expect(mcpOnly.graphqlRequests()).toHaveLength(0);

  const local = await setup({ local: true });
  expect((await local.host.catalog("operator")).map((tool) => tool.qualifiedName)).toContain(
    "linear_graphql",
  );
  const offline = await local.host.call({
    lane: "operator",
    server: "linear",
    tool: "graphql",
    arguments: { query: "{ viewer { id } }" },
  });
  expect(offline).toMatchObject({ outcome: "refused", reason: "server_unavailable" });
  if (offline.outcome !== "refused") throw new Error("expected refusal");
  expect(offline.detail).toMatch(/requires connected Linear/u);
  expect(local.graphqlRequests()).toHaveLength(0);
});
