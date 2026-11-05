import { createServer, type Server } from "node:http";
import { realpath, readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { OperatorConversationServiceResultSchema } from "@clankie/protocol";
import { MainCheckpointRefused } from "@clankie/work-items";
import { checkpointFixture } from "../../../packages/work-items/test/fixtures/main-checkpoint.ts";
import { createHerdrSessionSource } from "../../../packages/agent-hosts/src/sessions/herdr.ts";
import { createWorkItemsService } from "../src/work-items.ts";
import { createMissingWorktreeClose } from "../src/captain/missing-worktree-close.ts";
import { ProjectHires } from "../src/captain/project-hires.ts";
import { HireWorktrees } from "../src/captain/hire-worktrees.ts";
import { PaneTidy } from "../src/captain/pane-tidy.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import {
  createOperatorService,
  type CreateOperatorServiceContext,
} from "../src/captain/captain-operator-service.ts";
import type { HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  );
  const a = server.address();
  if (!a || typeof a === "string") throw Error("No owned listener");
  return `http://127.0.0.1:${a.port}`;
}

/** Real controller stores, Git DAG, HTTP provider/close boundaries, and production close adapter.
 * Only provider responses and the native close effect are disposable fixtures. */
async function fixture(enableRecovery = true) {
  const git = await checkpointFixture();
  cleanups.push(git.close);
  git.mode("green");
  const root = await realpath(git.root),
    path = join(root, "removed-worker"),
    branch = "clankie/missing-885";
  await git.git("worktree", "add", "-b", branch, path, git.head);
  await git.git("worktree", "remove", path);
  await git.git("branch", "-D", branch);
  await git.git("remote", "set-url", "origin", "git@github.com:fixture/repo.git");
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((s) => ({
    ...s,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "project",
          name: "Fixture",
          workspaces: [{ id: "workspace", machineId: "local", platform: "posix", path: root }],
        },
      ],
    }),
  }));
  const agent: HerdrAgentSnapshot = {
    paneId: "herdr-core/t885",
    terminalId: "herdr-core/t885",
    agent: "claude",
    status: "done",
    title: "Fixture worker",
    workingDirectory: path,
    session: { source: "herdr:claude", kind: "id", value: "d709d487-f801-44f3-8b10-b6966c0d5ea1" },
  };
  const occupant = occupantIdForHerdrSession(agent.session!);
  const hiredAt = "2026-01-01T00:00:10.000Z";
  const entry = {
    id: "allocation",
    key: "controller-key",
    projectId: "project",
    policy: "fixture",
    request: { schemaVersion: 1, harness: "claude", title: "Fixture", workingDirectory: path },
    started: true,
    beganAt: Date.parse(hiredAt),
    pane: agent.paneId,
    seat: agent.terminalId,
    occupantId: occupant,
    confirmed: false,
    gone: false,
    proof: {
      nativeOccupantId: occupant,
      fleet: "default",
      pane: agent.paneId,
      binding: { socketPath: join(root, "unused.sock") },
      processes: [{ pid: 885, startTime: "fixture" }],
      shell: { pid: 884, startTime: "fixture" },
    },
  };
  const allocationsPath = join(root, "allocations.json");
  const saveAllocation = async () => {
    await writeFile(allocationsPath + ".tmp", JSON.stringify({ version: 1, allocations: [entry] }));
    await rename(allocationsPath + ".tmp", allocationsPath);
  };
  await saveAllocation();
  const hires = new ProjectHires(allocationsPath),
    relocations = new HireWorktrees(join(root, "relocations.json"));
  relocations.record(
    JSON.stringify(["local", root, "claude", "controller-brief-fingerprint"]),
    {
      path,
      workingDirectory: path,
      branch,
      start: root,
      startReason: "private dirty start",
      remoteMain: git.start,
      at: "2026-01-01T00:00:00.000Z",
    },
    () => true,
  );
  let remoteHead = git.head,
    accountId = 1,
    token = "fixture-token",
    authority = true;
  let mode = "valid";
  let authorityHook: () => Promise<void> = async () => {};
  let providerHook = async (_path: string) => {};
  let nativeHook = async () => {};
  const calls: string[] = [];
  const repo = { id: 1, full_name: "fixture/repo" };
  const pull = () => ({
    number: 885,
    html_url: "https://github.com/fixture/repo/pull/885",
    state: "closed",
    merged: mode !== "unmerged",
    merged_at: mode === "old" ? "2025-01-01T00:00:00.000Z" : "2026-01-01T00:01:00.000Z",
    merge_commit_sha: git.merge,
    head: {
      ref: mode === "wrong-branch" ? "clankie/other" : branch,
      sha: mode === "wrong-sha" ? git.tip : git.head,
      repo: mode === "foreign" ? { id: 2, full_name: "other/repo" } : repo,
    },
    base: { ref: mode === "wrong-base" ? "develop" : "main", repo },
  });
  const provider = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, "http://fixture");
      calls.push(url.pathname);
      let data: unknown;
      if (mode === "unavailable") {
        response.writeHead(503).end();
        return;
      }
      if (url.pathname === "/user") data = { id: accountId };
      else if (url.pathname === "/repos/fixture/repo") data = repo;
      else if (url.pathname === `/repos/fixture/repo/git/ref/heads/${branch}`) {
        if (mode === "missing-ref") {
          response.writeHead(404).end();
          return;
        }
        data = { ref: `refs/heads/${branch}`, object: { type: "commit", sha: remoteHead } };
      } else if (url.pathname === "/repos/fixture/repo/pulls") data = [pull()];
      else if (url.pathname === "/repos/fixture/repo/pulls/885") data = pull();
      else if (
        mode === "off-main" &&
        url.pathname === `/repos/fixture/repo/compare/${git.merge}...${git.tip}`
      )
        data = { status: "diverged", merge_base_commit: { sha: git.start } };
      else {
        const result = await fetch(git.baseUrl + request.url, {
          headers: { authorization: request.headers.authorization ?? "" },
        });
        data = await result.json();
        response.statusCode = result.status;
      }
      await providerHook(url.pathname);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(data));
    })().catch((error) => {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: String(error) }));
    });
  });
  const baseUrl = await listen(provider);
  const work = createWorkItemsService({
    stateDirectory: join(root, "work"),
    githubToken: async () => token,
    githubApiBase: baseUrl,
    clock: git.clock,
  });
  const recover = createMissingWorktreeClose({
    settings,
    claim: (a) =>
      a.session
        ? hires.missingWorktreeClaim("default", a.paneId, a.terminalId, occupantIdForHerdrSession(a.session))
        : undefined,
    relocation: (c) => relocations.closeRelocation(c),
    provider: work.landedBranch,
    history: join(root, "close-proof-history.jsonl"),
  });
  const runner = { resolveTerminal: async () => agent, get: async () => agent };
  const tidy = new PaneTidy(join(root, "tidy.json"), {
    runner,
    ...(enableRecovery ? { landedMissingWorktree: recover } : {}),
    mainCheckpoint: async (a: HerdrAgentSnapshot) => {
      try {
        if (enableRecovery && (await recover(a, path))) return undefined;
        return work.mainCheckpoint(path);
      } catch (e) {
        return e instanceof MainCheckpointRefused ? e.hold : { reason: "main_unknown", failingJobs: [] };
      }
    },
  } as never);
  let exits = 0;
  const serve = createOperatorService({
    shutdown: new AbortController(),
    personas: { ready: async () => {} },
    settingsStore: settings,
    settings: () => settings.load(),
    deps: {},
    liveSeats: [],
    seatByPersona: new Map(),
    fleetChanges: { touch: () => {} },
    fleetSnapshot: async () => ({
      snapshot: {
        seats: [
          {
            seatId: agent.terminalId,
            occupantId: occupant,
            harness: "claude",
            status: "done",
            title: "Fixture",
            owner: { hired: true },
          },
        ],
      },
    }),
    seatStarters: () => () => ({ kind: "clankie" }),
    herdrRunner: runner,
    herdrWatches: {
      seatStarter: () => undefined,
      tidy,
      closeSeat: async (_id: string, guard: () => Promise<void>) => {
        try {
          await nativeHook();
          await guard();
        } catch {
          return false;
        }
        exits++;
        return true;
      },
    },
  } as unknown as CreateOperatorServiceContext);
  const control = createServer((request, response) => {
    void (async () => {
      if (request.headers.authorization !== "Bearer fixture-owner") {
        response.writeHead(401).end();
        return;
      }
      let raw = "";
      for await (const bytes of request) raw += bytes;
      const result = await serve(
        { ...JSON.parse(raw), appDeviceId: "fixture-app" },
        {
          principal: { kind: "device", id: "fixture-app" },
          current: () => authority,
          authorize: async () => {
            await authorityHook();
            return authority;
          },
        },
      );
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(result));
    })().catch(() => {
      response.statusCode = 503;
      response.end("{}");
    });
  });
  const controlUrl = await listen(control);
  const source = createHerdrSessionSource(
    {
      dispatch: async (body) => {
        const response = await fetch(controlUrl, {
          method: "POST",
          headers: { authorization: "Bearer fixture-owner" },
          body: JSON.stringify(body),
        });
        return OperatorConversationServiceResultSchema.parse(await response.json());
      },
      terminalTail: async () => {
        throw Error("No terminal I/O");
      },
      tailRefusal: async () => Error("No terminal I/O"),
    },
    { surfaceClientId: "885-proof" },
  );
  return {
    git,
    root,
    path,
    branch,
    agent,
    entry,
    calls,
    settings,
    tidy,
    recover,
    saveAllocation,
    close: (reason: string | undefined = "worker claims its PR merged") =>
      source.close!(agent.terminalId, reason),
    closeWithoutWaiver: () => source.close!(agent.terminalId),
    exits: () => exits,
    history: () => readFile(join(root, "close-proof-history.jsonl"), "utf8"),
    mode: (value: string) => {
      mode = value;
    },
    remote: (sha: string) => {
      remoteHead = sha;
    },
    account: () => {
      accountId++;
    },
    token: () => {
      token += "-changed";
    },
    revoke: () => {
      authority = false;
    },
    onProvider: (hook: typeof providerHook) => {
      providerHook = hook;
    },
    onAuthority: (hook: typeof authorityHook) => {
      authorityHook = hook;
    },
    onNative: (hook: typeof nativeHook) => {
      nativeHook = hook;
    },
  };
}

