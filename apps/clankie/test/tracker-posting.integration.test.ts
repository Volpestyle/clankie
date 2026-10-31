import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FileCredentialStore,
  LINEAR_API_PROVIDER_ID,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
} from "@clankie/credential-broker";
import {
  OperatorConversationServiceResultSchema,
  parseProtocolResponse,
  type ConversationQuestion,
  type FeedDropResult,
  type FeedPage,
  type OperatorConversationServiceRequest,
  type WorkItemWriteCommand,
} from "@clankie/protocol";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import {
  TrackerPostsResultSchema,
  type TrackerPost,
  type TrackerPosting,
} from "@clankie/protocol/tracker-posting";
import type { WorkConvention } from "@clankie/protocol/work-items";
import { SettingsStore } from "@clankie/settings";
import {
  createLocalTracker,
  readDrops,
  recordDropPosted,
  TRACKER_OWNER,
  writeConvention,
} from "@clankie/work-items";
import { createAccounts } from "../src/accounts.ts";
import { createClankieApp } from "../src/app.ts";
import { ConversationStore } from "../src/captain/conversations.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createLinearApiTracker } from "../src/linear-api-tracker.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { createTrackerPosting, trackerPostingExecutor } from "../src/tracker-posting.ts";
import { createWorkItemsService, defaultRun } from "../src/work-items.ts";
import { runProjectSettingsCommand } from "../../tui/src/command/project-settings.ts";
import { runWorkCommand } from "../../tui/src/command/work.ts";
import {
  API_ACCESS,
  API_REFRESH,
  createLinearApiProvider,
  COMMENT_ID,
  ISSUE_ID,
  PROJECT_ID,
  USER_ID,
} from "./fixtures/linear-api-provider.ts";

/**
 * "Posting to your tracker" (ADR 0302), through the real service over HTTP: the real MCP
 * host posting to Linear through the schema-validating Linear API provider, the real work
 * service and files backend, the real conversation store for the owner's feed checks and
 * the lead's wakes, the real settings store and the CLI over HTTP. The captain is the one
 * stand-in: its asks and wakes are the conversation store's own surfaces.
 */
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const OWNER = `clankie_op_${"f".repeat(43)}`;
const WORKER = "project:garden";
const decided = {
  decidedBy: "owner" as const,
  decidedAt: "2026-10-30T00:00:00.000Z",
  schemaVersion: 1 as const,
};
const git = (cwd: string, ...args: string[]) =>
  defaultRun("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], cwd);

async function repo(root: string, name: string, convention: WorkConvention) {
  const path = join(root, name);
  await mkdir(path);
  await git(path, "init", "-q", "-b", "main");
  await writeFile(join(path, "README.md"), `${name}\n`);
  await writeConvention(path, convention);
  await git(path, "add", "-A");
  await git(path, "commit", "-q", "-m", "init");
  return path;
}

async function fixture(
  seed: {
    posts?: readonly Record<string, unknown>[];
    meadow?: boolean | { project: string };
    /** Marking this many drops posted fails, as when Clankie stops between the post and its file. */
    failDropMarks?: number;
  } = {},
) {
  let failDropMarks = seed.failDropMarks ?? 0;
  const root = await realpath(await mkdtemp(join(tmpdir(), "tracker-posting-")));
  if (seed.posts !== undefined) {
    await mkdir(join(root, "state"), { recursive: true });
    await writeFile(join(root, "state", "posts.json"), JSON.stringify({ posts: seed.posts }));
  }
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  // Garden tracks its work in Linear (the provider's project); the orchard in private issue files.
  const garden = await repo(root, "garden", {
    ...decided,
    backend: "linear",
    linear: { team: "VUH", project: PROJECT_ID },
  });
  const orchard = await repo(root, "orchard", {
    ...decided,
    backend: "markdown",
    directory: ".clankie/work",
  });
  // The pond tracks its work in GitHub issues, on a local stand-in for GitHub's REST API.
  // When asked for, the meadow tracks its work across the garden's whole Linear team, or in
  // its own Linear project on that team.
  const meadow = seed.meadow
    ? await repo(root, "meadow", {
        ...decided,
        backend: "linear",
        linear: { team: "VUH", ...(seed.meadow === true ? {} : { project: seed.meadow.project }) },
      })
    : undefined;
  const pondConvention: WorkConvention = { ...decided, backend: "github", github: { repo: "fixture/pond" } };
  const pond = await repo(root, "pond", pondConvention);
  const github: { method: string; path: string; body: Record<string, unknown> }[] = [];
  let issue: Record<string, unknown> | undefined;
  const githubServer = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString();
    github.push({ method: request.method ?? "", path, body: text ? JSON.parse(text) : {} });
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && /^\/repos\/fixture\/[a-z]+\/issues$/u.test(path)) {
      response.end("[]");
      return;
    }
    if (request.method === "POST" && /^\/repos\/fixture\/[a-z]+\/issues$/u.test(path)) {
      const body = JSON.parse(text) as { title: string; body?: string };
      issue = {
        id: 9001,
        number: 7,
        title: body.title,
        body: body.body ?? "",
        state: "open",
        labels: [],
        html_url: `https://github.com${path.replace("/repos", "")}/7`,
      };
      response.writeHead(201).end(JSON.stringify(issue));
      return;
    }
    if (request.method === "GET" && issue !== undefined && path.endsWith("/issues/7")) {
      response.end(JSON.stringify(issue));
      return;
    }
    response.writeHead(404).end("{}");
  });
  await new Promise<void>((resolve) => githubServer.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => githubServer.close(() => resolve())));
  const githubAddress = githubServer.address();
  if (githubAddress === null || typeof githubAddress === "string") throw new Error("No GitHub port");

  // Clankie's connected Linear: the registered OAuth app against the schema-validating provider.
  const provider = await createLinearApiProvider();
  cleanups.push(provider.close);
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  await credentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: OWNER });
  const accounts = createAccounts({
    store: credentials,
    apps: async () => ({
      github: {},
      linear: {
        clientId: "registered-client",
        redirectUri: "https://gateway.test/account/connections/callback",
      },
    }),
    fetch: provider.fetch,
  });
  const start = await accounts.startLinear();
  if (!start.ok) throw new Error("Missing registered flow");
  if (!(await accounts.completeLinear(start.flowId, "good-code")).ok) throw new Error("Linear not connected");

  const turns: { conversationId: string; message: string }[] = [];
  const store = new ConversationStore(join(root, "conversations"), async (conversationId, message) => {
    turns.push({ conversationId, message });
  });
  cleanups.push(() => store.close());
  const main = store.defaultGlobalConversationId();
  const wake = async (owner: { conversationId: string }, text: string) => {
    if (!store.runsCaptainTurns(owner.conversationId)) return false;
    return store.submitInternal(owner.conversationId, text, "watch").status === "accepted";
  };

  const workspace = (path: string) => [{ id: "primary", machineId: "local", platform: "posix", path }];
  const trackerRef = { workspaceId: "primary", path: ".clankie/tracking.json" };
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        { id: "garden", name: "Garden", workspaces: workspace(garden), trackerRef },
        { id: "orchard", name: "Orchard", workspaces: workspace(orchard), trackerRef },
        { id: "pond", name: "Pond", workspaces: workspace(pond), trackerRef },
        ...(meadow === undefined
          ? []
          : [{ id: "meadow", name: "Meadow", workspaces: workspace(meadow), trackerRef }]),
      ],
    }),
  }));
  const setPosting = (projectId: string, posting: TrackerPosting | undefined) =>
    settings.update((current) => ({
      ...current,
      projects: {
        ...current.projects,
        projects: current.projects.projects.map((project) => {
          if (project.id !== projectId) return project;
          const { trackerPosting: _saved, ...rest } = project;
          return posting === undefined ? rest : { ...rest, trackerPosting: posting };
        }),
      },
    }));

  const postingOptions: Parameters<typeof createTrackerPosting>[0] = {
    statePath: join(root, "state", "posts.json"),
    settings,
    localMachineId: "local",
    workerProject: (principalId) => /^project:(.+)$/u.exec(principalId)?.[1],
    readLinear: async (tool, args) => {
      const result = await host.call({
        lane: "operator",
        server: "linear",
        tool,
        arguments: args,
        resultMode: "data",
      });
      if (result.outcome !== "ok" || result.isError) throw new Error("unreadable");
      return JSON.parse(result.content) as unknown;
    },
    leadConversation: async () => main,
    requestOwnerAsk: (conversationId, draft, publicationId, options) =>
      store.requestSurfaceQuestion(conversationId, draft, {
        current: () => store.conversation(conversationId) !== undefined,
        publicationId,
        ...options,
      }),
    observeQuestionResolutions: (listener) => store.observeQuestionResolutions(listener),
    wakeConversation: wake,
  };
  const posting = createTrackerPosting(postingOptions);
  cleanups.push(() => posting.close());
  const host = createMcpHost({
    credentials,
    settings,
    localTracker: createLocalTracker({ directory: join(root, "tracker") }),
    linearApiTracker: createLinearApiTracker({ credentials, fetch: provider.fetch }),
    linearFetch: provider.fetch,
    logger: { info: () => {}, warn: () => {} },
    trackerPosting: posting,
    trackerForRepo: ({ name, args, repo: ref, local, actor, beforeWrite, onDispatch, effectConfirmed }) =>
      workItems.callTracker(name, args, {
        repo: ref,
        local,
        actor,
        beforeWrite,
        onDispatch,
        effectConfirmed,
      }),
  });
  cleanups.push(() => host.close());
  const workItems = createWorkItemsService({
    stateDirectory: join(root, "work-state"),
    projects: async () => (await settings.load()).projects,
    projectsFence: async () => {
      const snapshot = await settings.loadFenced();
      return { projects: snapshot.settings.projects, assertCurrent: snapshot.assertCurrent };
    },
    localMachineId: "local",
    mcpHost: host,
    run: defaultRun,
    posting,
    githubToken: async () => "fixture-github-token",
    githubApiBase: `http://127.0.0.1:${String(githubAddress.port)}`,
  });
  posting.bind({
    execute: trackerPostingExecutor({ mcpHost: host, workItems }),
    repoTarget: (ref) => workItems.postingTarget(ref),
    afterPosted: async (drop, posted) => {
      if (failDropMarks > 0) {
        failDropMarks -= 1;
        throw new Error("stopped before the drop was marked");
      }
      await recordDropPosted(drop.root, drop.key, posted);
    },
  });
  posting.start();

  const service = await createClankieApp({
    settings,
    captain: createStubCaptain({
      serveOperatorConversation: (request, authority) =>
        store.serve(request as Parameters<typeof store.serve>[0], authority),
      wakeConversation: wake,
    }),
    workItems,
    trackerPosting: posting,
    builtInTracker: createLocalTracker({ directory: join(root, "built-in") }),
    clock: () => new Date(),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === `Bearer ${OWNER}` ? { operatorId: "owner" } : undefined,
  });
  cleanups.push(() => service.close());
  const request = (path: string, body: unknown) =>
    service.app.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const dispatch = async (body: OperatorConversationServiceRequest | Record<string, unknown>) => {
    const response = await request("/operator/v1/dispatch", body);
    expect(response.status).toBe(200);
    return parseProtocolResponse(OperatorConversationServiceResultSchema, await response.json());
  };
  const feed = async (): Promise<Extract<FeedPage, { outcome: "ready" }>> => {
    const result = await dispatch({ op: "feed_list", schemaVersion: 1 });
    if (result.op !== "feed_list") throw new Error("unexpected feed result");
    const page = result.result as FeedPage;
    if (page.outcome !== "ready") throw new Error(`feed not ready: ${page.outcome}`);
    return page;
  };
  const binding = (await host.account("linear", "operator")).binding;
  /** Clankie's own lead tool, as his operator seat calls it. */
  const lead = (tool: string, args: Record<string, unknown>) =>
    host.call({ lane: "operator", server: "linear", tool, arguments: args });
  /** A worker hired into the garden, calling through its delegated grant. */
  const worker = (tool: string, args: Record<string, unknown>) =>
    host.call({
      lane: "operator",
      server: "linear",
      tool,
      arguments: args,
      delegation: { binding, grantId: "grant-1", principalId: WORKER, workId: "work-1" },
    });
  const mutations = (name: string) =>
    provider.seen.filter((entry) => entry.query?.includes("mutation") && entry.query.includes(name)).length;
  const posts = async (body: Record<string, unknown>) => {
    const response = await request("/v1/work/posts", body);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const work = async (...args: string[]) =>
    runWorkCommand(args, {
      env: { CLANKIE_OPERATOR_TOKEN: OWNER, CLANKIE_CONTROL_PLANE_URL: "http://clankie.test" },
      cwd: garden,
      fetchImpl: async (input, init) => service.app.fetch(new Request(input, init)),
    });
  const settle = async (check: () => boolean) => {
    for (const deadline = Date.now() + 15_000; Date.now() < deadline && !check();)
      await new Promise((r) => setTimeout(r, 10));
    expect(check()).toBe(true);
  };
  const pendingAsk = async (): Promise<{ question: ConversationQuestion; revision: number }> => {
    const listed = await dispatch({ op: "input_list", schemaVersion: 1 });
    if (listed.op !== "input_list") throw new Error("unexpected list");
    const found = listed.result.questions.find((entry) => entry.question?.status === "pending");
    if (!found?.question || found.revision === undefined) throw new Error("no pending ask");
    return { question: found.question, revision: found.revision };
  };
  const answer = async (label: string) => {
    const { question, revision } = await pendingAsk();
    const option = question.options.find((entry) => entry.label === label)!;
    const result = await dispatch({
      op: "input_answer",
      schemaVersion: 1,
      conversationId: question.conversationId,
      requestId: question.requestId,
      incarnationId: question.incarnationId,
      expectedRevision: revision,
      answer: { kind: "choice", optionId: option.optionId },
    });
    expect(result).toMatchObject({ op: "input_answer", result: { status: "resolved" } });
    return question;
  };
  return {
    root,
    garden,
    orchard,
    accounts,
    postingOptions,
    pond,
    pondConvention,
    meadow,
    github,
    provider,
    credentials,
    settings,
    setPosting,
    posting,
    host,
    workItems,
    service,
    request,
    dispatch,
    feed,
    lead,
    worker,
    mutations,
    posts,
    work,
    settle,
    pendingAsk,
    answer,
    main,
    wakes: () => turns.map((turn) => turn.message),
  };
}

