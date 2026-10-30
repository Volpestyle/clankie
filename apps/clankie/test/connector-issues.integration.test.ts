import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { SettingsStore } from "@clankie/settings";
import { createFilesBackend, writeConvention } from "@clankie/work-items";
import type { TrackerPosting } from "@clankie/protocol/tracker-posting";
import type { WorkConvention } from "@clankie/protocol/work-items";
import { afterEach, expect, it } from "vitest";
import { ClankieGuide } from "../../relay/src/connector-guide.ts";
import { createConnectorMcpHandler, createLoopbackConnectorOperator } from "../../relay/src/connector-mcp.ts";
import { createCaptainConversationDispatch } from "../../relay/src/conversation-upstream.ts";
import { ControlPlaneDeviceAuthorizer } from "../../relay/src/device-auth.ts";
import { createOperatorConversationRelayHandler } from "../../relay/src/operator-conversations.ts";
import { runConnectorCommand } from "../../tui/src/command/connector.ts";
import { LeadStore } from "../src/captain/lead.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { createTrackerPosting, trackerPostingExecutor } from "../src/tracker-posting.ts";
import { createWorkItemsService, defaultRun, type WorkItemsService } from "../src/work-items.ts";
import { createQaService } from "./fixtures/qa-service.ts";

// A connected app reads the owner's projects and their issues (ADR 0301) and writes
// them (ADR 0305): the real work service over private issue files and a GitHub stand-in,
// the real posting check, the real service, relay and connector, signed in the way
// Claude signs in.

const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const decided = {
  schemaVersion: 1 as const,
  decidedBy: "owner" as const,
  decidedAt: "2026-10-30T00:00:00.000Z",
};
const git = (cwd: string, ...args: string[]) =>
  defaultRun("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], cwd);

/** A project's checkout, tracking its work as the convention says. */
async function projectRepo(root: string, name: string, convention: WorkConvention) {
  const path = join(root, name);
  await mkdir(path);
  await git(path, "init", "-q", "-b", "main");
  await writeFile(join(path, "README.md"), `${name}\n`);
  await writeConvention(path, convention);
  await git(path, "add", "-A");
  await git(path, "commit", "-q", "-m", "init");
  return path;
}

async function projectSettings(
  root: string,
  projects: readonly { id: string; name: string; path: string }[],
) {
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: project.path }],
        trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" },
      })),
    }),
  }));
  return settings;
}

async function repoIdOf(workItems: WorkItemsService, projectId: string): Promise<string> {
  const repos = await workItems.handle({ action: "repos" }, false);
  const bound = "repos" in repos ? repos.repos.find((repo) => repo.projectId === projectId) : undefined;
  if (bound === undefined) throw new Error(`The ${projectId} project has no repo`);
  return bound.id;
}

