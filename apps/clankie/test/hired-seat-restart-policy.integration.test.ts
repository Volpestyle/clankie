import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it } from "vitest";
import { FLEET_SEAT_RESTARTS_PATH } from "@clankie/protocol";
import {
  createHiredSeatRestarts,
  RestartRefusal,
  type RestartCandidate,
} from "../src/captain/hired-seat-restarts.ts";
import { readHiredRestartObservation } from "../src/captain/hired-restart-observation.ts";
import { registerSeatRestartRoutes } from "../src/app/seat-restart-routes.ts";
import { createBearerAuthenticator } from "../src/app/http-auth.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { formatHiredRestartLines } from "../../tui/src/command/fleet.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hired-policy-"));
  roots.push(root);
  await mkdir(join(root, ".local"));
  const id = randomUUID();
  const transcript = join(root, `${id}.jsonl`);
  let now = Date.parse("2026-10-26T12:00:00Z");
  let tokens: number | undefined = 450_000;
  let humanAt = new Date(now - 3_600_000).toISOString();
  async function native() {
    const prompt = randomUUID();
    await writeFile(
      transcript,
      [
        {
          type: "user",
          uuid: prompt,
          sessionId: id,
          timestamp: humanAt,
          message: { role: "user", content: "Continue the assigned patch" },
        },
        {
          type: "assistant",
          uuid: randomUUID(),
          parentUuid: prompt,
          sessionId: id,
          timestamp: humanAt,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Patch ready" }],
            ...(tokens === undefined ? {} : { usage: { input_tokens: tokens } }),
          },
        },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
  }
  await native();
  let requests = 0,
    restarts = 0;
  let refusedResource: string | undefined;
  let missingWork = false,
    missingFile = false,
    symlinkFile = false,
    enabled = true;
  let outcome = "restarted";
  let outcomeReason = "owner_active";
  let afterSignal: (() => void | Promise<void>) | undefined;
  const controller = new AbortController();
  const nonces: string[] = [];
  let recovery = "";
  const candidate: RestartCandidate = {
    agent: {
      paneId: "w1:p1",
      terminalId: "term_fixture",
      agent: "claude",
      status: "idle",
      title: "Policy fixture",
      session: { source: "herdr:claude", kind: "path", value: transcript },
      workingDirectory: root,
    },
    originalBrief: "Original bounded patch assignment",
    name: "fixture",
    owner: { conversationId: "lead" },
    workingDirectory: root,
    workItem: "LOCAL-TEST-1",
    async requestHandoff(message, guard) {
      await guard();
      requests++;
      const nonce = /handoff ID ([a-f0-9-]{36})/u.exec(message)![1]!;
      nonces.push(nonce);
      const body = `handoff ID ${nonce}: keep decisions and original receipts`;
      if (!missingFile) {
        if (symlinkFile) {
          await writeFile(join(root, "elsewhere"), body);
          await symlink(join(root, "elsewhere"), join(root, ".local", "HANDOFF-fixture.md"));
        } else await writeFile(join(root, ".local", "HANDOFF-fixture.md"), body);
      }
      await writeFile(
        join(root, "work-item.json"),
        JSON.stringify({ id: "LOCAL-TEST-1", body, saved: !missingWork }),
      );
      return { outcome: "replied", text: body, receiptId: "original-handoff" };
    },
    async restart(brief, guard) {
      await guard();
      restarts++;
      recovery = brief;
      if (outcome !== "refused") {
        await afterSignal?.();
        try {
          await guard("successor");
        } catch (error) {
          return {
            outcome: "uncertain",
            receiptId: "original-restart",
            reason: error instanceof RestartRefusal ? error.reason : String(error),
          };
        }
      }
      return {
        outcome,
        receiptId: "original-restart",
        ...(outcome === "refused" ? { reason: outcomeReason } : {}),
      };
    },
  };
  const notices: string[] = [];
  const deps = {
    path: join(root, "policy.json"),
    signal: controller.signal,
    enabled: async () => enabled,
    candidates: async () => [candidate],
    observe: readHiredRestartObservation,
    now: () => now,
    resources: async () => {
      if (refusedResource) throw new RestartRefusal(refusedResource);
    },
    authority: async () => {},
    lastOwnerMessageAt: (): number | undefined => undefined,
    workItem: async (_candidate: RestartCandidate, nonce: string) => {
      const item = JSON.parse(await readFile(join(root, "work-item.json"), "utf8"));
      if (!item.saved || !item.body.includes(nonce)) throw new RestartRefusal("work_item_handoff_not_saved");
      return item;
    },
    notice: (_owner: unknown, text: string) => {
      notices.push(text);
    },
  };
  const policy = createHiredSeatRestarts(deps);
  return {
    root,
    policy,
    deps,
    candidate,
    notices,
    native,
    setTokens: (value: number | undefined) => {
      tokens = value;
    },
    setHumanAt: (value: string) => {
      humanAt = value;
    },
    blockResource: (value?: string) => {
      refusedResource = value;
    },
    missingWork: () => {
      missingWork = true;
    },
    missingFile: () => {
      missingFile = true;
    },
    symlinkFile: () => {
      symlinkFile = true;
    },
    disable: () => {
      enabled = false;
    },
    afterSignal: (callback: () => void | Promise<void>) => {
      afterSignal = callback;
    },
    shutdown: () => controller.abort(),
    nonces,
    outcome: (value: string, reason = "owner_active") => {
      outcome = value;
      outcomeReason = reason;
    },
    advance: (ms: number) => {
      now += ms;
    },
    requests: () => requests,
    restarts: () => restarts,
    recovery: () => recovery,
  };
}

