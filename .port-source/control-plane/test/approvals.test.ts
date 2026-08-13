import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileDoctrine, createConnectorActionClassifier, loadDoctrineFile } from "@clankie/doctrine";
import { SqliteEventStore } from "@clankie/event-store";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createControlPlane, type CapabilityBroker, type TrustedOperatorIdentity } from "../src/app.ts";

const tempDirs: string[] = [];
let doctrine: Awaited<ReturnType<typeof loadDoctrine>>;

async function loadDoctrine() {
  return compileDoctrine([
    await loadDoctrineFile(resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml")),
  ]);
}

beforeAll(async () => {
  doctrine = await loadDoctrine();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function operator(request: Request): Promise<TrustedOperatorIdentity | undefined> {
  return Promise.resolve(
    request.headers.get("authorization") === "Bearer operator-secret"
      ? { operatorId: "operator-james" }
      : undefined,
  );
}

function actionRequest() {
  return {
    id: "approval-request-1",
    principal: { kind: "captain", id: "captain-main" },
    action: "github.pr.merge",
    resource: { type: "pull_request", id: "184", repository: "acme/example" },
    context: {
      missionId: "mission-approval",
      risk: "low",
      checksPassed: true,
      humanApprovals: 0,
      profileHash: doctrine.profileHash,
    },
  } as const;
}

describe("control-plane approval surface", () => {
  it("persists, authenticates, decides, replays, and reconnects without duplication", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-approvals-"));
    tempDirs.push(root);
    const storePath = join(root, "events.db");
    const store = new SqliteEventStore(storePath);
    let id = 0;
    const app = await createControlPlane({
      doctrine,
      eventStore: store,
      authenticateOperator: operator,
      clock: () => new Date(`2026-07-11T21:0${String(id)}:00.000Z`),
      idFactory: () => `approval-event-${String(++id)}`,
    });

    const requestPolicy = () =>
      app.request("/v1/actions/decide", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(actionRequest()),
      });
    const policies = await Promise.all([requestPolicy(), requestPolicy()]);
    expect(policies.map((response) => response.status)).toEqual([200, 200]);
    await expect(policies[0]?.json()).resolves.toMatchObject({ effect: "require_approval" });

    expect((await app.request("/v1/approvals?status=pending")).status).toBe(401);
    const pending = await app.request("/v1/approvals?status=pending", {
      headers: { authorization: "Bearer operator-secret" },
    });
    expect(pending.status).toBe(200);
    await expect(pending.json()).resolves.toMatchObject([
      {
        id: "approval-request-1",
        status: "pending",
        action: "github.pr.merge",
        rationale: { effect: "require_approval" },
      },
    ]);

    const decide = () =>
      app.request("/v1/approvals/approval-request-1/decision", {
        method: "POST",
        headers: {
          authorization: "Bearer operator-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ decision: "approve", reason: "Checks and diff reviewed." }),
      });
    const decisions = await Promise.all([decide(), decide()]);
    expect(decisions.map((response) => response.status)).toEqual([200, 200]);
    const approvedBody = await decisions[0]?.json();
    expect(approvedBody).toMatchObject({
      status: "approved",
      decidedBy: "operator-james",
      reason: "Checks and diff reviewed.",
    });
    await expect(decisions[1]?.json()).resolves.toEqual(approvedBody);
    expect(
      (
        await app.request("/v1/approvals?status=pending", {
          headers: { authorization: "Bearer operator-secret" },
        })
      ).json(),
    ).resolves.toEqual([]);
    expect(
      (
        await app.request("/v1/approvals/approval-request-1/decision", {
          method: "POST",
          headers: {
            authorization: "Bearer operator-secret",
            "content-type": "application/json",
          },
          body: JSON.stringify({ decision: "deny", reason: "Changed my mind." }),
        })
      ).status,
    ).toBe(409);

    const events = await store.readAll();
    expect(events.filter(({ event }) => event.type === "approval.requested")).toHaveLength(1);
    expect(events.filter(({ event }) => event.type === "approval.decided")).toHaveLength(1);
    store.close();

    const reopened = new SqliteEventStore(storePath);
    const restarted = await createControlPlane({
      doctrine,
      eventStore: reopened,
      authenticateOperator: operator,
    });
    const afterRestart = await restarted.request("/v1/approvals?status=approved", {
      headers: { authorization: "Bearer operator-secret" },
    });
    await expect(afterRestart.json()).resolves.toEqual([approvedBody]);
    reopened.close();
  });

  it("fails closed when no authenticated operator surface is configured", async () => {
    const app = await createControlPlane({ doctrine });
    expect((await app.request("/v1/approvals?status=pending")).status).toBe(503);
  });

  it("re-consults an approved request once through the policy path without executing it", async () => {
    const approvalDoctrine = compileDoctrine([
      {
        ...doctrine.profile,
        id: "approval-consumption-test",
        actions: {
          ...doctrine.profile.actions,
          "github.pr.open": {
            default: "require_approval",
            rules: [
              {
                id: "operator-approved-open",
                effect: "allow",
                when: { minHumanApprovals: 1, checksPassed: true },
                obligations: [],
                reason: "The authenticated operator approved this exact request.",
              },
            ],
          },
        },
      },
    ]);
    const root = await mkdtemp(join(tmpdir(), "clankie-approval-consume-"));
    tempDirs.push(root);
    const store = new SqliteEventStore(join(root, "events.db"));
    const identity = {
      missionId: "mission-consume",
      taskId: "integrate",
      workerRunId: "worker-consume",
      correlationId: "correlation-consume",
      profileHash: approvalDoctrine.profileHash,
    };
    const classification = createConnectorActionClassifier([
      { action: "github.pr.open", riskClass: "reversible-write" },
    ]);
    const issued: Array<Parameters<CapabilityBroker["issue"]>[0]> = [];
    const broker: CapabilityBroker = {
      issue(grant) {
        issued.push(structuredClone(grant));
        return Promise.resolve("opaque-capability");
      },
      authorizeUse() {
        return Promise.resolve({ allowed: false, reason: "not exercised" });
      },
    };
    const app = await createControlPlane({
      doctrine: approvalDoctrine,
      eventStore: store,
      authenticateOperator: operator,
      authenticateWorker: () => Promise.resolve(identity),
      resolveActionContext: () =>
        Promise.resolve({ risk: "low" as const, checksPassed: true, humanApprovals: 0 }),
      classifyConnectorAction: (request) => classification(request.action),
      capabilityBroker: broker,
    });
    const path = `/v1/workers/${identity.workerRunId}/capabilities`;
    const body = JSON.stringify({
      request: {
        id: "consume-once",
        action: "github.pr.open",
        resource: { type: "pull_request", id: "184", repository: "acme/example" },
      },
    });
    const capability = () =>
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

    expect((await capability()).status).toBe(403);
    const decision = await app.request("/v1/approvals/consume-once/decision", {
      method: "POST",
      headers: { authorization: "Bearer operator-secret", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", reason: "Reviewed the exact PR request." }),
    });
    expect(decision.status).toBe(200);
    expect((await capability()).status).toBe(201);
    expect(issued).toHaveLength(1);
    expect((await capability()).status).toBe(409);
    expect(issued).toHaveLength(1);
    expect(
      (await store.readAll()).filter(
        ({ event }) => event.type === "approval.decided" && event.data.consumedAt !== undefined,
      ),
    ).toHaveLength(1);
    store.close();
  });
});