it("close_agent proves a merged missing checkout without a baseline or local branch and retains evidence", async () => {
  const f = await fixture();
  expect(await f.close()).toMatchObject({ status: "closed" });
  expect(f.exits()).toBe(1);
  expect(JSON.parse((await f.history()).trim())).toMatchObject({
    kind: "verified_landed_close_work",
    proof: {
      allocation: "allocation",
      occupantId: f.entry.occupantId,
      branchRef: `refs/heads/${f.branch}`,
      head: f.git.head,
      merge: f.git.merge,
      pull: 885,
    },
  });
  expect(f.entry.confirmed).toBe(false);
});

it.each([
  "unmerged",
  "old",
  "wrong-branch",
  "wrong-sha",
  "foreign",
  "wrong-base",
  "off-main",
  "missing-ref",
  "unavailable",
])("close_agent refuses %s provider proof with zero native effects", async (mode) => {
  const f = await fixture();
  f.mode(mode);
  expect(await f.close()).toMatchObject({ status: "refused" });
  expect(f.exits()).toBe(0);
});
it.each(["red", "running", "unknown"])("preserves the %s main checkpoint hold", async (mode) => {
  const f = await fixture();
  f.git.mode(mode);
  expect(await f.close()).toMatchObject({
    status: "refused",
    detail: expect.stringContaining(
      mode === "red" ? "main_red" : mode === "running" ? "main_pending" : "main_unknown",
    ),
  });
  expect(f.exits()).toBe(0);
});
it("a surviving newer local branch cannot be covered by a merged remote head", async () => {
  const f = await fixture();
  await f.git.git("update-ref", `refs/heads/${f.branch}`, f.git.tip);
  expect(await f.close()).toMatchObject({ status: "refused" });
  expect(f.exits()).toBe(0);
});
it.each([
  "remote",
  "local",
  "origin",
  "occupant",
  "project",
  "account",
  "connection",
  "worktree",
  "authority",
])("a %s change during provider reads refuses before native close", async (kind) => {
  const f = await fixture();
  let changed = false;
  f.onProvider(async (path) => {
    if (changed || !path.includes("/pulls/885")) return;
    changed = true;
    if (kind === "remote") f.remote(f.git.tip);
    if (kind === "local") await f.git.git("update-ref", `refs/heads/${f.branch}`, f.git.tip);
    if (kind === "origin") await f.git.git("remote", "set-url", "origin", "git@github.com:foreign/repo.git");
    if (kind === "occupant") {
      f.entry.occupantId = "replaced";
      await f.saveAllocation();
    }
    if (kind === "project")
      await f.settings.update((s) => ({ ...s, projects: ProjectsSettingsSchema.parse({}) }));
    if (kind === "account") f.account();
    if (kind === "connection") f.token();
    if (kind === "worktree") {
      await mkdir(f.path);
      await writeFile(join(f.path, "unsaved"), "draft");
    }
    if (kind === "authority") f.revoke();
  });
  expect(await f.close()).toMatchObject({ status: "refused" });
  expect(f.exits()).toBe(0);
});
it.each(["remote", "occupant", "worktree", "authority"])(
  "the final native guard rechecks %s",
  async (kind) => {
    const f = await fixture();
    f.onNative(async () => {
      if (kind === "remote") f.remote(f.git.tip);
      if (kind === "occupant") {
        Object.assign(f.agent, {
          session: { source: "herdr:claude", kind: "id", value: "c38a0aa8-2e8b-45ed-825b-b5425a922ea6" },
        });
      }
      if (kind === "worktree") {
        await mkdir(f.path);
        await writeFile(join(f.path, "unsaved"), "draft");
      }
      if (kind === "authority") f.revoke();
    });
    expect(await f.close()).toMatchObject({ status: "refused" });
    expect(f.exits()).toBe(0);
  },
);
it("a missing baseline is not replaced by worker text or an allocation without native proof", async () => {
  const f = await fixture();
  f.entry.proof.nativeOccupantId = "some-other-session";
  await f.saveAllocation();
  expect(await f.close()).toMatchObject({ status: "refused" });
  expect(f.exits()).toBe(0);
});