it("keeps all three recovery inputs before the native effect and exposes its receipt through authenticated API and CLI", async () => {
  const f = await fixture();
  await f.policy.tick();
  expect(f.requests()).toBe(1);
  expect(f.restarts()).toBe(1);
  expect(f.recovery()).toContain(f.candidate.originalBrief);
  expect(f.recovery()).toContain("handoff ID");
  expect(f.recovery()).toContain("LOCAL-TEST-1");
  const status = await f.policy.status();
  const kept = JSON.parse(
    await readFile(`${f.deps.path}.${status.seats[0]!.handoff!.id}.handoff.json`, "utf8"),
  );
  expect(kept).toMatchObject({ originalBrief: f.candidate.originalBrief, workItem: { saved: true } });
  const app = new Hono();
  registerSeatRestartRoutes(app, {
    captain: { ...createStubCaptain(), seatRestartStatus: () => f.policy.status() },
    authenticateOperator: createBearerAuthenticator("fixture", { operatorId: "fixture" }),
  });
  expect((await app.request(FLEET_SEAT_RESTARTS_PATH)).status).toBe(401);
  const response = await app.request(FLEET_SEAT_RESTARTS_PATH, {
    headers: { authorization: "Bearer fixture" },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(formatHiredRestartLines(await response.json()).join("\n")).toContain("original-restart");
  await createHiredSeatRestarts(f.deps).tick();
  expect(f.requests()).toBe(1);
  expect(f.restarts()).toBe(1);
});

it.each(["resource_held", "resource_queued", "resource_native_unknown"])(
  "records %s and one two-hour notice without dispatch",
  async (reason) => {
    const f = await fixture();
    f.blockResource(reason);
    await f.policy.tick();
    f.advance(2 * 3_600_000);
    await f.policy.tick();
    const resumed = createHiredSeatRestarts(f.deps);
    await resumed.tick();
    expect(f.requests()).toBe(0);
    expect(f.restarts()).toBe(0);
    expect(f.notices).toHaveLength(1);
    expect((await resumed.status()).seats[0]!.waiting).toMatchObject({ reason, counts: { [reason]: 3 } });
  },
);

it.each(["file", "tracker", "symlink"])(
  "preserves handoff uncertainty when %s proof is missing",
  async (gap) => {
    const f = await fixture();
    if (gap === "file") f.missingFile();
    else if (gap === "tracker") f.missingWork();
    else f.symlinkFile();
    await f.policy.tick();
    await createHiredSeatRestarts(f.deps).tick();
    expect(f.requests()).toBe(1);
    expect(f.restarts()).toBe(0);
  },
);

it("reconsiders only a definite pre-exit refusal with the same kept handoff; uncertainty never dispatches again", async () => {
  const f = await fixture();
  f.outcome("refused");
  await f.policy.tick();
  expect((await f.policy.status()).seats[0]!.handoff!.state).toBe("kept");
  f.outcome("uncertain");
  await createHiredSeatRestarts(f.deps).tick();
  await createHiredSeatRestarts(f.deps).tick();
  expect(f.requests()).toBe(1);
  expect(f.restarts()).toBe(2);
  expect(f.notices).toHaveLength(1);
  expect(f.notices[0]).toContain("restart is unconfirmed");
});

it("retires a definitely superseded kept handoff and requests exactly one fresh nonce after new input becomes quiet", async () => {
  const f = await fixture();
  f.outcome("refused");
  await f.policy.tick();
  const original = (await f.policy.status()).seats[0]!.handoff!;
  f.advance(60_000);
  f.setHumanAt("2026-10-26T12:01:00Z");
  await f.native();
  f.advance(15 * 60_000);
  f.outcome("refused", "Error: handoff_superseded");
  await createHiredSeatRestarts(f.deps).tick();
  const retired = (await createHiredSeatRestarts(f.deps).status()).seats[0]!;
  expect(retired.handoff).toBeUndefined();
  expect(retired.handoffHistory).toMatchObject([
    { id: original.id, state: "kept", reason: "handoff_superseded", receiptId: "original-restart" },
  ]);
  expect(await readFile(`${f.deps.path}.${original.id}.handoff.json`, "utf8")).toContain(original.id);
  expect(f.requests()).toBe(1);
  f.outcome("uncertain");
  await createHiredSeatRestarts(f.deps).tick();
  await createHiredSeatRestarts(f.deps).tick();
  expect(f.requests()).toBe(2);
  expect(new Set(f.nonces).size).toBe(2);
  expect(f.restarts()).toBe(3);
  expect((await createHiredSeatRestarts(f.deps).status()).seats[0]!.handoff!.state).toBe("uncertain");
});

it("completes successor recovery after the setting, owner activity and resources change following signal", async () => {
  const f = await fixture();
  f.afterSignal(async () => {
    f.disable();
    f.setHumanAt("2026-10-26T12:00:00Z");
    await f.native();
    f.deps.lastOwnerMessageAt = () => Date.parse("2026-10-26T12:00:00Z");
    f.blockResource("resource_held");
  });
  await f.policy.tick();
  expect(f.restarts()).toBe(1);
  expect((await f.policy.status()).seats[0]!.handoff!.state).toBe("restarted");
  expect(f.notices).toHaveLength(1);
  expect(f.notices[0]).toContain("restarted fresh");
});

it.each(["authority_revoked", "shutdown"])(
  "refuses successor recovery on %s and immediately notices uncertainty without replay",
  async (reason) => {
    const f = await fixture();
    f.afterSignal(() => {
      if (reason === "shutdown") f.shutdown();
      else
        f.deps.authority = async () => {
          throw new RestartRefusal(reason);
        };
    });
    await f.policy.tick();
    const status = await f.policy.status();
    expect(status.seats[0]!.handoff!.state).toBe("uncertain");
    expect(status.seats[0]!.handoff!.failureNoticedAt).toBe("2026-10-26T12:00:00.000Z");
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]).toContain("original-restart");
    await createHiredSeatRestarts(f.deps).tick();
    expect(f.requests()).toBe(1);
    expect(f.restarts()).toBe(1);
    expect(f.notices).toHaveLength(1);
  },
);