const comment = (body: string) => ({ issueId: ISSUE_ID, body });

it("go ahead posts Clankie's and a worker's writes to the project's Linear at once", async () => {
  const f = await fixture();
  await f.setPosting("garden", "allow");
  expect(await f.lead("save_comment", comment("Landed the gate fix."))).toMatchObject({
    outcome: "ok",
    isError: false,
  });
  expect(await f.worker("save_comment", comment("Checks pass."))).toMatchObject({
    outcome: "ok",
    isError: false,
  });
  expect(f.mutations("commentCreate")).toBe(2);
  expect(f.provider.validationErrors).toEqual([]);
  // Reads are never checked, whatever the setting.
  await f.setPosting("garden", "read_only");
  expect(await f.lead("get_issue", { id: ISSUE_ID })).toMatchObject({ outcome: "ok", isError: false });
});

it("read only refuses every write with words that keep the work local, and posts nothing", async () => {
  const f = await fixture();
  await f.setPosting("garden", "read_only");
  for (const call of [f.lead, f.worker]) {
    const refused = await call("save_comment", comment("Landed."));
    expect(refused).toMatchObject({
      outcome: "refused",
      reason: "posting_refused",
      possiblyDispatched: false,
    });
    if (refused.outcome !== "refused") throw new Error("expected a refusal");
    expect(refused.detail).toContain("Posting to Linear is read only for Garden, so nothing was posted.");
    expect(refused.detail).toContain(".clankie/work");
  }
  expect(await f.lead("save_issue", { title: "New idea", team: "VUH" })).toMatchObject({
    reason: "posting_refused",
  });
  expect(f.mutations("Create")).toBe(0);
  // `clankie work create` in the Linear repo is Clankie too: refused the same way, over HTTP.
  const cli = await f.work("create", "From the CLI");
  expect(cli.ok).toBe(false);
  expect(cli.body).toMatchObject({
    error: "posting_refused",
    detail: expect.stringContaining("Posting to Linear is read only for Garden"),
  });
  expect(f.mutations("Create")).toBe(0);
});