it("without controller recovery the original removed-checkout close sequence still holds as main_unknown", async () => {
  const f = await fixture(false);
  expect(await f.close()).toMatchObject({
    status: "refused",
    detail: expect.stringContaining("main_unknown"),
  });
  expect(f.calls).toEqual([]);
  expect(f.exits()).toBe(0);
});
it("the existing filed-finding policy clears a red checkpoint only with canonical linked evidence", async () => {
  const f = await fixture();
  f.git.mode("red");
  f.git.link("url");
  expect(await f.close()).toMatchObject({ status: "closed" });
  expect(f.exits()).toBe(1);
});
it("a repository without checkpoint jobs still requires the merge to be on main", async () => {
  const f = await fixture();
  f.git.mode("no-checkpoint");
  f.mode("off-main");
  expect(await f.close()).toMatchObject({ status: "refused" });
  expect(f.exits()).toBe(0);
});
it("a dirty surviving checkout stays refused through the ordinary worktree guard", async () => {
  const f = await fixture();
  await f.git.git("worktree", "add", "-b", f.branch, f.path, f.git.head);
  await writeFile(join(f.path, "unsaved"), "do not lose");
  // No leave-unlanded waiver: this asserts the existing ordinary refusal.
  const result = await f.closeWithoutWaiver();
  expect(result).toMatchObject({ status: "refused" });
  expect(f.exits()).toBe(0);
});
it("a second work directory cannot be covered by the missing checkout proof even with leave_unlanded", async () => {
  const f = await fixture();
  Object.assign(f.agent, { foregroundWorkingDirectory: f.root });
  expect(await f.close()).toMatchObject({ status: "refused" });
  expect(f.exits()).toBe(0);
});
it("an ambiguous controller allocation cannot borrow another merged branch", async () => {
  const f = await fixture();
  const records = JSON.parse(await readFile(join(f.root, "allocations.json"), "utf8"));
  records.allocations.push({ ...records.allocations[0], id: "another-allocation" });
  await writeFile(join(f.root, "allocations.json"), JSON.stringify(records));
  expect(await f.close()).toMatchObject({ status: "refused" });
  expect(f.exits()).toBe(0);
});