/** The real service, relay and connector, with Claude signed in the way it signs in. */
async function connectedApp(workItems: WorkItemsService) {
  const captainToken = randomBytes(24).toString("hex");
  const host = await createQaService({ captainToken, workItems });
  cleanups.push(() => host.close());
  const authorizeDevice = new ControlPlaneDeviceAuthorizer({ baseUrl: host.baseUrl });
  let relayUrl = "";
  const operator = createOperatorConversationRelayHandler({
    authorizeDevice,
    dispatch: createCaptainConversationDispatch({ baseUrl: host.baseUrl, bearerToken: captainToken }),
  });
  const connector = createConnectorMcpHandler({
    authorizeDevice,
    operator: createLoopbackConnectorOperator("http://placeholder.invalid", (input, init) =>
      fetch(new URL(new URL(String(input)).pathname, relayUrl), init),
    ),
    localAuthorizationServer: host.baseUrl,
    version: "test",
    guide: new ClankieGuide(resolve(import.meta.dirname, "../../..")),
  });
  const relay = createServer((request, response) => {
    void (async () => {
      if (await connector(request, response)) return;
      if (await operator(request, response)) return;
      response.statusCode = 404;
      response.end();
    })();
  });
  relay.listen(0, "127.0.0.1");
  await once(relay, "listening");
  cleanups.push(() => new Promise<void>((done) => relay.close(() => done())));
  relayUrl = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
  const accessToken = await signIn(host.baseUrl, host.operatorToken);
  const client = new Client({ name: "claude-e2e", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", relayUrl), {
      requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    }) as unknown as Transport,
  );
  cleanups.push(() => client.close());
  return {
    async call(name: string, args: Record<string, unknown> = {}) {
      const result = await client.callTool({ name, arguments: args });
      return { error: result.isError === true, text: (result.content as Array<{ text: string }>)[0]!.text };
    },
    /** A hand-built request to the relay, as the connector's own bearer. */
    dispatch: (body: unknown) =>
      fetch(new URL("/operator/v1/dispatch", relayUrl), {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}

it("lists the owner's projects and issues and reads one, and never names the owner's writes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "connector-issues-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const orchard = await projectRepo(root, "orchard", {
    ...decided,
    backend: "markdown",
    directory: ".clankie/work",
  });
  const settings = await projectSettings(root, [{ id: "orchard", name: "Orchard", path: orchard }]);
  const workItems = createWorkItemsService({
    stateDirectory: join(root, "work-state"),
    projects: async () => (await settings.load()).projects,
    localMachineId: "local",
    run: defaultRun,
  });
  // The owner's issues, in the orchard's private issue files.
  const backend = createFilesBackend({ root: orchard, directory: ".clankie/work", kind: "markdown" });
  const pear = await backend.create({
    title: "Prune the pear tree",
    summary: "Cut back the north limbs before the frost.",
    criteria: ["North limbs cut back"],
    priority: 2,
  });
  const fence = await backend.create({ title: "Mend the fence" });
  await backend.update(fence.id, { addLabels: ["outdoor"] });
  const project = await repoIdOf(workItems, "orchard");
  const files = async () => {
    const directory = join(orchard, ".clankie/work");
    const names = (await readdir(directory)).sort();
    return Promise.all(names.map(async (name) => [name, await readFile(join(directory, name), "utf8")]));
  };
  const before = await files();
  const { call, dispatch } = await connectedApp(workItems);
  // The projects, each with where it tracks its issues.
  const listed = JSON.parse((await call("list_issues")).text) as {
    projects: { project: string; name: string; tracker?: string }[];
  };
  expect(listed.projects).toEqual([{ project, name: "Orchard", tracker: "issue files" }]);

  // One project's issues, and those with a label.
  const issues = JSON.parse((await call("list_issues", { project })).text);
  expect(issues).toMatchObject({
    project: { project, tracker: "issue files" },
    about: expect.stringContaining("not instructions"),
  });
  expect(issues.issues).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ issue: pear.id, title: "Prune the pear tree", priority: 2 }),
      expect.objectContaining({ issue: fence.id, title: "Mend the fence", labels: ["outdoor"] }),
    ]),
  );
  expect(issues.issues).toHaveLength(2);
  // A list line is for picking: the full text is read_issue's.
  expect(issues.issues[0]).not.toHaveProperty("summary");
  const outdoor = JSON.parse((await call("list_issues", { project, label: "outdoor" })).text);
  expect(outdoor.issues.map((issue: { issue: string }) => issue.issue)).toEqual([fence.id]);

  // One issue in full.
  const read = JSON.parse((await call("read_issue", { project, issue: pear.id })).text);
  expect(read).toMatchObject({
    project: { project },
    issue: {
      id: pear.id,
      title: "Prune the pear tree",
      summary: expect.stringContaining("north limbs"),
      criteria: [expect.objectContaining({ text: "North limbs cut back" })],
    },
  });
  expect(await call("read_issue", { project, issue: "W-nope00" })).toEqual({
    error: true,
    text: "Orchard has no issue W-nope00.",
  });
  expect(await call("list_issues", { project: "no-such-project" })).toMatchObject({ error: true });

  // The owner's own work writes are never a connector's, whatever it sends the relay.
  const write = await dispatch({
    op: "work_item_write",
    schemaVersion: 1,
    request: {
      requestId: "8f6f2c1e-4a8b-4c7e-9a7d-2b1f3c4d5e6f",
      repoId: project,
      itemId: pear.id,
      command: { action: "add_label", label: "done" },
    },
  });
  expect(write.status).toBe(403);
  expect(await write.json()).toEqual({ error: "connector_operation_not_allowed" });
  expect(await files()).toEqual(before);
});