it("Clankie decides: his own writes post; a worker's waits for him and posts exactly once when he lets it through", async () => {
  const f = await fixture();
  await f.setPosting("garden", "lead");
  expect(await f.lead("save_comment", comment("Clankie's own note."))).toMatchObject({ outcome: "ok" });
  expect(f.mutations("commentCreate")).toBe(1);

  const held = await f.worker("save_comment", comment("Worker evidence: gate latches."));
  expect(held).toMatchObject({ outcome: "refused", reason: "posting_held", possiblyDispatched: false });
  if (held.outcome !== "refused") throw new Error("expected a hold");
  expect(held.detail).toContain("Clankie decides for this project, so it waits for him");
  const id = /post ([0-9a-f-]{36})/u.exec(held.detail)![1]!;
  // The same write again finds the same waiting post.
  const again = await f.worker("save_comment", comment("Worker evidence: gate latches."));
  expect(again.outcome === "refused" && again.detail).toContain(id);
  expect(f.mutations("commentCreate")).toBe(1);
  // The lead is woken with exactly what would go, and how to decide.
  await f.settle(() => f.wakes().some((text) => text.includes(id)));
  const wake = f.wakes().find((text) => text.includes(id))!;
  expect(wake).toContain("Worker evidence: gate latches.");
  expect(wake).toContain(`clankie work posts approve ${id}`);
  // It never shows in the owner's feed: this one is Clankie's call.
  expect((await f.feed()).items.filter((item) => item.kind === "check")).toEqual([]);

  const listed = await f.work("posts", "list");
  expect(listed.ok).toBe(true);
  expect((listed.body as { posts: TrackerPost[] }).posts).toMatchObject([
    { id, decider: "lead", state: "waiting", projectId: "garden", tracker: "linear" },
  ]);
  const approved = await f.work("posts", "approve", id);
  expect(approved).toMatchObject({ ok: true, body: { changed: true, post: { id, state: "posted" } } });
  expect(f.mutations("commentCreate")).toBe(2);
  // Approving again posts nothing more.
  expect(await f.work("posts", "approve", id)).toMatchObject({ ok: true, body: { changed: false } });
  expect(f.mutations("commentCreate")).toBe(2);
  const sent = f.provider.seen.filter((entry) => entry.query?.includes("commentCreate")).at(-1)!;
  expect(JSON.parse(sent.body).variables.input).toMatchObject({ body: "Worker evidence: gate latches." });

  // Sent back: nothing is posted, and the lead hears it.
  const second = await f.worker("save_comment", comment("Try again later."));
  const other = /post ([0-9a-f-]{36})/u.exec(second.outcome === "refused" ? second.detail : "")![1]!;
  expect(await f.work("posts", "send-back", other, "--reason", "Not ready")).toMatchObject({
    ok: true,
    body: { changed: true, post: { state: "sent_back", note: "Not ready" } },
  });
  expect(f.mutations("commentCreate")).toBe(2);
  await f.settle(() => f.wakes().some((text) => text.includes(`sent back`) && text.includes(other)));
});

it("ask me holds the write as a check in the owner's feed; Post it posts it once, Send it back posts nothing", async () => {
  const f = await fixture();
  // No saved setting: Linear starts on ask me.
  const held = await f.lead("save_comment", comment("Shipped in 1.4: the gate latches."));
  expect(held).toMatchObject({ outcome: "refused", reason: "posting_held" });
  if (held.outcome !== "refused") throw new Error("expected a hold");
  expect(held.detail).toContain("it waits for the owner's OK in his feed");
  const id = /post ([0-9a-f-]{36})/u.exec(held.detail)![1]!;
  expect(f.mutations("commentCreate")).toBe(0);

  const checks = (await f.feed()).items.filter((item) => item.kind === "check");
  expect(checks).toHaveLength(1);
  const check = checks[0]!;
  if (check.kind !== "check") throw new Error("expected a check");
  expect(check).toMatchObject({
    projectId: "garden",
    check: {
      line: `Post a comment on ${ISSUE_ID} to Linear`,
      question: { purpose: "verify", status: "pending", conversationId: f.main },
    },
  });
  // Exactly what would be posted, and where.
  expect(check.check.question.prompt).toContain("Shipped in 1.4: the gate latches.");
  expect(check.check.question.prompt).toContain(`issueId: ${ISSUE_ID}`);
  expect(check.check.question.options.map((option) => option.label)).toEqual(["Post it", "Send it back"]);

  // Clankie can't let the owner's ask through himself.
  expect(await f.posts({ action: "approve", id })).toMatchObject({
    status: 409,
    body: { error: "posting_held" },
  });
  expect(f.mutations("commentCreate")).toBe(0);

  await f.answer("Post it");
  await f.settle(() => f.posting.read(id)?.state === "posted");
  expect(f.mutations("commentCreate")).toBe(1);
  const sent = f.provider.seen.filter((entry) => entry.query?.includes("commentCreate")).at(-1)!;
  expect(JSON.parse(sent.body).variables.input).toMatchObject({
    issueId: ISSUE_ID,
    body: "Shipped in 1.4: the gate latches.",
  });
  // Decided once: approving again from the CLI posts nothing more.
  expect(await f.posts({ action: "approve", id })).toMatchObject({ body: { changed: false } });
  expect(f.mutations("commentCreate")).toBe(1);
  expect((await f.feed()).items.filter((item) => item.kind === "check")).toEqual([]);

  // Send it back: nothing is posted, and Clankie hears it.
  const back = await f.lead("save_comment", comment("Wrong issue."));
  const backId = /post ([0-9a-f-]{36})/u.exec(back.outcome === "refused" ? back.detail : "")![1]!;
  await f.answer("Send it back");
  await f.settle(() => f.posting.read(backId)?.state === "sent_back");
  expect(f.mutations("commentCreate")).toBe(1);
  await f.settle(() => f.wakes().some((text) => text.includes(backId) && text.includes("sent back")));

  // Only while the setting still allows it: turned read only before the answer, nothing goes.
  const late = await f.lead("save_comment", comment("Too late."));
  const lateId = /post ([0-9a-f-]{36})/u.exec(late.outcome === "refused" ? late.detail : "")![1]!;
  await f.setPosting("garden", "read_only");
  await f.answer("Post it");
  await f.settle(() => f.posting.read(lateId)?.state === "refused");
  expect(f.mutations("commentCreate")).toBe(1);
});

it("leaves private issue files and the owner's own writes alone, whatever the setting", async () => {
  const f = await fixture();
  await f.setPosting("orchard", "read_only");
  await f.setPosting("garden", "read_only");
  // The orchard's private issue files stay on this Mac: Clankie writes them freely.
  const created = await f.workItems.handle(
    { action: "create", repo: f.orchard, title: "Prune the pear tree" },
    true,
  );
  expect(created).toMatchObject({ item: { title: "Prune the pear tree" } });
  expect((await readdir(join(f.orchard, ".clankie/work"))).some((name) => name.endsWith(".md"))).toBe(true);

  // The owner speaking as himself (`clankie work owner`) is never held, even on read only.
  const response = await f.request("/v1/tracker/owner/call", {
    name: "save_comment",
    repo: f.garden,
    arguments: comment("The owner's own note."),
  });
  expect(response.status).toBe(200);
  expect(f.mutations("commentCreate")).toBe(1);
  // The same call as Clankie (`clankie work call`) is refused.
  const clankie = await f.request("/v1/tracker/call", {
    name: "save_comment",
    repo: f.garden,
    arguments: comment("Clankie's note."),
  });
  expect(clankie.status).toBe(422);
  expect(await clankie.json()).toMatchObject({ reason: "posting_refused" });
  expect(f.mutations("commentCreate")).toBe(1);
});

it("the CLI saves, reads and clears the setting through the owner API", async () => {
  const f = await fixture();
  const cli = (...args: string[]) =>
    runProjectSettingsCommand(["settings", "garden", ...args], {
      host: "http://clankie.test",
      env: {},
      operatorCredentialStore: f.credentials,
      fetchImpl: async (input, init) => f.service.app.fetch(new Request(input, init)),
    });
  expect(await cli()).toMatchObject({ posting: { saved: "default", effective: "ask", label: "Ask me" } });
  expect(await cli("--posting", "read-only")).toMatchObject({
    posting: { saved: "read_only", effective: "read_only", label: "Read only" },
  });
  expect((await f.settings.load()).projects.projects.find((p) => p.id === "garden")?.trackerPosting).toBe(
    "read_only",
  );
  // `posting VALUE` reads like `tracker ...`.
  expect(await cli("posting", "lead")).toMatchObject({
    posting: { saved: "lead", label: "Clankie decides" },
  });
  expect(await cli("--posting", "allow")).toMatchObject({ posting: { saved: "allow", label: "Go ahead" } });
  expect(await cli("--posting", "default")).toMatchObject({
    posting: { saved: "default", effective: "ask" },
  });
  expect((await f.settings.load()).projects.projects.find((p) => p.id === "garden")).not.toHaveProperty(
    "trackerPosting",
  );
  await expect(cli("--posting", "sometimes")).rejects.toThrow(
    "--posting takes read-only, ask, lead, allow or default.",
  );
  // Older readers keep their shape: the field shows only to readers that ask for it.
  const plain = await f.service.app.request("/v1/operator/projects?includeAutonomy=true", {
    headers: { authorization: `Bearer ${OWNER}` },
  });
  await cli("--posting", "lead");
  const body = (await (
    await f.service.app.request("/v1/operator/projects?includeAutonomy=true", {
      headers: { authorization: `Bearer ${OWNER}` },
    })
  ).json()) as { settings: { projects: Record<string, unknown>[] } };
  expect(plain.status).toBe(200);
  expect(body.settings.projects.find((p) => p.id === "garden")).not.toHaveProperty("trackerPosting");
  expect(body).not.toHaveProperty("projectTrackerPosting");
});

