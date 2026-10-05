import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { OperatorFleetSeatSchema } from "@clankie/protocol";
import { ClankieSettingsSchema } from "@clankie/settings";
import { createClankieApp } from "../../clankie/src/app.ts";
import { createHerdrWatchRunner } from "../../clankie/src/captain/herdr-watch.ts";
import { createStubCaptain } from "../../clankie/src/captain/port.ts";
import { listTidyWorktrees } from "../../clankie/src/captain/tidy-worktrees.ts";
import type { FleetEfficiencyReview } from "../../clankie/src/captain/fleet-efficiency-tools.ts";
import { runAgentsCommand } from "../src/command/agents.ts";

const exec = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
const checkedAt = "2026-10-05T12:00:00.000Z";
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Real command fetches a loopback HTTP server forwarding to the production Hono app. */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agents-efficiency-cli-")));
  const reviews: { conversationId: string; review?: FleetEfficiencyReview }[] = [];
  const requests: { path: string; body: unknown; authorization: string | undefined }[] = [];
  const nativeCalls: string[][] = [];
  const seats = [
    OperatorFleetSeatSchema.parse({
      seatId: "worker-seat",
      occupantId: "native-worker-session",
      personaId: "worker-persona",
      harness: "codex",
      status: "idle",
      title: "Review worker",
      efficiency: {
        checkedAt,
        ownerConversationId: "global-default",
        assignedDeliverable: "VUH-1662",
        flags: ["paused", "reporting failure"],
        reportFailures: 2,
      },
    }),
  ];
  const runner = createHerdrWatchRunner(
    undefined,
    async (args) => {
      nativeCalls.push([...args]);
      if (args[0] !== "pane" || args[1] !== "list")
        throw new Error("CLI listing attempted a native mutation");
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
        if (review?.seatId === "unadopted-seat")
          throw new Error("The native occupant must be re-adopted before recording a review");
        return { conversationId, seats };
      },
      tidyWorktrees: (repository, mergedInto) =>
        listTidyWorktrees(repository, mergedInto ?? "origin/main", runner),
    }),
    settings: { load: async () => ClankieSettingsSchema.parse({ schemaVersion: 1 }) },
    eventLogPath: join(root, "events.jsonl"),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer cli-owner" ? { operatorId: "cli-owner" } : undefined,
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer cli-captain" ? { captainId: "model-only" } : undefined,
  });
  const server = createServer(async (request, response) => {
    try {
      const body = await text(request);
      requests.push({
        path: request.url!,
        body: JSON.parse(body),
        authorization: request.headers.authorization,
      });
      const result = await service.app.request(request.url!, {
        method: request.method ?? "POST",
        headers: { authorization: request.headers.authorization ?? "", "content-type": "application/json" },
        body,
      });
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(await result.text());
    } catch (error) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    }
  });
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    service.close();
    await rm(root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing CLI fixture address");
  const host = `http://127.0.0.1:${address.port}`;
  const env = { CLANKIE_OPERATOR_TOKEN: "cli-owner", CLANKIE_CONTROL_PLANE_URL: host };
  return { root, host, env, seats, reviews, requests, nativeCalls };
}

it("shows the exact owner's efficiency roster through the CLI and authenticated HTTP boundary", async () => {
  const f = await fixture();
  expect(await runAgentsCommand(["efficiency", "--conversation", "global-default"], { env: f.env })).toEqual({
    conversationId: "global-default",
    seats: f.seats,
  });
  expect(f.requests).toEqual([
    {
      path: "/v1/fleet/efficiency",
      authorization: "Bearer cli-owner",
      body: { action: "show", conversationId: "global-default" },
    },
  ]);
  expect(f.reviews).toEqual([{ conversationId: "global-default" }]);
  expect(f.seats[0]!.efficiency).not.toHaveProperty("contextPercent");
});

it("reads chunked JSON stdin and carries every review field intact to the selected conversation", async () => {
  const f = await fixture();
  for (const assignmentStatus of ["paused", "canceled"] as const) {
    const finding = {
      offScope: false,
      assignmentStatus,
      deliverable: "VUH-1662",
      progressAt: checkedAt,
      evidence: "Inspected native report:\ncommit abc123, finding café; literal $(command) and `text`",
    };
    const input = JSON.stringify(finding);
    expect(
      await runAgentsCommand(
        ["efficiency", "review", "worker-seat", "--json-stdin", "--conversation", "global-default"],
        {
          env: f.env,
          stdin: Readable.from([input.slice(0, 23), input.slice(23), "\n"]),
        },
      ),
    ).toEqual({ conversationId: "global-default", seats: f.seats });
    expect(f.requests.at(-1)).toEqual({
      path: "/v1/fleet/efficiency",
      authorization: "Bearer cli-owner",
      body: { ...finding, action: "review", conversationId: "global-default", seatId: "worker-seat" },
    });
    expect(f.reviews.at(-1)).toEqual({
      conversationId: "global-default",
      review: { seatId: "worker-seat", ...finding },
    });
  }
});