it("another live allocation in the same worktree cannot lend its landed branch proof", async () => {
  const f = await fixture();
  const file = join(f.root, "allocations.json"),
    data = JSON.parse(await readFile(file, "utf8"));
  data.allocations.push({
    ...data.allocations[0],
    id: "second",
    pane: "herdr-core/tother",
    seat: "herdr-core/tother",
  });
  await writeFile(file, JSON.stringify(data));
  expect(await f.close()).toMatchObject({ status: "refused" });
  expect(f.exits()).toBe(0);
});

it.each(["local", "origin", "project", "allocation", "worktree"])(
  "a %s change during the last authority await still refuses closure",
  async (kind) => {
    const f = await fixture();
    f.onNative(async () => {
      f.onAuthority(async () => {
        if (kind === "local") await f.git.git("update-ref", `refs/heads/${f.branch}`, f.git.tip);
        if (kind === "origin")
          await f.git.git("remote", "set-url", "origin", "git@github.com:foreign/repo.git");
        if (kind === "project")
          await f.settings.update((s) => ({ ...s, projects: ProjectsSettingsSchema.parse({}) }));
        if (kind === "allocation") {
          f.entry.occupantId = "replaced";
          await f.saveAllocation();
        }
        if (kind === "worktree") {
          await mkdir(f.path);
          await writeFile(join(f.path, "unsaved"), "draft");
        }
      });
    });
    expect(await f.close()).toMatchObject({ status: "refused" });
    expect(f.exits()).toBe(0);
  },
);
