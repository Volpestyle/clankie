import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  OperatorConnectionCommand,
  OperatorConversationServiceRequest,
  OperatorConversationServiceResult,
  SetupSurveySnapshot,
} from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { afterEach, expect, it } from "vitest";
import { createClankieApp, type TrustedOperatorIdentity } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import type { ExecutionConnections } from "../src/herdr-session.ts";

// ADR 0317: setup's one read-only agent looks around, proposes, and only the
// lines the owner approves run. Watch steps aside for it and comes back.

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const operator = (request: Request): Promise<TrustedOperatorIdentity | undefined> =>
  Promise.resolve(
    request.headers.get("authorization") === "Bearer owner" ? { operatorId: "operator-james" } : undefined,
  );

const PROPOSAL = {
  schemaVersion: 1,
  summary:
    "You have a desktop on your tailnet that Clankie doesn't know yet, and three repositories on GitHub.",
  findings: ["clankie and clankie-app use GitHub issues."],
  lines: [
    {
      kind: "add_machine",
      id: "add-desktop",
      why: "It runs Herdr.",
      machine: "desktop",
      ssh: "james@desktop",
    },
    {
      kind: "machine_access",
      id: "local-workers",
      why: "Agents can work here.",
      machine: "local",
      accessLevel: "workers",
    },
    {
      kind: "owner_step",
      id: "install-herdr",
      why: "The laptop has no Herdr.",
      step: "Install Herdr on the laptop.",
    },
  ],
};

async function fixture(options: { spawn?: "spawned" | "failed" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "setup-survey-"));
  roots.push(root);
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({ ...current, autonomy: { ...current.autonomy, watch: true } }));
  const requests: OperatorConversationServiceRequest[] = [];
  const reports: { text: string; seatId: string }[] = [];
  const commands: OperatorConnectionCommand[] = [];
  let watchedAtHire: boolean | undefined;
  const closed: string[] = [];
  const captain = createStubCaptain({
    // The lead may already have read them; the survey still sees its own agent's reports.
    seatReports: async ({ conversationId, seatId }) =>
      conversationId === "global-default"
        ? reports.filter((report) => report.seatId === seatId).map(({ text }) => ({ text, acceptedAt: "" }))
        : [],
    serveOperatorConversation: async (request) => {
      requests.push(request);
      if (request.op === "spawn_seat") {
        watchedAtHire = (await settings.load()).autonomy.watch === true;
        return (
          options.spawn === "failed"
            ? {
                op: "spawn_seat",
                schemaVersion: 1,
                result: {
                  outcome: "failed",
                  reason: "harness_unavailable",
                  detail: "Claude is not signed in.",
                },
              }
            : {
                op: "spawn_seat",
                schemaVersion: 1,
                result: { outcome: "spawned", seat: { seatId: "w1:p7" } },
              }
        ) as OperatorConversationServiceResult;
      }
      // As the real service does, closing refuses while Watch is on.
      if (request.op === "close_seat" && (await settings.load()).autonomy.watch === true)
        throw new Error("Watch is on");
      if (request.op === "close_seat") {
        closed.push(request.seatId);
        return {
          op: "close_seat",
          schemaVersion: 1,
          seatId: request.seatId,
          closed: true,
        } as OperatorConversationServiceResult;
      }
      throw new Error(`unexpected ${request.op}`);
    },
  });
  // Only the machine boundary is faked: adding a real machine would SSH out.
  const runtimes = {
    list: async () => [],
    connect: async (input: unknown) => {
      commands.push({ action: "connect_runtime", ...(input as { id: string; session: string }) });
      return {};
    },
    disconnect: async () => ({}),
    machines: {
      list: async () => ({
        observedAt: new Date().toISOString(),
        machines: [
          {
            id: "desktop",
            name: "desktop",
            platform: "linux",
            transport: "ssh",
            ssh: "james@desktop",
            configured: false,
            state: "available",
            workerCount: null,
            sessions: [{ name: "default", state: "available", workerCount: null }],
          },
        ],
      }),
      add: async (input: { id: string; ssh: string; shell: "posix" | "powershell" }) => {
        commands.push({ action: "add_machine", ...input });
      },
      setAccess: async (id: string, input: { accessLevel: "workers" }) => {
        commands.push({ action: "set_machine_access", id, accessLevel: input.accessLevel });
      },
      remove: async () => undefined,
    },
  } as unknown as ExecutionConnections;
  const { app } = await createClankieApp({
    captain,
    authenticateOperator: operator,
    settings,
    runtimes,
    setupSurveyPath: join(root, "state", "setup-survey.json"),
  });
  const call = async (method: "GET" | "POST", path: string, body?: unknown, token = "owner") => {
    const response = await app.request(path, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: (await response.json()) as SetupSurveySnapshot & { error?: string },
    };
  };
  return {
    settings,
    requests,
    reports,
    commands,
    call,
    watchedAtHire: () => watchedAtHire,
    closed: () => closed,
  };
}