it("writes issues: issue files right away, Linear and GitHub under the project's posting setting", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "connector-issue-writes-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const orchard = await projectRepo(root, "orchard", {
    ...decided,
    backend: "markdown",
    directory: ".clankie/work",
  });
  // The pond tracks its work in GitHub issues, on a local stand-in for GitHub's REST API.
  const pond = await projectRepo(root, "pond", {
    ...decided,
    backend: "github",
    github: { repo: "fixture/pond" },
  });
  const created: { title: string; body?: string }[] = [];
  const issueJson = (number: number) =>
    JSON.stringify({
      id: 9000 + number,
      number,
      title: created[number - 1]!.title,
      body: created[number - 1]!.body ?? "",
      state: "open",
      labels: [],
      html_url: `https://github.com/fixture/pond/issues/${String(number)}`,
    });
  const github = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && path === "/repos/fixture/pond/issues") return void response.end("[]");
    const one = /^\/repos\/fixture\/pond\/issues\/(\d+)$/u.exec(path);
    if (request.method === "GET" && one !== null && created[Number(one[1]) - 1] !== undefined)
      return void response.end(issueJson(Number(one[1])));
    if (request.method === "POST" && path === "/repos/fixture/pond/issues") {
      const body = JSON.parse(text) as { title: string; body?: string };
      created.push(body);
      return void response.writeHead(201).end(issueJson(created.length));
    }
    response.writeHead(404).end("{}");
  });
  github.listen(0, "127.0.0.1");
  await once(github, "listening");
  cleanups.push(() => new Promise<void>((done) => github.close(() => done())));
  const settings = await projectSettings(root, [
    { id: "orchard", name: "Orchard", path: orchard },
    { id: "pond", name: "Pond", path: pond },
  ]);
  const setPosting = (posting: TrackerPosting) =>
    settings.update((current) => ({
      ...current,
      projects: {
        ...current.projects,
        projects: current.projects.projects.map((project) =>
          project.id === "pond" ? { ...project, trackerPosting: posting } : project,
        ),
      },
    }));

  // Who leads is the captain's real record; the owner's checks land in a real conversation store.
  const lead = new LeadStore(join(root, "lead.json"), join(root, "lead-held.json"));
  const store = new ConversationStore(join(root, "conversations"), async () => {});
  cleanups.push(() => store.close());
  const posting = createTrackerPosting({
    statePath: join(root, "posts.json"),
    settings,
    localMachineId: "local",
    leadConversation: async () => store.defaultGlobalConversationId(),
    requestOwnerAsk: (conversationId, draft, publicationId, options) =>
      store.requestSurfaceQuestion(conversationId, draft, {
        current: () => store.conversation(conversationId) !== undefined,
        publicationId,
        ...options,
      }),
    observeQuestionResolutions: (listener) => store.observeQuestionResolutions(listener),
    wakeConversation: async () => false,
    appsLead: async () => lead.status().lead === "apps",
  });
  cleanups.push(() => posting.close());
  const workItems = createWorkItemsService({
    stateDirectory: join(root, "work-state"),
    projects: async () => (await settings.load()).projects,
    localMachineId: "local",
    run: defaultRun,
    posting,
    githubToken: async () => "fixture-github-token",
    githubApiBase: `http://127.0.0.1:${String((github.address() as AddressInfo).port)}`,
  });
  posting.bind({
    execute: trackerPostingExecutor({
      mcpHost: {
        call: async () => {
          throw new Error("No Linear in this fixture");
        },
      },
      workItems,
    }),
    repoTarget: (ref) => workItems.postingTarget(ref),
  });
  posting.start();
  const orchardId = await repoIdOf(workItems, "orchard");
  const pondId = await repoIdOf(workItems, "pond");
  const { call, dispatch } = await connectedApp(workItems);
  const write = async (name: string, args: Record<string, unknown>) => {
    const result = await call(name, args);
    return result.error ? { refused: result.text } : (JSON.parse(result.text) as Record<string, unknown>);
  };

  // Private issue files are written right away, under any setting.
  const filed = await write("save_issue", {
    project: orchardId,
    title: "Graft the apple tree",
    description: "Use the cuttings from the old tree.",
    priority: 3,
  });
  expect(filed).toMatchObject({ outcome: "written", issue: expect.stringMatching(/^W-/u) });
  const graft = filed.issue as string;
  expect(await write("save_issue", { project: orchardId, issue: graft, status: "done" })).toMatchObject({
    outcome: "written",
    message: `Updated ${graft} in Orchard.`,
  });
  const read = JSON.parse((await call("read_issue", { project: orchardId, issue: graft })).text);
  expect(read.issue).toMatchObject({ title: "Graft the apple tree", status: "done", priority: 3 });
  const [file] = (await readdir(join(orchard, ".clankie/work"))).filter((name) => name.startsWith(graft));
  expect(await readFile(join(orchard, ".clankie/work", file!), "utf8")).toContain(
    "cuttings from the old tree",
  );
  expect(await write("comment_issue", { project: orchardId, issue: graft, body: "Done." })).toEqual({
    refused: expect.stringContaining("hold no comments"),
  });
  expect(await write("save_issue", { project: orchardId, issue: graft })).toEqual({
    refused: expect.stringContaining("Name something to change"),
  });

  // GitHub, on the default "Ask me": held for the owner's OK, nothing posted.
  const asked = await write("save_issue", { project: pondId, title: "Net the leaves" });
  expect(asked).toMatchObject({ outcome: "held", post: expect.any(String) });
  expect(created).toEqual([]);
  const waiting = await posting.serve({ action: "list", state: "waiting" }, "lead");
  expect(waiting).toMatchObject({
    posts: [{ id: asked.post, decider: "owner", asker: "Claude", tracker: "github", projectId: "pond" }],
  });

  // "Read only" refuses it.
  await setPosting("read_only");
  expect(await write("save_issue", { project: pondId, title: "Skim the pond" })).toEqual({
    refused: expect.stringContaining("read only"),
  });

  // "Clankie decides": while Clankie leads, he decides an app's write; once the owner hands
  // the lead to the apps, the app's write is the lead's own and goes.
  await setPosting("lead");
  expect(await write("save_issue", { project: pondId, title: "Feed the fish" })).toMatchObject({
    outcome: "held",
  });
  expect(created).toEqual([]);
  lead.set("apps");
  expect(await write("save_issue", { project: pondId, title: "Clear the pump" })).toMatchObject({
    outcome: "written",
  });
  expect(created.map((issue) => issue.title)).toEqual(["Clear the pump"]);

  // "Go ahead" lets it go whoever leads.
  lead.set("clankie");
  await setPosting("allow");
  expect(await write("save_issue", { project: pondId, title: "Fix the fountain" })).toMatchObject({
    outcome: "written",
  });
  expect(created.map((issue) => issue.title)).toEqual(["Clear the pump", "Fix the fountain"]);

  // The relay names the app itself; an app can't write as another one.
  const posed = await dispatch({
    op: "issue_write",
    schemaVersion: 1,
    repoId: pondId,
    write: { action: "create", title: "Drain the pond" },
    appDeviceId: "someone-else",
  });
  expect(posed.status).toBe(400);
  expect(await posed.json()).toEqual({ error: "issue_write_app_is_stamped" });
  expect(created).toHaveLength(2);
});

