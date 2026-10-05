import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { OperatorFleetSeatSchema } from "@clankie/protocol";
import { ClankieSettingsSchema } from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { listTidyWorktrees } from "../src/captain/tidy-worktrees.ts";
import type { FleetEfficiencyReview } from "../src/captain/fleet-efficiency-tools.ts";

const exec = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
const checkedAt = "2026-10-05T12:00:00.000Z";
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fleet-efficiency-api-")));
  const seats = [
    OperatorFleetSeatSchema.parse({
      seatId: "worker-seat",
      occupantId: "native-worker-session",
      personaId: "worker-persona",
      harness: "codex",
      status: "idle",
      title: "Assigned worker",
      workerReportRouting: { source: "adoption", conversationId: "global-default" },
      workerReports: [
        {
          deliveryId: "bddfcb6b-ceca-4e1a-81fd-09f44e3724b3",
          conversationId: "global-default",
          paneId: "worker-pane",
          state: "uncertain",
          acceptedAt: checkedAt,
        },
      ],
      efficiency: {
        checkedAt,
        ownerConversationId: "global-default",
        flags: ["paused", "off scope", "reporting failure"],
        assignedDeliverable: "VUH-1662",
        objective: "Deliver the bounded efficiency review",
        currentIssue: "VUH-1662",
        model: "gpt-6-sol",
        effort: "high",
        contextPercent: 82,
        lastProgressAt: checkedAt,
        lastReportAt: checkedAt,
        reportFailures: 2,
      },
    }),
    OperatorFleetSeatSchema.parse({
      seatId: "unknown-seat",
      occupantId: "unsupported-native-session",
      personaId: "unknown-persona",
      harness: "opencode",
      status: "unknown",
      title: "Unknown telemetry",
      efficiency: { checkedAt, ownerConversationId: "global-default", flags: [] },
    }),
  ];
  const reviews: { conversationId: string; review?: FleetEfficiencyReview }[] = [];
  const tidyCalls: { repository: string; mergedInto?: string }[] = [];
  const nativeCalls: string[][] = [];
  const runner = createHerdrWatchRunner(
    undefined,
    async (args) => {
      nativeCalls.push([...args]);
      if (args[0] !== "pane" || args[1] !== "list")
        throw new Error("Read-only endpoint attempted a native mutation");
      return JSON.stringify({ result: { panes: [] } });
    },
    undefined,
    { localCodexRecovery: false },
  );
  const service = await createClankieApp({
    captain: createStubCaptain({
      fleetEfficiency: async (conversationId, review) => {
        reviews.push({ conversationId, ...(review ? { review } : {}) });
        if (conversationId !== "global-default") throw new Error("Conversation does not lead this seat");
        return { conversationId, seats };
      },
      tidyWorktrees: async (repository, mergedInto) => {
        tidyCalls.push({ repository, ...(mergedInto === undefined ? {} : { mergedInto }) });
        return listTidyWorktrees(repository, mergedInto ?? "origin/main", runner);
      },
    }),
    settings: { load: async () => ClankieSettingsSchema.parse({ schemaVersion: 1 }) },
    eventLogPath: join(root, "events.jsonl"),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-owner"
        ? { operatorId: "fixture-owner" }
        : undefined,
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer fixture-captain"
        ? { captainId: "model-only" }
        : undefined,
  });
  cleanups.push(async () => {
    service.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    seats,
    reviews,
    tidyCalls,
    nativeCalls,
    post: (path: string, body: unknown, token = "fixture-owner") =>
      service.app.request(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    request: service.app.request.bind(service.app),
  };
}

it("requires operator authentication for fleet review and worktree listing before captain dispatch", async () => {
  const f = await fixture();
  const paths = [
    ["/v1/fleet/efficiency", { action: "show", conversationId: "global-default" }],
    ["/v1/fleet/tidy-worktrees", { repository: f.root }],
  ] as const;
  for (const [path, body] of paths) {
    for (const token of ["", "fixture-captain", "unknown-token"]) {
      const response = await f.post(path, body, token);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "operator_authentication_required" });
    }
  }
  expect(f.reviews).toEqual([]);
  expect(f.tidyCalls).toEqual([]);
  expect(f.nativeCalls).toEqual([]);
  const response = await f.post(paths[0][0], paths[0][1]);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ conversationId: "global-default", seats: f.seats });
  expect(f.reviews).toEqual([{ conversationId: "global-default" }]);
  // Unsupported telemetry survives the public boundary as absent, rather than a guessed healthy value.
  expect(f.seats[1]!.efficiency).not.toHaveProperty("effort");
  expect(f.seats[1]!.efficiency).not.toHaveProperty("contextPercent");
});

