import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  compileDoctrine,
  createConnectorActionClassifier,
  loadDoctrineFile,
  type CompiledDoctrine,
} from "@sapling/doctrine";
import { SqliteEventStore } from "@sapling/event-store";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createControlPlane,
  type CapabilityBroker,
  type ConnectorActionClassifier,
  type GithubConnector,
  type GithubConnectorOperation,
  type TrustedWorkerIdentity,
} from "../src/app.ts";

let app: Awaited<ReturnType<typeof createControlPlane>>;
let doctrine: CompiledDoctrine;
let profileHash: string;

beforeAll(async () => {
  const profilePath = resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml");
  doctrine = compileDoctrine([await loadDoctrineFile(profilePath)]);
  profileHash = doctrine.profileHash;
  trustedWorker = {
    missionId: "mission-capability",
    taskId: "task-capability",
    workerRunId: "worker-run-capability",
    correlationId: "correlation-capability",
    profileHash,
  };
  app = await createControlPlane({ doctrine });
});

describe("control plane", () => {
  it("reports the compiled doctrine and persists a mission draft", async () => {
    const health = await app.request("/health");
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({
      ok: true,
      doctrine: "self-build-lab",
      profileHash,
    });

    const created = await app.request("/v1/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "Prove the lead-agent loop", context: { source: "test" } }),
    });
    expect(created.status).toBe(201);
    const { missionId } = (await created.json()) as { missionId: string };

    const fetched = await app.request(`/v1/missions/${missionId}`);
    expect(fetched.status).toBe(200);
    await expect(fetched.json()).resolves.toMatchObject({
      id: missionId,
      goal: "Prove the lead-agent loop",
      state: "draft",
    });
  });

  it("denies stale doctrine requests and gates merges under the active doctrine", async () => {
    const baseRequest = {
      id: "action-1",
      principal: { kind: "captain", id: "captain-main" },
      action: "github.pr.merge",
      resource: { type: "pull_request", id: "184", repository: "acme/example" },
      context: {
        missionId: "mission-test",
        risk: "low",
        checksPassed: true,
        humanApprovals: 1,
        profileHash,
      },
    } as const;

    const active = await app.request("/v1/actions/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseRequest),
    });
    expect(active.status).toBe(200);
    await expect(active.json()).resolves.toMatchObject({ effect: "require_approval" });

    const stale = await app.request("/v1/actions/decide", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...baseRequest,
        id: "action-2",
        context: { ...baseRequest.context, profileHash: "stale-profile" },
      }),
    });
    expect(stale.status).toBe(200);
    await expect(stale.json()).resolves.toMatchObject({
      effect: "deny",
      matchedPolicyIds: ["stale-doctrine"],
    });
  });

  it("rebuilds mission records from the SQLite event store after a restart", async () => {
    const storePath = join(await mkdtemp(join(tmpdir(), "sapling-control-plane-")), "events.db");
    const store = new SqliteEventStore(storePath);
    const durable = await createControlPlane({ doctrine, eventStore: store });

    const created = await durable.request("/v1/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "Survive a restart", context: { source: "test" } }),
    });
    expect(created.status).toBe(201);
    const { missionId } = (await created.json()) as { missionId: string };

    const plan = {
      missionId,
      goal: "Survive a restart",
      rationale: "Restart-recovery coverage for the durable event store.",
      tasks: [
        {
          id: "t-1",
          title: "Prove durability",
          objective: "Confirm the mission record survives a control-plane restart.",
          kind: "verification",
          role: "verifier",
          successCriteria: ["The mission and its plan are rebuilt from the event log."],
          evidenceRequirements: ["The replayed mission matches the stored plan."],
        },
      ],
      successCriteria: ["Mission state is identical after restart."],
      profileHash,
    };
    const planned = await durable.request(`/v1/missions/${missionId}/plan`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(plan),
    });
    expect(planned.status).toBe(200);
    store.close();

    const reopenedStore = new SqliteEventStore(storePath);
    const restarted = await createControlPlane({ doctrine, eventStore: reopenedStore });
    const fetched = await restarted.request(`/v1/missions/${missionId}`);
    expect(fetched.status).toBe(200);
    const record = (await fetched.json()) as Record<string, unknown>;
    expect(record).toMatchObject({ id: missionId, goal: "Survive a restart", state: "planned" });
    expect((record.plan as { tasks: unknown[] }).tasks).toHaveLength(1);
    expect(await reopenedStore.verify()).toMatchObject({ valid: true, count: 2 });
    reopenedStore.close();
  });
});

let trustedWorker: TrustedWorkerIdentity;