it("a drop on a Linear project is kept as a private issue file first, then posted under the setting", async () => {
  const f = await fixture();
  const drop = async (key: string, body: string): Promise<FeedDropResult> => {
    const result = await f.dispatch({
      op: "feed_drop",
      schemaVersion: 1,
      projectId: "garden",
      idempotencyKey: key,
      body,
    });
    if (result.op !== "feed_drop") throw new Error("unexpected drop result");
    return result.result as FeedDropResult;
  };
  const files = async () =>
    existsSync(join(f.garden, ".clankie/work"))
      ? (await readdir(join(f.garden, ".clankie/work"))).filter((name) => name.endsWith(".md"))
      : [];

  // Read only: the file keeps it, and nothing goes to Linear.
  await f.setPosting("garden", "read_only");
  expect(await drop("drop-read-only-0001", "The shed door squeaks")).toMatchObject({
    outcome: "filed",
    posting: "kept_local",
    item: { kind: "drop", projectId: "garden", drop: { title: "The shed door squeaks" } },
  });
  expect(await files()).toHaveLength(1);
  // The private folder ignores itself.
  expect(await readFile(join(f.garden, ".clankie/work/.gitignore"), "utf8")).toContain("*");
  expect(f.mutations("issueCreate")).toBe(0);

  // Go ahead: filed, then posted once; the file and the feed say where.
  await f.setPosting("garden", "allow");
  const posted = await drop("drop-go-ahead-0001", "The gate sticks after rain");
  expect(posted).toMatchObject({ outcome: "filed", posting: "posted", duplicate: false });
  expect(f.mutations("issueCreate")).toBe(1);
  const created = f.provider.seen.filter((entry) => entry.query?.includes("issueCreate")).at(-1)!;
  expect(JSON.parse(created.body).variables.input).toMatchObject({
    title: "The gate sticks after rain",
    description: "The gate sticks after rain",
    projectId: PROJECT_ID,
  });
  const record = (await readDrops(f.garden)).find((entry) => entry.title === "The gate sticks after rain")!;
  expect(record.posted).toMatchObject({ tracker: "linear", key: expect.stringMatching(/^VUH-\d+$/u) });
  const shown = (await f.feed()).items.find(
    (item) => item.kind === "drop" && item.drop.title === record.title,
  );
  expect(shown).toMatchObject({ drop: { posted: { tracker: "linear", key: record.posted!.key } } });
  // A retry with the same key files and posts nothing more.
  expect(await drop("drop-go-ahead-0001", "The gate sticks after rain")).toMatchObject({
    duplicate: true,
    posting: "posted",
  });
  expect(f.mutations("issueCreate")).toBe(1);

  // Ask me: filed, and posting waits as a check in the owner's feed.
  await f.setPosting("garden", "ask");
  expect(await drop("drop-ask-me-000001", "Paint the fence")).toMatchObject({ posting: "waiting" });
  const check = (await f.feed()).items.find((item) => item.kind === "check");
  expect(check).toMatchObject({ check: { line: "Post a new issue: Paint the fence to Linear" } });
  expect(f.mutations("issueCreate")).toBe(1);
  await f.answer("Post it");
  await f.settle(() => f.mutations("issueCreate") === 2);
  const fence = async () => (await readDrops(f.garden)).find((entry) => entry.title === "Paint the fence");
  for (const deadline = Date.now() + 15_000; Date.now() < deadline && (await fence())?.posted === undefined;)
    await new Promise((r) => setTimeout(r, 10));
  expect((await fence())?.posted).toMatchObject({ tracker: "linear" });
  expect(await files()).toHaveLength(3);
});

it("on go ahead a drop longer than the owner's screen still posts whole, once, and the post list still reads", async () => {
  const f = await fixture();
  await f.setPosting("garden", "allow");
  const body = `The greenhouse vents stick. ${"Notes from the morning walk. ".repeat(120)}`.trim();
  expect(body.length).toBeGreaterThan(2000);
  const result = await f.dispatch({
    op: "feed_drop",
    schemaVersion: 1,
    projectId: "garden",
    idempotencyKey: "drop-long-go-ahead-01",
    title: "Greenhouse vents stick",
    body,
  });
  expect(result).toMatchObject({ op: "feed_drop", result: { outcome: "filed", posting: "posted" } });
  expect(f.mutations("issueCreate")).toBe(1);
  const created = f.provider.seen.filter((entry) => entry.query?.includes("issueCreate")).at(-1)!;
  expect(JSON.parse(created.body).variables.input).toMatchObject({ description: body });
  const listed = await f.posts({ action: "list", state: "all" });
  expect(listed.status).toBe(200);
  const parsed = parseProtocolResponse(TrackerPostsResultSchema, listed.body);
  expect(parsed).toMatchObject({ posts: [{ state: "posted", tracker: "linear" }] });
});

it("with Linear disconnected, the Linear repo's work stays on this Mac and is never held or refused", async () => {
  const f = await fixture();
  await f.setPosting("garden", "read_only");
  expect(await f.accounts.disconnect("linear")).toMatchObject({ ok: true });
  const created = await f.work("create", "Kept here while Linear is away");
  expect(created).toMatchObject({ ok: true });
  expect(f.mutations("Create")).toBe(0);
});

it("a full record of decided posts drops its oldest, so a waiting post survives a restart", async () => {
  const day = new Date().toISOString();
  const decided = Array.from({ length: 2000 }, (_, index) => ({
    id: randomUUID(),
    projectId: "garden",
    tracker: "linear",
    decider: "owner",
    state: "posted",
    summary: `Earlier post ${String(index)}`,
    detail: `Earlier post ${String(index)}`,
    asker: "Clankie",
    createdAt: day,
    decidedAt: day,
    route: { kind: "linear", tool: "save_comment", arguments: comment(`Earlier ${String(index)}`) },
    askerRef: { kind: "lead" },
    projectIds: ["garden"],
    fingerprint: `earlier-${String(index)}`,
  }));
  const f = await fixture({ posts: decided });
  const held = await f.worker("save_comment", comment("Waits across a restart."));
  expect(held).toMatchObject({ outcome: "refused", reason: "posting_held" });
  const id = /post ([0-9a-f-]{36})/u.exec(held.outcome === "refused" ? held.detail : "")![1]!;
  const restarted = createTrackerPosting(f.postingOptions);
  cleanups.push(() => restarted.close());
  const waiting = await restarted.serve({ action: "list", state: "waiting" }, "owner");
  expect(waiting).toMatchObject({ posts: [{ id, state: "waiting" }] });
  // The record loaded whole: nothing was set aside as damaged.
  expect((await readdir(join(f.root, "state"))).filter((name) => name.includes("damaged"))).toEqual([]);
  expect(f.mutations("commentCreate")).toBe(0);
});