/** Claude registers, the owner approves the code at the Mac, and Claude trades it for a token. */
async function signIn(baseUrl: string, operatorToken: string): Promise<string> {
  const { client_id: clientId } = (await (
    await fetch(`${baseUrl}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Claude", redirect_uris: [CALLBACK] }),
    })
  ).json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const page = await (
    await fetch(
      `${baseUrl}/oauth/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: CALLBACK,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"),
        code_challenge_method: "S256",
        state: "s",
        scope: "agents offline_access",
      })}`,
    )
  ).text();
  const approved = await runConnectorCommand(["approve", /class="code">([A-Z0-9-]+)</u.exec(page)![1]!], {
    host: baseUrl,
    env: { ...process.env, CLANKIE_OPERATOR_TOKEN: operatorToken },
    stdout: { write: () => undefined },
    stderr: { write: () => undefined },
  });
  if (approved !== 0) throw new Error("The owner's approval failed");
  const decided = (await (
    await fetch(`${baseUrl}/oauth/authorize/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: /const id="([^"]+)"/u.exec(page)![1] }),
    })
  ).json()) as { redirect: string };
  const { access_token: accessToken } = (await (
    await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: CALLBACK,
        code: new URL(decided.redirect).searchParams.get("code")!,
        code_verifier: verifier,
      }).toString(),
    })
  ).json()) as { access_token: string };
  return accessToken;
}