it("rejects stdin authority overrides before HTTP and surfaces server validation and ownership refusals", async () => {
  const f = await fixture();
  const args = ["efficiency", "review", "worker-seat", "--conversation", "global-default", "--json-stdin"];
  for (const injected of [
    { conversationId: "other-lead" },
    { seatId: "other-seat" },
    { authority: { owner: { conversationId: "other-lead" } } },
    { owner: { conversationId: "other-lead" } },
  ])
    await expect(
      runAgentsCommand(args, {
        env: f.env,
        stdin: Readable.from([JSON.stringify({ evidence: "inspected", ...injected })]),
      }),
    ).rejects.toThrow("Usage:");
  await expect(runAgentsCommand(args, { env: f.env, stdin: Readable.from(["{"]) })).rejects.toBeInstanceOf(
    SyntaxError,
  );
  await expect(runAgentsCommand(args, { env: f.env, stdin: Readable.from(["[]"]) })).rejects.toThrow(
    "Usage:",
  );
  await expect(
    runAgentsCommand(["efficiency", "review", "worker-seat", "--conversation", "global-default"], {
      env: f.env,
    }),
  ).rejects.toThrow("Usage:");
  expect(f.requests).toEqual([]);
  expect(f.reviews).toEqual([]);
  await expect(
    runAgentsCommand(args, {
      env: f.env,
      stdin: Readable.from([JSON.stringify({ evidence: "inspected", progressAt: "not-a-date" })]),
    }),
  ).rejects.toThrow("Fleet request failed: 400");
  expect(f.reviews).toEqual([]);
  await expect(
    runAgentsCommand(["efficiency", "--conversation", "other-lead"], { env: f.env }),
  ).rejects.toThrow("Fleet request failed: 409");
  expect(f.reviews).toEqual([{ conversationId: "other-lead" }]);
});

it("preserves a 409 re-adoption refusal through the real CLI HTTP boundary", async () => {
  const f = await fixture();
  const review = { seatId: "unadopted-seat", evidence: "Inspected the exact native session" };
  await expect(
    runAgentsCommand(
      ["efficiency", "review", review.seatId, "--conversation", "global-default", "--json-stdin"],
      { env: f.env, stdin: Readable.from([JSON.stringify({ evidence: review.evidence })]) },
    ),
  ).rejects.toThrow(
    "Fleet request failed: 409: The native occupant must be re-adopted before recording a review",
  );
  expect(f.requests).toEqual([
    {
      path: "/v1/fleet/efficiency",
      authorization: "Bearer cli-owner",
      body: { action: "review", conversationId: "global-default", ...review },
    },
  ]);
  expect(f.reviews).toEqual([{ conversationId: "global-default", review }]);
});

it("requires an operator credential and refuses a captain bearer without dispatching a review", async () => {
  const f = await fixture();
  const storePath = join(f.root, "empty-credentials.json");
  const args = ["efficiency", "--conversation", "global-default"];
  await expect(
    runAgentsCommand(args, {
      env: { CLANKIE_CAPTAIN_TOKEN: "cli-captain", CLANKIE_CONTROL_PLANE_URL: f.host },
      operatorCredentialStore: new FileCredentialStore(storePath),
    }),
  ).rejects.toThrow("Fleet review needs the operator credential");
  expect(f.requests).toEqual([]);
  expect(existsSync(storePath)).toBe(false);
  await expect(
    runAgentsCommand(args, { env: { ...f.env, CLANKIE_OPERATOR_TOKEN: "cli-captain" } }),
  ).rejects.toThrow("Fleet request failed: 401");
  expect(f.reviews).toEqual([]);
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

it("lists actual merged worktrees via CLI without closing panes or removing the candidates", async () => {
  const f = await fixture();
  const repo = join(f.root, "repository"),
    linked = join(f.root, "retained-worktree");
  await mkdir(repo);
  await git(repo, ["init", "--initial-branch", "main"]);
  await git(repo, ["config", "user.name", "Local fixture"]);
  await git(repo, ["config", "user.email", "fixture@example.invalid"]);
  await writeFile(join(repo, "base.txt"), "Keep the linked worktree\n");
  await git(repo, ["add", "base.txt"]);
  await git(repo, ["commit", "--quiet", "-m", "fixture baseline"]);
  await git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await git(repo, ["worktree", "add", "-b", "retained", linked]);
  const sha = await git(repo, ["rev-parse", "HEAD"]);
  const before = await git(repo, ["worktree", "list", "--porcelain", "-z"]);
  for (const ref of [undefined, "main"]) {
    expect(
      await runAgentsCommand(["tidy-worktrees", "--repo", repo, ...(ref ? ["--merged-into", ref] : [])], {
        env: f.env,
      }),
    ).toEqual({
      outcome: "listed",
      mergedInto: ref ?? "origin/main",
      candidates: [{ path: linked, branch: "retained", sha }],
      excluded: [{ path: repo, reason: "main_worktree" }],
    });
    expect(f.requests.at(-1)).toEqual({
      path: "/v1/fleet/tidy-worktrees",
      authorization: "Bearer cli-owner",
      body: { repository: repo, ...(ref ? { mergedInto: ref } : {}) },
    });
  }
  expect(f.reviews).toEqual([]);
  expect(f.nativeCalls).toEqual(Array.from({ length: 4 }, () => ["pane", "list"]));
  expect(await git(repo, ["worktree", "list", "--porcelain", "-z"])).toBe(before);
  expect(existsSync(linked)).toBe(true);
  expect(await readFile(join(linked, "base.txt"), "utf8")).toBe("Keep the linked worktree\n");
});