describe("a drop on a GitHub project", () => {
  const drop = async (f: Awaited<ReturnType<typeof fixture>>, key: string, body: string) => {
    const result = await f.dispatch({
      op: "feed_drop",
      schemaVersion: 1,
      projectId: "pond",
      idempotencyKey: key,
      body,
    });
    if (result.op !== "feed_drop") throw new Error("unexpected drop result");
    return result.result as FeedDropResult;
  };
  const created = (f: Awaited<ReturnType<typeof fixture>>) =>
    f.github.filter((entry) => entry.method === "POST" && entry.path.endsWith("/issues"));

  it("posts on go ahead as a new GitHub issue", async () => {
    const f = await fixture();
    await f.setPosting("pond", "allow");
    const filed = await drop(f, "drop-pond-go-ahead-01", "The pump hums at night");
    expect(filed).toMatchObject({
      outcome: "filed",
      posting: "posted",
    });
    expect(created(f)).toMatchObject([
      { path: "/repos/fixture/pond/issues", body: { title: "The pump hums at night" } },
    ]);
  });

  it("is not posted when the project's GitHub repo changes while it waits for the owner", async () => {
    const f = await fixture();
    await f.setPosting("pond", "ask");
    expect(await drop(f, "drop-pond-ask-me-0001", "Net the leaves")).toMatchObject({ posting: "waiting" });
    // The repo is moved to another GitHub repository before the owner answers.
    await writeConvention(f.pond, { ...f.pondConvention, github: { repo: "fixture/other" } });
    await f.answer("Post it");
    let posts: TrackerPost[] = [];
    // The answer posts in the background; under a loaded machine that can take a while.
    for (const deadline = Date.now() + 15_000; Date.now() < deadline;) {
      const listed = await f.posts({ action: "list", state: "all" });
      posts = (listed.body as { posts: TrackerPost[] }).posts;
      // "posting" is on its way to an outcome; wait for the outcome itself.
      if (posts.some((post) => post.state !== "waiting" && post.state !== "posting")) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(posts).toMatchObject([{ state: "failed", note: expect.stringContaining("tracker changed") }]);
    expect(created(f)).toEqual([]);
  });
});

it("a write through one project that lands in another's Linear project needs that project's setting too", async () => {
  const f = await fixture({ meadow: true });
  if (f.meadow === undefined) throw new Error("no meadow");
  const meadowPath = f.meadow;
  await f.setPosting("meadow", "allow");
  await f.setPosting("garden", "read_only");
  // Register the meadow as this Mac's own CLI would, then write as Clankie through it.
  await f.workItems.callTracker("list_issues", {}, { repo: meadowPath, local: true });
  const { repos } = (await f.workItems.handle({ action: "repos" }, true)) as {
    repos: { id: string; root: string }[];
  };
  const meadow = repos.find((entry) => entry.root === meadowPath)!.id;
  // Go ahead for the meadow's own work still posts.
  await expect(
    f.workItems.callTracker(
      "save_issue",
      { title: "Mow the meadow", team: "VUH" },
      { repo: meadow, local: false },
    ),
  ).resolves.toBeDefined();
  expect(f.mutations("issueCreate")).toBe(1);
  // Naming the garden's project from the meadow meets the garden's read only.
  await expect(
    f.workItems.callTracker(
      "save_issue",
      { title: "Into the garden", team: "VUH", project: PROJECT_ID },
      { repo: meadow, local: false },
    ),
  ).rejects.toThrow("Posting to Linear is read only for Garden");
  expect(f.mutations("issueCreate")).toBe(1);
});

it("a worker's GraphQL mutation meets the setting of every project on Linear, not only its hire's", async () => {
  const f = await fixture({ meadow: true });
  await f.setPosting("meadow", "allow");
  await f.setPosting("garden", "read_only");
  // GraphQL runs on the registered Linear API app.
  await f.credentials.set(LINEAR_API_PROVIDER_ID, {
    type: "oauth",
    access: API_ACCESS,
    refresh: API_REFRESH,
    expires: 0,
    linearAuth: "api",
    account: {
      provider: "linear",
      connectionId: randomUUID(),
      userId: USER_ID,
      workspaceId: "personal-workspace",
      actor: "app",
      name: "Clankie",
      workspaceName: "Personal",
      verifiedAt: new Date().toISOString(),
    },
  });
  const binding = (await f.host.account("linear", "operator")).binding;
  // A worker hired into the meadow (go ahead) comments on the garden's issue through GraphQL.
  const call = {
    lane: "operator" as const,
    server: "linear",
    tool: "graphql",
    arguments: {
      query:
        'mutation Note($issueId: String!) { commentCreate(input: { issueId: $issueId, body: "Into the garden" }) { success } }',
      variables: { issueId: ISSUE_ID },
    },
    delegation: { binding, grantId: "grant-2", principalId: "project:meadow", workId: "work-2" },
  };
  const refused = await f.host.call(call);
  expect(refused).toMatchObject({ outcome: "refused", reason: "posting_refused", possiblyDispatched: false });
  if (refused.outcome !== "refused") throw new Error("expected a refusal");
  expect(refused.detail).toContain("Posting to Linear is read only for Garden");
  expect(f.mutations("commentCreate")).toBe(0);
  // Once every project on Linear says go ahead, the same mutation posts.
  await f.setPosting("garden", "allow");
  expect(await f.host.call(call)).toMatchObject({ outcome: "ok", isError: false });
  expect(f.mutations("commentCreate")).toBe(1);
});

it("moving an issue out of a project meets that project's setting too", async () => {
  const f = await fixture({ meadow: true });
  await f.setPosting("meadow", "allow");
  await f.setPosting("garden", "read_only");
  const elsewhere = "00000000-0000-4000-8000-0000000000ff";
  f.provider.rows.projects!.push({
    ...f.provider.project,
    id: elsewhere,
    name: "Elsewhere",
    identifier: "P-VUH-2",
    slugId: "elsewhere",
  });
  const binding = (await f.host.account("linear", "operator")).binding;
  // A worker hired into the meadow (go ahead) moves the garden's issue to another project.
  const moved = await f.host.call({
    lane: "operator",
    server: "linear",
    tool: "save_issue",
    arguments: { id: ISSUE_ID, project: elsewhere },
    delegation: { binding, grantId: "grant-3", principalId: "project:meadow", workId: "work-3" },
  });
  expect(moved).toMatchObject({ outcome: "refused", reason: "posting_refused", possiblyDispatched: false });
  if (moved.outcome !== "refused") throw new Error("expected a refusal");
  expect(moved.detail).toContain("Posting to Linear is read only for Garden");
  expect(f.mutations("issueUpdate")).toBe(0);
});

describe("an issue that belongs to another project", () => {
  const MEADOW_PROJECT = "00000000-0000-4000-8000-0000000000ee";
  const setup = async () => {
    const f = await fixture({ meadow: { project: MEADOW_PROJECT } });
    f.provider.rows.projects!.push({
      ...f.provider.project,
      id: MEADOW_PROJECT,
      name: "Meadow",
      identifier: "P-VUH-3",
      slugId: "meadow",
    });
    const moveIssueToMeadow = () => {
      f.provider.issue.project = { id: MEADOW_PROJECT, name: "Meadow" };
    };
    return { f, moveIssueToMeadow };
  };

  it("meets that project's setting when a write links to it or makes it a parent", async () => {
    const { f } = await setup();
    const MEADOW_ISSUE = "00000000-0000-4000-8000-0000000000ef";
    f.provider.rows.issues!.push({
      ...f.provider.issue,
      id: MEADOW_ISSUE,
      identifier: "VUH-1400",
      title: "Mow the meadow",
      project: { id: MEADOW_PROJECT, name: "Meadow" },
    });
    await f.setPosting("garden", "allow");
    await f.setPosting("meadow", "read_only");
    // A worker in the garden (go ahead) changes the garden's issue, reaching the meadow's.
    for (const args of [
      { id: ISSUE_ID, blockedBy: ["VUH-1400"] },
      { id: ISSUE_ID, relatedTo: [MEADOW_ISSUE] },
      { id: ISSUE_ID, duplicateOf: "VUH-1400" },
      { id: ISSUE_ID, parentId: MEADOW_ISSUE },
    ]) {
      const result = await f.worker("save_issue", args);
      expect(result).toMatchObject({ outcome: "refused", reason: "posting_refused" });
      if (result.outcome !== "refused") throw new Error("expected a refusal");
      expect(result.detail).toContain("Posting to Linear is read only for Meadow");
    }
    expect(f.mutations("issueUpdate")).toBe(0);
    expect(f.mutations("issueRelation")).toBe(0);
  });

  it("meets that project's setting when a work update adds, sets or drops a dependency on its issue", async () => {
    const { f } = await setup();
    const MEADOW_ISSUE = "00000000-0000-4000-8000-0000000000ef";
    f.provider.rows.issues!.push({
      ...f.provider.issue,
      id: MEADOW_ISSUE,
      identifier: "VUH-1400",
      title: "Mow the meadow",
      project: { id: MEADOW_PROJECT, name: "Meadow" },
    });
    await f.setPosting("garden", "allow");
    await f.setPosting("meadow", "read_only");
    const update = (change: Record<string, unknown>) =>
      f.workItems.handle({ action: "update", repo: f.garden, id: "VUH-1383", ...change }, true);
    for (const change of [{ addDependsOn: ["VUH-1400"] }, { dependsOn: ["VUH-1400"] }])
      await expect(update(change)).rejects.toThrow("Posting to Linear is read only for Meadow");
    // The garden's issue already waits on the meadow's: replacing its dependencies drops that.
    const relation = {
      id: "00000000-0000-4000-8000-0000000000f0",
      type: "blocks",
      issue: { id: MEADOW_ISSUE, identifier: "VUH-1400" },
      relatedIssue: { id: ISSUE_ID, identifier: "VUH-1383" },
    };
    f.provider.issue.inverseRelations = {
      nodes: [relation],
      pageInfo: { hasNextPage: false, endCursor: null },
    };
    await expect(update({ dependsOn: [] })).rejects.toThrow("Posting to Linear is read only for Meadow");
    expect(f.mutations("issueUpdate")).toBe(0);
    expect(f.mutations("issueRelation")).toBe(0);
  });

  it("is not posted when it moves into a read only project while the write waits", async () => {
    const { f, moveIssueToMeadow } = await setup();
    await f.setPosting("garden", "lead");
    await f.setPosting("meadow", "read_only");
    const held = await f.worker("save_comment", comment("Worker evidence for the garden."));
    expect(held).toMatchObject({ outcome: "refused", reason: "posting_held" });
    const id = /post ([0-9a-f-]{36})/u.exec(held.outcome === "refused" ? held.detail : "")![1]!;
    moveIssueToMeadow();
    expect(await f.work("posts", "approve", id)).toMatchObject({
      ok: true,
      body: { changed: true, post: { id, state: "refused" } },
    });
    expect(f.mutations("commentCreate")).toBe(0);
  });

  it("meets that project's setting when a worker edits a comment or replies there by id alone", async () => {
    const { f } = await setup();
    await f.setPosting("meadow", "allow");
    await f.setPosting("garden", "read_only");
    const binding = (await f.host.account("linear", "operator")).binding;
    // A worker hired into the meadow (go ahead) reaches the garden's comment by its id.
    for (const args of [
      { id: COMMENT_ID, body: "Edited from the meadow" },
      { parentId: COMMENT_ID, body: "A reply from the meadow" },
    ]) {
      const result = await f.host.call({
        lane: "operator",
        server: "linear",
        tool: "save_comment",
        arguments: args,
        delegation: { binding, grantId: "grant-4", principalId: "project:meadow", workId: "work-4" },
      });
      expect(result).toMatchObject({ outcome: "refused", reason: "posting_refused" });
      if (result.outcome !== "refused") throw new Error("expected a refusal");
      expect(result.detail).toContain("Posting to Linear is read only for Garden");
    }
    expect(f.mutations("commentUpdate")).toBe(0);
    expect(f.mutations("commentCreate")).toBe(0);
  });

  it("meets that project's setting through clankie work update and attach", async () => {
    const { f, moveIssueToMeadow } = await setup();
    await f.setPosting("garden", "allow");
    await f.setPosting("meadow", "read_only");
    moveIssueToMeadow();
    for (const args of [
      ["update", "VUH-1383", "--title", "Renamed from the garden"],
      ["attach", "VUH-1383", "--url", "https://example.com/proof", "--caption", "Proof"],
    ]) {
      const result = await f.work(...args);
      expect(result.ok).toBe(false);
      expect(result.body).toMatchObject({
        error: "posting_refused",
        detail: expect.stringContaining("Posting to Linear is read only for Meadow"),
      });
    }
    expect(f.mutations("issueUpdate")).toBe(0);
    expect(f.mutations("attachment")).toBe(0);
  });
});

it("a local caller's work item write meets the posting setting, and a held one goes as asked", async () => {
  const f = await fixture();
  await f.workItems.callTracker("list_issues", {}, { repo: f.garden, local: true });
  const { repos } = (await f.workItems.handle({ action: "repos" }, true)) as {
    repos: { id: string; root: string }[];
  };
  const repoId = repos.find((entry) => entry.root === f.garden)!.id;
  const write = async (command: WorkItemWriteCommand) => {
    const result = await f.dispatch({
      op: "work_item_write",
      schemaVersion: 1,
      request: { repoId, itemId: ISSUE_ID, requestId: randomUUID(), command },
    });
    if (result.op !== "work_item_write") throw new Error(`unexpected ${result.op}`);
    return result.receipt;
  };
  const labelWrites = () => f.mutations("issueUpdate") + f.mutations("issueAddLabel");
  // Read only: the operator bearer is any local caller, so Clankie would be posting.
  await f.setPosting("garden", "read_only");
  expect(await write({ action: "remove_label", label: "Urgent" })).toMatchObject({
    outcome: "refused",
    message: expect.stringContaining("Posting to Linear is read only for Garden"),
  });
  expect(labelWrites()).toBe(0);
  // Ask me: the write waits for the owner and goes, as asked, once he says yes.
  await f.setPosting("garden", "ask");
  const held = await write({ action: "remove_label", label: "Urgent" });
  expect(held).toMatchObject({ outcome: "refused", message: expect.stringMatching(/post [0-9a-f-]{36}/u) });
  expect(labelWrites()).toBe(0);
  const id = /post ([0-9a-f-]{36})/u.exec(held.message)![1]!;
  await f.answer("Post it");
  await f.settle(() => f.posting.read(id)?.state === "posted");
  expect(labelWrites()).toBe(1);
  // Go ahead lets it straight through.
  await f.setPosting("garden", "allow");
  expect(await write({ action: "add_label", label: "Urgent" })).toMatchObject({ outcome: "applied" });
  expect(labelWrites()).toBe(2);
});

it("a held write that meets every Linear project's setting survives a restart with the most projects", async () => {
  const f = await fixture();
  await f.credentials.set(LINEAR_API_PROVIDER_ID, {
    type: "oauth",
    access: API_ACCESS,
    refresh: API_REFRESH,
    expires: 0,
    linearAuth: "api",
    account: {
      provider: "linear",
      connectionId: randomUUID(),
      userId: USER_ID,
      workspaceId: "personal-workspace",
      actor: "app",
      name: "Clankie",
      workspaceName: "Personal",
      verifiedAt: new Date().toISOString(),
    },
  });
  // Project settings hold up to 256 projects; every one bound to Linear meets a GraphQL write.
  await f.settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      ...current.projects,
      projects: [
        ...current.projects.projects,
        ...Array.from({ length: 256 - current.projects.projects.length }, (_, index) => ({
          id: `field-${String(index)}`,
          name: `Field ${String(index)}`,
          linearProjectBinding: { provider: "linear", projectId: randomUUID() },
        })),
      ],
    }),
  }));
  const held = await f.lead("graphql", {
    query:
      'mutation Note($issueId: String!) { commentCreate(input: { issueId: $issueId, body: "Across the fields" }) { success } }',
    variables: { issueId: ISSUE_ID },
  });
  expect(held).toMatchObject({ outcome: "refused", reason: "posting_held" });
  if (held.outcome !== "refused") throw new Error("expected a hold");
  const id = /post ([0-9a-f-]{36})/u.exec(held.detail)![1]!;
  const restarted = createTrackerPosting(f.postingOptions);
  cleanups.push(() => restarted.close());
  expect(await restarted.serve({ action: "list", state: "waiting" }, "owner")).toMatchObject({
    posts: [{ id, state: "waiting" }],
  });
  expect((await readdir(join(f.root, "state"))).filter((name) => name.includes("damaged"))).toEqual([]);
  expect(f.mutations("commentCreate")).toBe(0);
});