function capabilityAction(action: string) {
  return {
    id: `request-${action}`,
    action,
    resource: {
      type: "pull_request",
      id: "184",
      repository: "acme/example",
      ...(action.startsWith("deployment.") ? { environment: "production" } : {}),
    },
  };
}

const resolveTrustedActionContext = () =>
  Promise.resolve({ risk: "low" as const, checksPassed: true, humanApprovals: 1 });

const classifyMetadata = createConnectorActionClassifier([
  { action: "github.pr.open", riskClass: "reversible-write" },
  { action: "github.pr.merge", riskClass: "irreversible-write" },
  { action: "deployment.production.create", riskClass: "irreversible-write" },
  { action: "package.release.publish", riskClass: "publish-external" },
  { action: "unreal.scene.delete", riskClass: "destructive" },
  { action: "vcs.push.main", riskClass: "publish-external" },
]);
const classifyConnectorAction = ((request) =>
  classifyMetadata(request.action)) satisfies ConnectorActionClassifier;

class RecordingCapabilityBroker implements CapabilityBroker {
  public readonly issued: Array<Parameters<CapabilityBroker["issue"]>[0]> = [];
  public readonly issueContexts: Array<Parameters<CapabilityBroker["issue"]>[1]> = [];
  public readonly uses: Array<Parameters<CapabilityBroker["authorizeUse"]>[0]> = [];
  private readonly grants = new Map<string, Parameters<CapabilityBroker["issue"]>[0]>();

  public issue(
    grant: Parameters<CapabilityBroker["issue"]>[0],
    context: Parameters<CapabilityBroker["issue"]>[1],
  ): Promise<string> {
    const token = `signed-${grant.grantId}`;
    this.issued.push(structuredClone(grant));
    this.issueContexts.push(structuredClone(context));
    this.grants.set(token, structuredClone(grant));
    return Promise.resolve(token);
  }

  public authorizeUse(
    request: Parameters<CapabilityBroker["authorizeUse"]>[0],
    _context: Parameters<CapabilityBroker["authorizeUse"]>[1],
    nowEpochSeconds?: number,
  ): Promise<{ allowed: boolean; reason: string; grant?: { obligations: string[] } }> {
    this.uses.push(structuredClone(request));
    const grant = this.grants.get(request.token);
    const allowed =
      grant !== undefined &&
      grant.capabilities.includes(request.capability) &&
      request.resource !== undefined &&
      grant.resources.includes(request.resource) &&
      (nowEpochSeconds ?? 0) < grant.expiresAt;
    if (allowed) this.grants.delete(request.token);
    return Promise.resolve(
      allowed
        ? { allowed, reason: "allowed", grant: { obligations: grant.obligations } }
        : { allowed, reason: "capability_not_granted" },
    );
  }
}

class RecordingGithubConnector implements GithubConnector {
  public readonly operations: GithubConnectorOperation[] = [];

  public execute(operation: GithubConnectorOperation): Promise<void> {
    this.operations.push(structuredClone(operation));
    return Promise.resolve();
  }
}