it("dispatches exact review fields and rejects body-supplied authority and malformed findings", async () => {
  const f = await fixture();
  const review = {
    seatId: "worker-seat",
    offScope: true,
    assignmentStatus: "paused",
    deliverable: "VUH-1662",
    progressAt: checkedAt,
    evidence: "Inspected native report and tracker assignment",
  } as const;
  const body = { action: "review", conversationId: "global-default", ...review };
  for (const injected of [
    { authority: { owner: { conversationId: "other-lead" } } },
    { owner: { conversationId: "other-lead" } },
    { ownerConversationId: "other-lead" },
  ])
    expect((await f.post("/v1/fleet/efficiency", { ...body, ...injected })).status).toBe(400);
  for (const invalid of [
    { ...body, evidence: "" },
    { ...body, evidence: undefined },
    { ...body, progressAt: "not-a-date" },
    { ...body, assignmentStatus: "running" },
    { ...body, offScope: "yes" },
    { action: "show", conversationId: "global-default", seatId: "worker-seat" },
  ])
    expect((await f.post("/v1/fleet/efficiency", invalid)).status).toBe(400);
  expect(f.reviews).toEqual([]);
  const response = await f.post("/v1/fleet/efficiency", body);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ conversationId: "global-default", seats: f.seats });
  expect(f.reviews).toEqual([{ conversationId: "global-default", review }]);
  const refused = await f.post("/v1/fleet/efficiency", { ...body, conversationId: "other-lead" });
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: "refused", message: "Conversation does not lead this seat" });
  expect(f.reviews[1]).toEqual({ conversationId: "other-lead", review });
});

async function git(path: string, args: readonly string[]) {
  const { stdout } = await exec(
    "git",
    [
      "--no-optional-locks",
      "-C",
      path,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    {
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      encoding: "utf8",
      timeout: 5_000,
    },
  );
  return stdout.trimEnd();
}

it("lists real merged worktrees through the owner endpoint without deleting or modifying them", async () => {
  const f = await fixture();
  const repo = join(f.root, "repository"),
    linked = join(f.root, "merged-worktree"),
    dirty = join(f.root, "dirty-worktree");
  await mkdir(repo);
  await git(repo, ["init", "--initial-branch", "main"]);
  await git(repo, ["config", "user.name", "Local fixture"]);
  await git(repo, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(repo, "base.txt"), "Retain repository contents\n");
  await git(repo, ["add", "base.txt"]);
  await git(repo, ["commit", "--quiet", "-m", "fixture baseline"]);
  await git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const sha = await git(repo, ["rev-parse", "HEAD"]);
  await git(repo, ["worktree", "add", "-b", "merged", linked]);
  await git(repo, ["worktree", "add", "-b", "dirty", dirty]);
  await writeFile(join(dirty, "owner-note.txt"), "Retain untracked owner work\n");
  const before = await git(repo, ["worktree", "list", "--porcelain", "-z"]);
  expect((await f.post("/v1/fleet/tidy-worktrees", { repository: repo, remove: true })).status).toBe(400);
  expect((await f.request("/v1/fleet/tidy-worktrees", { method: "DELETE" })).status).toBe(404);
  expect(f.tidyCalls).toEqual([]);
  for (const mergedInto of [undefined, "main"]) {
    const response = await f.post("/v1/fleet/tidy-worktrees", {
      repository: repo,
      ...(mergedInto ? { mergedInto } : {}),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      outcome: "listed",
      mergedInto: mergedInto ?? "origin/main",
      candidates: [{ path: linked, branch: "merged", sha }],
      excluded: [
        { path: repo, reason: "main_worktree" },
        { path: dirty, reason: "dirty" },
      ],
    });
  }
  expect(f.tidyCalls).toEqual([{ repository: repo }, { repository: repo, mergedInto: "main" }]);
  expect(f.nativeCalls).toEqual(Array.from({ length: 4 }, () => ["pane", "list"]));
  expect(await git(repo, ["worktree", "list", "--porcelain", "-z"])).toBe(before);
  expect(existsSync(linked)).toBe(true);
  expect(await readFile(join(linked, "base.txt"), "utf8")).toBe("Retain repository contents\n");
  expect(await readFile(join(dirty, "owner-note.txt"), "utf8")).toBe("Retain untracked owner work\n");
});