it("a project or team named by its name or slug meets that project's setting", async () => {
  const f = await fixture({ meadow: true });
  const binding = (await f.host.account("linear", "operator")).binding;
  const hired = (principalId: string, args: Record<string, unknown>) =>
    f.host.call({
      lane: "operator",
      server: "linear",
      tool: "save_issue",
      arguments: args,
      delegation: { binding, grantId: `grant-${principalId}`, principalId, workId: `work-${principalId}` },
    });
  // A worker in the meadow (go ahead) names the garden's Linear project by name, then slug.
  await f.setPosting("meadow", "allow");
  await f.setPosting("garden", "read_only");
  for (const project of ["Clankie", "clankie"]) {
    const result = await hired("project:meadow", { title: "Into the garden", team: "VUH", project });
    expect(result).toMatchObject({ outcome: "refused", reason: "posting_refused" });
    if (result.outcome !== "refused") throw new Error("expected a refusal");
    expect(result.detail).toContain("Posting to Linear is read only for Garden");
  }
  // A worker in the garden (go ahead) names the meadow's whole team by its name.
  await f.setPosting("garden", "allow");
  await f.setPosting("meadow", "read_only");
  const result = await hired("project:garden", { title: "Across the team", team: "Clankie" });
  expect(result).toMatchObject({ outcome: "refused", reason: "posting_refused" });
  if (result.outcome !== "refused") throw new Error("expected a refusal");
  expect(result.detail).toContain("Posting to Linear is read only for Meadow");
  expect(f.mutations("issueCreate")).toBe(0);
});