it("hires one read-only Claude agent, applies only the approved lines, and goes back to Watch", async () => {
  const f = await fixture();
  expect((await f.call("POST", "/v1/setup/survey", { schemaVersion: 1 }, "someone")).status).toBe(401);

  const started = await f.call("POST", "/v1/setup/survey", { schemaVersion: 1, account: "work" });
  expect(started.status).toBe(200);
  expect(started.body.survey).toMatchObject({ status: "surveying", seatId: "w1:p7", restoresWatch: true });
  // Watch stepped aside before the hire, which it would otherwise refuse.
  expect(f.watchedAtHire()).toBe(false);
  const hire = f.requests.find((request) => request.op === "spawn_seat");
  expect(hire).toMatchObject({
    conversationId: "global-default",
    seat: { harness: "claude", account: "work", readOnly: true, title: "setup" },
  });
  const brief = hire?.op === "spawn_seat" ? (hire.brief ?? "") : "";
  expect(brief).toContain("You are read-only");
  expect(brief).toContain('"ssh": "james@desktop"');

  // One survey at a time.
  expect((await f.call("POST", "/v1/setup/survey", { schemaVersion: 1 })).status).toBe(409);
  const surveyId = started.body.survey!.id;
  expect(
    (await f.call("POST", "/v1/setup/survey/apply", { schemaVersion: 1, surveyId, lineIds: [] })).status,
  ).toBe(409);

  // A report from another agent, or without the block, proposes nothing.
  f.reports.push({ seatId: "w1:p9", text: `\`\`\`json\n${JSON.stringify(PROPOSAL)}\n\`\`\`` });
  f.reports.push({ seatId: "w1:p7", text: "Still reading your repositories." });
  expect((await f.call("GET", "/v1/setup/survey")).body.survey?.status).toBe("surveying");
  f.reports.push({
    seatId: "w1:p7",
    text: `Here is what I found.\n\n\`\`\`json\n${JSON.stringify(PROPOSAL, null, 2)}\n\`\`\``,
  });
  const proposed = await f.call("GET", "/v1/setup/survey");
  expect(proposed.body.survey?.status).toBe("proposed");
  expect(proposed.body.survey?.proposal?.lines.map((line) => line.id)).toEqual([
    "add-desktop",
    "local-workers",
    "install-herdr",
  ]);

  expect(
    (await f.call("POST", "/v1/setup/survey/apply", { schemaVersion: 1, surveyId, lineIds: ["not-a-line"] }))
      .status,
  ).toBe(409);
  const applied = await f.call("POST", "/v1/setup/survey/apply", {
    schemaVersion: 1,
    surveyId,
    lineIds: ["local-workers", "install-herdr"],
  });
  expect(applied.status).toBe(200);
  expect(applied.body.survey).toMatchObject({
    status: "applied",
    results: [
      { lineId: "local-workers", outcome: "applied" },
      { lineId: "install-herdr", outcome: "yours" },
    ],
  });
  // The declined machine was never added.
  expect(f.commands).toEqual([{ action: "set_machine_access", id: "local", accessLevel: "workers" }]);
  expect(f.requests.filter((request) => request.op === "close_seat")).toEqual([
    { op: "close_seat", schemaVersion: 1, seatId: "w1:p7" },
  ]);
  expect((await f.settings.load()).autonomy.watch).toBe(true);
});

it("goes back to Watch when the hire fails or the owner says no", async () => {
  const failed = await fixture({ spawn: "failed" });
  const answer = await failed.call("POST", "/v1/setup/survey", { schemaVersion: 1 });
  expect(answer.body.survey).toMatchObject({ status: "failed", detail: "Claude is not signed in." });
  expect((await failed.settings.load()).autonomy.watch).toBe(true);

  const declined = await fixture();
  const started = await declined.call("POST", "/v1/setup/survey", { schemaVersion: 1 });
  expect((await declined.settings.load()).autonomy.watch).toBeUndefined();
  const cancelled = await declined.call("POST", "/v1/setup/survey/cancel", {
    schemaVersion: 1,
    surveyId: started.body.survey!.id,
  });
  expect(cancelled.body.survey?.status).toBe("cancelled");
  expect(declined.requests.some((request) => request.op === "close_seat")).toBe(true);
  expect((await declined.settings.load()).autonomy.watch).toBe(true);
});

it("lets an approved level replace Watch instead of restoring it", async () => {
  const f = await fixture();
  const started = await f.call("POST", "/v1/setup/survey", { schemaVersion: 1 });
  f.reports.push({
    seatId: "w1:p7",
    text: `\`\`\`json\n${JSON.stringify({
      schemaVersion: 1,
      summary: "Your workers run on this Mac.",
      lines: [{ kind: "autonomy", id: "level", why: "You asked agents to work here.", level: "low" }],
    })}\n\`\`\``,
  });
  const applied = await f.call("POST", "/v1/setup/survey/apply", {
    schemaVersion: 1,
    surveyId: started.body.survey!.id,
    lineIds: ["level"],
  });
  expect(applied.body.survey?.results).toEqual([{ lineId: "level", outcome: "applied" }]);
  const autonomy = (await f.settings.load()).autonomy;
  expect(autonomy.watch).toBeUndefined();
  expect(autonomy.confirmedAt).toBeDefined();
});

it("closes the agent before an approved Watch level turns Watch on", async () => {
  const f = await fixture();
  await f.settings.update((current) => {
    const { watch: _watch, ...autonomy } = current.autonomy;
    return { ...current, autonomy };
  });
  const started = await f.call("POST", "/v1/setup/survey", { schemaVersion: 1 });
  expect(started.body.survey?.restoresWatch).toBe(false);
  f.reports.push({
    seatId: "w1:p7",
    text: `\`\`\`json\n${JSON.stringify({
      schemaVersion: 1,
      summary: "You only want to watch for now.",
      lines: [{ kind: "autonomy", id: "level", why: "You said so.", level: "watch" }],
    })}\n\`\`\``,
  });
  await f.call("POST", "/v1/setup/survey/apply", {
    schemaVersion: 1,
    surveyId: started.body.survey!.id,
    lineIds: ["level"],
  });
  // The close went through, which it can't once Watch is on.
  expect(f.closed()).toEqual(["w1:p7"]);
  expect((await f.settings.load()).autonomy.watch).toBe(true);
});
