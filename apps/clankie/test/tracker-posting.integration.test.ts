import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { FileCredentialStore, OPERATOR_CREDENTIAL_PROVIDER_ID } from "@clankie/credential-broker";
import {
  OperatorConversationServiceResultSchema,
  parseProtocolResponse,
  type ConversationQuestion,
  type FeedDropResult,
  type FeedPage,
  type OperatorConversationServiceRequest,
} from "@clankie/protocol";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import {
  TrackerPostsResultSchema,
  type TrackerPost,
  type TrackerPosting,
} from "@clankie/protocol/tracker-posting";
import type { WorkConvention } from "@clankie/protocol/work-items";
import { SettingsStore } from "@clankie/settings";
import { createLocalTracker, readDrops, recordDropPosted, writeConvention } from "@clankie/work-items";
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
import { createLinearApiProvider, ISSUE_ID, PROJECT_ID } from "./fixtures/linear-api-provider.ts";

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

async function fixture(seed: { posts?: readonly Record<string, unknown>[] } = {}) {
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
    requestOwnerAsk: (conversationId, draft, publicationId) =>
      store.requestSurfaceQuestion(conversationId, draft, {
        current: () => store.conversation(conversationId) !== undefined,
        publicationId,
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
    localMachineId: "local",
    mcpHost: host,
    run: defaultRun,
    posting,
  });
  posting.bind({
    execute: trackerPostingExecutor({ mcpHost: host, workItems }),
    repoTarget: (ref) => workItems.postingTarget(ref),
    afterPosted: (drop, posted) => recordDropPosted(drop.root, drop.key, posted),
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
    for (let tries = 0; tries < 200 && !check(); tries += 1) await new Promise((r) => setTimeout(r, 10));
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
  for (let tries = 0; tries < 200 && (await fence())?.posted === undefined; tries += 1)
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