it("a team-wide project's setting covers that team's issues that sit in another project", async () => {
  const f = await fixture({ meadow: true });
  const binding = (await f.host.account("linear", "operator")).binding;
  const hired = (args: Record<string, unknown>) =>
    f.host.call({
      lane: "operator",
      server: "linear",
      tool: "save_issue",
      arguments: args,
      delegation: { binding, grantId: "grant-garden", principalId: "project:garden", workId: "work-garden" },
    });
  // The garden (go ahead) works in its own Linear project; the meadow tracks the whole team.
  await f.setPosting("garden", "allow");
  await f.setPosting("meadow", "read_only");
  for (const args of [
    // An issue of the garden's project, on the meadow's team.
    { id: ISSUE_ID, title: "Retitled in the garden" },
    // A new one in the garden's project, named with its team or by the project alone.
    { title: "New in the garden", team: "VUH", project: PROJECT_ID },
    { title: "New in the garden", project: PROJECT_ID },
  ]) {
    const result = await hired(args);
    expect(result).toMatchObject({ outcome: "refused", reason: "posting_refused" });
    if (result.outcome !== "refused") throw new Error("expected a refusal");
    expect(result.detail).toContain("Posting to Linear is read only for Meadow");
  }
  expect(f.mutations("issueCreate") + f.mutations("issueUpdate")).toBe(0);
});

it("a new issue from this repo's tracker meets the setting of a whole-team project on its team", async () => {
  const f = await fixture({ meadow: true });
  // The garden (go ahead) saves new issues to its own Linear project; the meadow tracks the team.
  await f.setPosting("garden", "allow");
  await f.setPosting("meadow", "read_only");
  const cli = await f.work("create", "Named by neither team nor project");
  expect(cli.ok).toBe(false);
  expect(cli.body).toMatchObject({
    error: "posting_refused",
    detail: expect.stringContaining("Posting to Linear is read only for Meadow"),
  });
  await expect(
    f.workItems.callTracker("save_issue", { title: "Through the repo" }, { repo: f.garden, local: true }),
  ).rejects.toThrow("Posting to Linear is read only for Meadow");
  expect(f.mutations("issueCreate")).toBe(0);
});

it("a write whose target the gate can't read, such as a new project, meets every project's setting", async () => {
  const f = await fixture({ meadow: true });
  // Clankie's chat is bound to the garden (go ahead); the meadow tracks the whole team.
  await f.setPosting("garden", "allow");
  await f.setPosting("meadow", "read_only");
  for (const [tool, args] of [
    ["save_project", { name: "New in the meadow", setTeams: ["VUH"] }],
    ["save_document", { title: "Notes", content: "Kept on the team" }],
  ] as const)
    expect(
      await f.posting.admit({
        tracker: "linear",
        route: { kind: "linear", tool, arguments: { ...args } },
        asker: { kind: "lead" },
        projectIds: ["garden"],
      }),
    ).toMatchObject({
      outcome: "refused",
      message: expect.stringContaining("Posting to Linear is read only for Meadow"),
    });
  expect(f.mutations("projectCreate") + f.mutations("documentCreate")).toBe(0);
});

it("an owner check cut off before its question was saved is asked again on restart", async () => {
  const id = randomUUID();
  const body = "Cut off mid-ask.";
  // Clankie stopped after saving the held post, before the owner's question was linked to it.
  const f = await fixture({
    posts: [
      {
        id,
        projectId: "garden",
        tracker: "linear",
        decider: "owner",
        state: "waiting",
        summary: `Post a comment on ${ISSUE_ID} to Linear`,
        detail: `Post a comment on ${ISSUE_ID} to Linear (Garden).\nbody: ${body}`,
        asker: "Clankie",
        createdAt: new Date().toISOString(),
        route: { kind: "linear", tool: "save_comment", arguments: comment(body) },
        askerRef: { kind: "lead" },
        projectIds: ["garden"],
        fingerprint: "cut-off",
      },
    ],
  });
  await f.settle(() => f.posting.read(id)?.requestId !== undefined);
  const checks = (await f.feed()).items.filter((item) => item.kind === "check");
  expect(checks).toHaveLength(1);
  await f.answer("Post it");
  await f.settle(() => f.posting.read(id)?.state === "posted");
  expect(f.mutations("commentCreate")).toBe(1);
});

it("two held posts that read the same each get their own owner check, and an answer decides only its own", async () => {
  const body = "Said twice, two ways.";
  const held = (id: string, fingerprint: string) => ({
    id,
    projectId: "garden",
    tracker: "linear",
    decider: "owner",
    state: "waiting",
    summary: `Post a comment on ${ISSUE_ID} to Linear`,
    detail: `Post a comment on ${ISSUE_ID} to Linear (Garden).\nbody: ${body}`,
    asker: "Clankie",
    createdAt: new Date().toISOString(),
    route: { kind: "linear", tool: "save_comment", arguments: comment(body) },
    askerRef: { kind: "lead" },
    projectIds: ["garden"],
    fingerprint,
  });
  const first = randomUUID();
  const second = randomUUID();
  // The same comment, held once from the lead tool and once from the repo route: two posts.
  const f = await fixture({ posts: [held(first, "lead-route"), held(second, "repo-route")] });
  await f.settle(
    () => f.posting.read(first)?.requestId !== undefined && f.posting.read(second)?.requestId !== undefined,
  );
  expect(f.posting.read(first)!.requestId).not.toBe(f.posting.read(second)!.requestId);
  expect((await f.feed()).items.filter((item) => item.kind === "check")).toHaveLength(2);
  await f.answer("Post it");
  await f.settle(() => [first, second].some((id) => f.posting.read(id)?.state === "posted"));
  await new Promise((r) => setTimeout(r, 200));
  expect([first, second].map((id) => f.posting.read(id)?.state).sort()).toEqual(["posted", "waiting"]);
  expect(f.mutations("commentCreate")).toBe(1);
});

it("a drop posted before its file was marked is marked on retry and on restart, never posted twice", async () => {
  const f = await fixture({ failDropMarks: 2 });
  await f.setPosting("garden", "allow");
  const drop = async (key: string, body: string) => {
    const result = await f.dispatch({
      op: "feed_drop",
      schemaVersion: 1,
      projectId: "garden",
      idempotencyKey: key,
      body,
    });
    if (result.op !== "feed_drop") throw new Error("unexpected drop result");
    return result.result as FeedDropResult;
  };
  const marked = async (title: string) =>
    (await readDrops(f.garden)).find((entry) => entry.title === title)?.posted;
  // Posted, but Clankie stopped before the file said where.
  expect(await drop("drop-unmarked-0001", "The well rope frays")).toMatchObject({ posting: "posted" });
  expect(await drop("drop-unmarked-0002", "The bell is cracked")).toMatchObject({ posting: "posted" });
  expect(f.mutations("issueCreate")).toBe(2);
  expect(await marked("The well rope frays")).toBeUndefined();
  expect(await marked("The bell is cracked")).toBeUndefined();
  // A retry with the same key marks the file from the saved receipt.
  expect(await drop("drop-unmarked-0001", "The well rope frays")).toMatchObject({
    duplicate: true,
    posting: "posted",
  });
  expect(await marked("The well rope frays")).toMatchObject({ tracker: "linear" });
  // A restart marks the other one.
  const restarted = createTrackerPosting(f.postingOptions);
  cleanups.push(() => restarted.close());
  restarted.bind({
    execute: async () => {
      throw new Error("a restart never posts again");
    },
    repoTarget: (ref) => f.workItems.postingTarget(ref),
    afterPosted: (entry, posted) => recordDropPosted(entry.root, entry.key, posted),
  });
  restarted.start();
  for (const deadline = Date.now() + 15_000; Date.now() < deadline && !(await marked("The bell is cracked"));)
    await new Promise((r) => setTimeout(r, 10));
  expect(await marked("The bell is cracked")).toMatchObject({ tracker: "linear" });
  expect(f.mutations("issueCreate")).toBe(2);
});