it("lands a status in a Linear team's own state, and leaves account-only Linear projects read only", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "connector-issue-linear-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const meadow = await projectRepo(root, "meadow", {
    ...decided,
    backend: "linear",
    linear: { team: "MEA" },
  });
  const settings = await projectSettings(root, [{ id: "meadow", name: "Meadow", path: meadow }]);
  await settings.update((current) => ({
    ...current,
    projects: {
      ...current.projects,
      projects: current.projects.projects.map((project) => ({
        ...project,
        trackerPosting: "allow" as const,
      })),
    },
  }));
  // Linear, as the MCP host answers for the connected account: a team that names its own
  // states, and one project in the account that isn't one of the owner's.
  const saved: Record<string, unknown>[] = [];
  const answers: Record<string, (args: Record<string, unknown>) => unknown> = {
    list_projects: () => ({
      projects: [{ id: "4b0c3d1e-2f6a-4d8b-9c1e-5a7f3b2d6e90", name: "Lake", leadTeam: { id: "team-lake" } }],
      hasNextPage: false,
    }),
    get_team: (args) =>
      args.query === "MEA" ? { id: "7d2e9a41-5c3b-4f68-8e1a-2b9c6d4f0a17", key: "MEA" } : undefined,
    list_issue_statuses: (args) =>
      args.team === "MEA"
        ? [
            { id: "s1", name: "Someday", type: "backlog" },
            { id: "s2", name: "Ready", type: "unstarted" },
            { id: "s3", name: "Doing", type: "started" },
            { id: "s4", name: "Peer review", type: "started" },
            { id: "s5", name: "Complete", type: "completed" },
            { id: "s6", name: "Dropped", type: "canceled" },
          ]
        : [],
    save_issue: (args) => {
      saved.push(args);
      return { id: "issue-uuid", identifier: `MEA-${String(saved.length)}`, title: args.title };
    },
  };
  const workItems = createWorkItemsService({
    stateDirectory: join(root, "work-state"),
    projects: async () => (await settings.load()).projects,
    localMachineId: "local",
    run: defaultRun,
    mcpHost: {
      binding: async () => ({ binding: "linear-account" }),
      call: async (request: { server: string; tool: string; arguments?: Record<string, unknown> }) => {
        const answer = request.server === "linear" ? answers[request.tool] : undefined;
        if (answer === undefined) return { outcome: "ok", isError: true, content: `No ${request.tool} here` };
        return { outcome: "ok", isError: false, content: JSON.stringify(answer(request.arguments ?? {})) };
      },
    } as unknown as NonNullable<Parameters<typeof createWorkItemsService>[0]["mcpHost"]>,
    posting: createTrackerPosting({
      statePath: join(root, "posts.json"),
      settings,
      localMachineId: "local",
      leadConversation: async () => undefined,
      requestOwnerAsk: async () => {
        throw new Error("Nothing here asks the owner");
      },
      observeQuestionResolutions: () => () => {},
      wakeConversation: async () => false,
    }),
  });
  const { call } = await connectedApp(workItems);
  const meadowId = await repoIdOf(workItems, "meadow");
  const doing = JSON.parse(
    (await call("save_issue", { project: meadowId, title: "Mow the meadow", status: "in_progress" })).text,
  );
  expect(doing).toMatchObject({ outcome: "written", issue: "MEA-1" });
  const review = await call("save_issue", {
    project: meadowId,
    title: "Check the fence",
    status: "in_review",
  });
  expect(JSON.parse(review.text)).toMatchObject({ outcome: "written" });
  expect(saved.map((args) => [args.title, args.state, args.team])).toEqual([
    ["Mow the meadow", "Doing", "MEA"],
    ["Check the fence", "Peer review", "MEA"],
  ]);

  // The account's own Lake project lists and stays read only.
  const listed = JSON.parse((await call("list_issues", {})).text) as { projects: { project: string }[] };
  const lake = listed.projects.find((project) => project.project.startsWith("linear-"));
  expect(lake).toBeDefined();
  expect(await call("save_issue", { project: lake!.project, title: "Stock the lake" })).toEqual({
    error: true,
    text: expect.stringContaining("apps only read it"),
  });
  expect(saved).toHaveLength(2);
});