it("persists a non-replayable restart claim when the original controller throws", async () => {
  const f = await fixture();
  f.candidate.restart = async () => {
    throw new Error("controller connection lost");
  };
  await f.policy.tick();
  const resumed = createHiredSeatRestarts(f.deps);
  await resumed.tick();
  expect(f.requests()).toBe(1);
  expect((await resumed.status()).seats[0]!.handoff!.state).toBe("uncertain");
  expect(f.notices).toHaveLength(1);
  expect(f.notices[0]).toContain("controller connection lost");
});

it("requires 450K known tokens and native owner quiet; disabling prevents any request", async () => {
  const f = await fixture();
  f.setTokens(449_999);
  await f.native();
  await f.policy.tick();
  expect(f.requests()).toBe(0);
  f.setTokens(undefined);
  await f.native();
  await f.policy.tick();
  expect((await f.policy.status()).seats[0]!.waiting!.reason).toBe("usage_unreadable");
  f.setTokens(450_000);
  f.setHumanAt("2026-10-26T11:59:59Z");
  await f.native();
  await f.policy.tick();
  expect((await f.policy.status()).seats[0]!.waiting!.reason).toBe("owner_active");
  f.disable();
  await f.policy.tick();
  expect(f.requests()).toBe(0);
});

it("native human input cannot hide from owner quiet by looking like a channel message", async () => {
  const f = await fixture();
  await appendFile(
    f.candidate.agent.session!.value,
    JSON.stringify({
      type: "user",
      uuid: randomUUID(),
      timestamp: "2026-10-26T11:59:59Z",
      message: { role: "user", content: '<channel source="clankie">human input</channel>' },
    }) + "\n",
  );
  await f.policy.tick();
  expect(f.requests()).toBe(0);
  expect((await f.policy.status()).seats[0]!.waiting!.reason).toBe("owner_active");
});

it("Codex native user events count as owner input even without display-message metadata", async () => {
  const f = await fixture();
  const file = f.candidate.agent.session!.value;
  const id = file.split("/").at(-1)!.replace(".jsonl", "");
  f.candidate.agent = {
    ...f.candidate.agent,
    agent: "codex",
    session: { source: "herdr:codex", kind: "path", value: file },
  };
  await writeFile(
    file,
    [
      { timestamp: "2026-10-26T11:00:00Z", type: "session_meta", payload: { id } },
      {
        timestamp: "2026-10-26T11:00:01Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 450_000 }, model_context_window: 1_000_000 },
        },
      },
      {
        timestamp: "2026-10-26T11:59:59Z",
        type: "event_msg",
        payload: { type: "user_message", message: "owner input" },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  await f.policy.tick();
  expect(f.requests()).toBe(0);
  expect((await f.policy.status()).seats[0]!.waiting!.reason).toBe("owner_active");
});