it("Watch refuses every write by Clankie, a lead or a worker, holds nothing, and the owner's own write still goes", async () => {
  const f = await fixture();
  await f.setPosting("garden", "allow");
  await f.settings.update((current) => ({ ...current, autonomy: { ...current.autonomy, watch: true } }));
  for (const call of [f.lead, f.worker]) {
    const refused = await call("save_comment", comment("Landed."));
    expect(refused).toMatchObject({ outcome: "refused", possiblyDispatched: false });
    if (refused.outcome !== "refused") throw new Error("expected a refusal");
    expect(refused.detail).toContain("only watching");
  }
  // The built-in tracker standing in for Linear is a write too.
  expect(await f.lead("save_issue", { title: "New idea", team: "VUH" })).toMatchObject({
    outcome: "refused",
  });
  const cli = await f.work("create", "From the CLI");
  expect(cli.ok).toBe(false);
  expect(cli.body).toMatchObject({ detail: expect.stringContaining("only watching") });
  expect(f.mutations("Create")).toBe(0);
  expect(f.mutations("commentCreate")).toBe(0);
  // Nothing waits in the owner's feed to go out later.
  const listed = await f.posts({ action: "list", state: "all" });
  expect(parseProtocolResponse(TrackerPostsResultSchema, listed.body)).toMatchObject({ posts: [] });

  // The owner speaking as himself is not Clankie acting.
  const own = await f.request("/v1/tracker/owner/call", {
    name: "save_comment",
    repo: f.garden,
    arguments: comment("The owner's own note."),
  });
  expect(own.status).toBe(200);
  expect(f.mutations("commentCreate")).toBe(1);

  // Leaving Watch lets Clankie write again under the project's setting.
  await f.settings.update((current) => {
    const { watch: _watch, ...autonomy } = current.autonomy;
    return { ...current, autonomy };
  });
  expect(await f.lead("save_comment", comment("Back at it."))).toMatchObject({
    outcome: "ok",
    isError: false,
  });
  expect(f.mutations("commentCreate")).toBe(2);
});

it("Watch keeps a post held for Clankie from going out when he approves it, until Watch is off", async () => {
  const f = await fixture();
  await f.setPosting("garden", "lead");
  const held = await f.worker("save_comment", comment("Held before Watch."));
  if (held.outcome !== "refused") throw new Error("expected a hold");
  const id = /post ([0-9a-f-]{36})/u.exec(held.detail)![1]!;
  await f.settings.update((current) => ({ ...current, autonomy: { ...current.autonomy, watch: true } }));
  const approved = await f.work("posts", "approve", id);
  expect(approved.ok).toBe(false);
  expect(JSON.stringify(approved.body)).toContain("only watching");
  expect(f.mutations("commentCreate")).toBe(0);
  expect(f.posting.read(id)?.state).toBe("waiting");
  await f.settings.update((current) => {
    const { watch: _watch, ...autonomy } = current.autonomy;
    return { ...current, autonomy };
  });
  expect(await f.work("posts", "approve", id)).toMatchObject({
    ok: true,
    body: { changed: true, post: { state: "posted" } },
  });
  expect(f.mutations("commentCreate")).toBe(1);
});

it("Watch refuses writes to private issue files too, through the work route and seat bookkeeping", async () => {
  const f = await fixture();
  const created = await f.workItems.handle(
    { action: "create", repo: f.orchard, title: "Before Watch" },
    true,
  );
  if (!("item" in created) || created.item === undefined) throw new Error("expected an item");
  const id = (created.item as { id: string }).id;
  const files = async () => (await readdir(join(f.orchard, ".clankie/work"))).sort();
  const before = await files();
  await f.settings.update((current) => ({ ...current, autonomy: { ...current.autonomy, watch: true } }));
  for (const body of [
    { action: "create", repo: f.orchard, title: "During Watch" },
    { action: "update", repo: f.orchard, id, status: "done" },
    {
      action: "attach",
      repo: f.orchard,
      id,
      evidence: { kind: "link", url: "https://example.com/during-watch", caption: "During Watch" },
    },
  ]) {
    const response = await f.request("/v1/work", body);
    expect(response.status).not.toBe(200);
    expect(JSON.stringify(await response.json())).toContain("only watching");
  }
  // A hire that exits while watching leaves its issue as it was: no automatic bookkeeping either.
  const seatScope = await f.workItems.prepareSeatIssueTracker("orchard", async () => {});
  await expect(seatScope.call("get_issue", { id }, "background")).resolves.toBeDefined();
  await expect(
    seatScope.call("save_comment", { issueId: id, body: "During Watch" }, "background"),
  ).rejects.toThrow("only watching");
  await expect(seatScope.call("save_issue", { id, state: "done" }, "background")).rejects.toThrow(
    "only watching",
  );
  expect(await files()).toEqual(before);
  const shown = await f.workItems.handle({ action: "show", repo: f.orchard, id }, true);
  expect(shown).toMatchObject({ item: { title: "Before Watch" } });
  expect(JSON.stringify(shown)).not.toContain("During Watch");
  expect(JSON.stringify(shown)).not.toContain('"done"');
});

it("Watch refuses Clankie's unscoped writes to the built-in tracker, and the owner's own route still writes", async () => {
  const f = await fixture();
  const call = async (path: string, name: string, args: Record<string, unknown>) => {
    const response = await f.request(path, { name, arguments: args });
    return { status: response.status, body: JSON.stringify(await response.json()) };
  };
  const teams = await call("/v1/tracker/call", "list_teams", {});
  expect(teams.status).toBe(200);
  const team = (JSON.parse(teams.body) as { result: { teams: { key: string }[] } }).result.teams[0]!.key;
  expect((await call("/v1/tracker/call", "save_issue", { team, title: "Before Watch" })).status).toBe(200);
  await f.settings.update((current) => ({ ...current, autonomy: { ...current.autonomy, watch: true } }));
  const during = await call("/v1/tracker/call", "save_issue", { team, title: "During Watch" });
  expect(during.status).not.toBe(200);
  expect(during.body).toContain("only watching");
  // Reading stays open, and nothing Clankie tried landed.
  const listed = await call("/v1/tracker/call", "list_issues", {});
  expect(listed.status).toBe(200);
  expect(listed.body).toContain("Before Watch");
  expect(listed.body).not.toContain("During Watch");
  // The owner speaking as himself is not Clankie acting.
  expect((await call("/v1/tracker/owner/call", "save_issue", { team, title: "Owner's own" })).status).toBe(
    200,
  );
});

it("Watch refuses a worker's or lead's saved-view changes on the built-in tracker, and the owner's still save", async () => {
  const f = await fixture();
  // The beds track their work in the built-in tracker, with one bound project.
  const beds = await repo(f.root, "beds", { ...decided, backend: "builtin" });
  const tracker = createLocalTracker({ directory: join(f.root, "work-state", "tracker") });
  const team = ((await tracker.call("list_teams", {})) as { teams: { id: string }[] }).teams[0]!.id;
  const project = ((await tracker.call("save_project", { name: "Beds", addTeams: [team] })) as { id: string })
    .id;
  const storeId = await tracker.storeId();
  await f.settings.update((current) => ({
    ...current,
    projects: {
      ...current.projects,
      projects: [
        ...current.projects.projects,
        ...ProjectsSettingsSchema.parse({
          projects: [
            {
              id: "beds",
              name: "Beds",
              workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: beds }],
              trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" },
              trackerProjectId: project,
            },
          ],
        }).projects,
      ],
    },
  }));
  const save = (name: string, actor?: Parameters<typeof f.workItems.callTracker>[2]["actor"]) =>
    f.workItems.callTracker(
      "save_issue_view",
      { project, storeId, schemaVersion: 1, name, filter: {} },
      { repo: beds, local: true, ...(actor === undefined ? {} : { actor }) },
    );
  const saved = (await save("Before Watch")) as { id: string };
  await f.settings.update((current) => ({ ...current, autonomy: { ...current.autonomy, watch: true } }));
  await expect(save("During Watch")).rejects.toThrow("only watching");
  await expect(
    f.workItems.callTracker(
      "post_delete_issue_view",
      { project, storeId, id: saved.id },
      { repo: beds, local: true },
    ),
  ).rejects.toThrow("only watching");
  // The owner saving a view himself is not Clankie acting.
  await expect(save("Owner's own", { ...TRACKER_OWNER, onBehalfOf: [] })).resolves.toBeDefined();
  // Reading stays open while watching, and nothing Clankie tried landed.
  const views = JSON.stringify(
    await f.workItems.callTracker("list_issue_views", { project, storeId }, { repo: beds, local: true }),
  );
  expect(views).toContain("Before Watch");
  expect(views).toContain("Owner's own");
  expect(views).not.toContain("During Watch");
});