describe("worker capability exchange", () => {
  it("issues and consumes an audited, time-boxed GitHub capability without exposing credentials", async () => {
    const broker = new RecordingCapabilityBroker();
    const connector = new RecordingGithubConnector();
    let nextId = 0;
    const exchange = await createControlPlane({
      doctrine,
      capabilityBroker: broker,
      classifyConnectorAction,
      githubConnector: connector,
      resolveActionContext: resolveTrustedActionContext,
      authenticateWorker: (request) =>
        Promise.resolve(
          request.headers.get("authorization") === "Bearer runner-session" ? trustedWorker : undefined,
        ),
      clock: () => new Date("2026-07-11T05:00:00.000Z"),
      idFactory: () => `id-${String(++nextId)}-long-enough`,
    });
    const request = capabilityAction("github.pr.open");

    const issued = await exchange.request(`/v1/workers/${trustedWorker.workerRunId}/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer runner-session" },
      body: JSON.stringify({ request, ttlSeconds: 60 }),
    });
    expect(issued.status).toBe(201);
    const issuedBody = (await issued.json()) as {
      token: string;
      grant: { issuedAt: number; expiresAt: number };
    };
    expect(issuedBody.grant.expiresAt - issuedBody.grant.issuedAt).toBe(60);
    expect(broker.issued).toHaveLength(1);
    expect(broker.issueContexts[0]).toMatchObject({
      missionId: trustedWorker.missionId,
      taskId: trustedWorker.taskId,
      workerRunId: trustedWorker.workerRunId,
      profileHash,
    });

    const executed = await exchange.request(
      `/v1/workers/${trustedWorker.workerRunId}/connectors/github/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer runner-session" },
        body: JSON.stringify({ token: issuedBody.token, request }),
      },
    );
    expect(executed.status).toBe(200);
    await expect(executed.json()).resolves.toEqual({
      result: { accepted: true, operationId: "github-operation-id-3-long-enough" },
    });
    expect(broker.uses).toHaveLength(1);
    expect(connector.operations).toEqual([
      {
        operationId: "github-operation-id-3-long-enough",
        action: "github.pr.open",
        resource: request.resource,
        missionId: trustedWorker.missionId,
        taskId: trustedWorker.taskId,
        workerRunId: trustedWorker.workerRunId,
        correlationId: trustedWorker.correlationId,
        obligations: [],
      },
    ]);
    expect(JSON.stringify(connector.operations)).not.toMatch(/credential|token|secret|environment/iu);
  });

  it("refuses merge, deploy, and publish capabilities without an allow decision", async () => {
    const broker = new RecordingCapabilityBroker();
    const exchange = await createControlPlane({
      doctrine,
      capabilityBroker: broker,
      classifyConnectorAction,
      resolveActionContext: resolveTrustedActionContext,
      authenticateWorker: () => Promise.resolve(trustedWorker),
    });

    for (const action of ["github.pr.merge", "deployment.production.create", "package.release.publish"]) {
      const response = await exchange.request(`/v1/workers/${trustedWorker.workerRunId}/capabilities`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ request: capabilityAction(action) }),
      });
      expect(response.status, action).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ error: "capability_not_allowed" });
    }
    expect(broker.issued).toEqual([]);
  });

  it("uses trusted connector metadata and ignores worker-supplied risk classification", async () => {
    const broker = new RecordingCapabilityBroker();
    const exchange = await createControlPlane({
      doctrine,
      capabilityBroker: broker,
      classifyConnectorAction,
      resolveActionContext: resolveTrustedActionContext,
      authenticateWorker: () => Promise.resolve(trustedWorker),
    });
    const request = capabilityAction("unreal.scene.delete");
    const response = await exchange.request(`/v1/workers/${trustedWorker.workerRunId}/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: { ...request, riskClass: "read" } }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "capability_not_allowed",
      decision: {
        effect: "require_approval",
        matchedPolicyIds: ["risk-class:destructive:default"],
      },
    });
    expect(broker.issued).toEqual([]);
  });

  it("applies publish-external floor to rawdog push-main capabilities", async () => {
    const rawdog = compileDoctrine([
      await loadDoctrineFile(resolve(import.meta.dirname, "../../../doctrine/profiles/rawdog.yaml")),
    ]);
    const identity = { ...trustedWorker, profileHash: rawdog.profileHash };
    const broker = new RecordingCapabilityBroker();
    const exchange = await createControlPlane({
      doctrine: rawdog,
      capabilityBroker: broker,
      classifyConnectorAction,
      resolveActionContext: resolveTrustedActionContext,
      authenticateWorker: () => Promise.resolve(identity),
    });
    const response = await exchange.request(`/v1/workers/${identity.workerRunId}/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request: capabilityAction("vcs.push.main") }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      decision: {
        effect: "require_approval",
        matchedPolicyIds: ["vcs.push.main:default", "invariant-floor:human-approval"],
      },
    });
    expect(broker.issued).toEqual([]);
  });

  it("binds the request to authenticated runner identity and exact GitHub scope", async () => {
    const broker = new RecordingCapabilityBroker();
    const connector = new RecordingGithubConnector();
    const exchange = await createControlPlane({
      doctrine,
      capabilityBroker: broker,
      classifyConnectorAction,
      githubConnector: connector,
      resolveActionContext: resolveTrustedActionContext,
      authenticateWorker: (request) =>
        Promise.resolve(request.headers.has("authorization") ? trustedWorker : undefined),
      clock: () => new Date("2026-07-11T05:00:00.000Z"),
      idFactory: () => "fixed-id-long-enough",
    });
    const request = capabilityAction("github.pr.open");

    const unauthenticated = await exchange.request(`/v1/workers/${trustedWorker.workerRunId}/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request }),
    });
    expect(unauthenticated.status).toBe(401);

    const forged = await exchange.request("/v1/workers/other-run/capabilities", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "present" },
      body: JSON.stringify({ request }),
    });
    expect(forged.status).toBe(403);
    expect(broker.issued).toEqual([]);

    const overlong = await exchange.request(`/v1/workers/${trustedWorker.workerRunId}/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "present" },
      body: JSON.stringify({ request, ttlSeconds: 901 }),
    });
    expect(overlong.status).toBe(400);
    expect(broker.issued).toEqual([]);

    const issued = await exchange.request(`/v1/workers/${trustedWorker.workerRunId}/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "present" },
      body: JSON.stringify({ request }),
    });
    const { token } = (await issued.json()) as { token: string };
    const widened = await exchange.request(
      `/v1/workers/${trustedWorker.workerRunId}/connectors/github/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "present" },
        body: JSON.stringify({
          token,
          request: { ...request, resource: { ...request.resource, id: "185" } },
        }),
      },
    );
    expect(widened.status).toBe(403);
    await expect(widened.json()).resolves.toMatchObject({ error: "capability_use_denied" });
    expect(connector.operations).toEqual([]);
  });

  it("ignores forged policy facts and carries trusted allow obligations into execution", async () => {
    const obligatedDoctrine = compileDoctrine([
      {
        ...doctrine.profile,
        id: "obligated-capability-test",
        actions: {
          ...doctrine.profile.actions,
          "github.pr.open": {
            default: "deny",
            rules: [
              {
                id: "approved-open",
                effect: "allow",
                when: { minHumanApprovals: 1, checksPassed: true },
                obligations: ["record_github_evidence"],
                reason: "Trusted checks and approval permit the operation.",
              },
            ],
          },
        },
      },
    ]);
    const obligatedIdentity = { ...trustedWorker, profileHash: obligatedDoctrine.profileHash };
    const deniedBroker = new RecordingCapabilityBroker();
    const denied = await createControlPlane({
      doctrine: obligatedDoctrine,
      capabilityBroker: deniedBroker,
      classifyConnectorAction,
      authenticateWorker: () => Promise.resolve(obligatedIdentity),
      resolveActionContext: () => Promise.resolve({ risk: "low", checksPassed: true, humanApprovals: 0 }),
    });
    const request = capabilityAction("github.pr.open");
    const forged = await denied.request(`/v1/workers/${obligatedIdentity.workerRunId}/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request: {
          ...request,
          principal: { kind: "human", id: "forged-human" },
          context: { risk: "low", checksPassed: true, humanApprovals: 999 },
        },
      }),
    });
    expect(forged.status).toBe(403);
    expect(deniedBroker.issued).toEqual([]);

    const broker = new RecordingCapabilityBroker();
    const connector = new RecordingGithubConnector();
    const allowed = await createControlPlane({
      doctrine: obligatedDoctrine,
      capabilityBroker: broker,
      classifyConnectorAction,
      githubConnector: connector,
      authenticateWorker: () => Promise.resolve(obligatedIdentity),
      resolveActionContext: () => Promise.resolve({ risk: "low", checksPassed: true, humanApprovals: 1 }),
    });
    const issueResponse = await allowed.request(`/v1/workers/${obligatedIdentity.workerRunId}/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request }),
    });
    expect(issueResponse.status).toBe(201);
    expect(broker.issued[0]?.obligations).toEqual(["record_github_evidence"]);
    const { token } = (await issueResponse.json()) as { token: string };
    const executeResponse = await allowed.request(
      `/v1/workers/${obligatedIdentity.workerRunId}/connectors/github/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, request }),
      },
    );
    expect(executeResponse.status).toBe(200);
    expect(connector.operations[0]?.obligations).toEqual(["record_github_evidence"]);
  });

  it("rejects malformed JSON and secret-bearing connector results", async () => {
    const broker = new RecordingCapabilityBroker();
    const exchange = await createControlPlane({
      doctrine,
      capabilityBroker: broker,
      classifyConnectorAction,
      authenticateWorker: () => Promise.resolve(trustedWorker),
      resolveActionContext: resolveTrustedActionContext,
      githubConnector: {
        execute: (() =>
          Promise.resolve({
            credential: "ghp_ENV_SECRET_MUST_NOT_LEAK",
          })) as unknown as GithubConnector["execute"],
      },
    });
    const request = capabilityAction("github.pr.open");

    const malformedCapability = await exchange.request(
      `/v1/workers/${trustedWorker.workerRunId}/capabilities`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      },
    );
    expect(malformedCapability.status).toBe(400);
    expect(broker.issued).toEqual([]);

    const issued = await exchange.request(`/v1/workers/${trustedWorker.workerRunId}/capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request }),
    });
    const { token } = (await issued.json()) as { token: string };

    const malformedUse = await exchange.request(
      `/v1/workers/${trustedWorker.workerRunId}/connectors/github/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      },
    );
    expect(malformedUse.status).toBe(400);
    expect(broker.uses).toEqual([]);

    const executed = await exchange.request(
      `/v1/workers/${trustedWorker.workerRunId}/connectors/github/execute`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, request }),
      },
    );
    expect(executed.status).toBe(502);
    const responseText = await executed.text();
    expect(responseText).toBe('{"error":"invalid_connector_result"}');
    expect(responseText).not.toContain("ghp_ENV_SECRET_MUST_NOT_LEAK");
  });
});
