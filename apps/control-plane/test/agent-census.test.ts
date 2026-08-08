import { resolve } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import type {
  AdoptWorkerRequest,
  AdoptWorkerResult,
  AgentCensus,
  DirectAdoptedWorkerRequest,
  ReleaseWorkerAdoptionRequest,
} from "@clankie/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { createControlPlane, type TrustedOperatorIdentity } from "../src/app.ts";
import type { AgentCensusReadPort } from "../src/agent-census.ts";

const OPERATOR_HEADERS = { authorization: "Bearer operator-secret" };
const CAPTAIN_HEADERS = { authorization: "Bearer captain-secret" };
let doctrine: Awaited<ReturnType<typeof loadDoctrine>>;

async function loadDoctrine() {
  return compileDoctrine([
    await loadDoctrineFile(resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml")),
  ]);
}

beforeAll(async () => {
  doctrine = await loadDoctrine();
});

const census: AgentCensus = {
  schemaVersion: 1,
  runnerId: "local",
  takenAt: "2026-08-07T00:00:00.000Z",
  transportAvailable: true,
  entries: [
    {
      classification: "unclaimed",
      digest: {
        runnerObserved: {
          transport: "herdr",
          terminalId: "term_a",
          label: "A stranger",
          reportedStatus: "working",
          adoptable: true,
          harness: "codex",
          agentSessionId: "session-a",
        },
      },
    },
  ],
  counts: { owned: 0, adopted: 0, lapsed: 0, unclaimed: 1 },
  truncated: 0,
};

function stubCensusPort(): AgentCensusReadPort & {
  adopted: AdoptWorkerRequest[];
  released: string[];
  directed: DirectAdoptedWorkerRequest[];
} {
  const adopted: AdoptWorkerRequest[] = [];
  const released: string[] = [];
  const directed: DirectAdoptedWorkerRequest[] = [];
  return {
    adopted,
    released,
    directed,
    census: () => Promise.resolve(census),
    adopt: (request: AdoptWorkerRequest): Promise<AdoptWorkerResult> => {
      adopted.push(request);
      return Promise.resolve({
        outcome: "adopted",
        adoption: {
          schemaVersion: 1,
          adoptionId: "adopt-1",
          workerRunId: "run-1",
          grade: request.grade,
          state: "active",
          binding: {
            transport: "herdr",
            terminalId: request.terminalId,
            harness: "codex",
            agentSessionId: "session-a",
          },
          writeScope: [...request.writeScope],
          adoptedBy: request.adoptedBy,
          adoptedAt: "2026-08-07T00:00:00.000Z",
          updatedAt: "2026-08-07T00:00:00.000Z",
        },
      });
    },
    release: (request: ReleaseWorkerAdoptionRequest) => {
      released.push(request.adoptionId);
      return Promise.resolve();
    },
    direct: (request: DirectAdoptedWorkerRequest) => {
      directed.push(request);
      return Promise.resolve({
        outcome: "delivered" as const,
        adoptionId: request.adoptionId,
        workerRunId: "run-1",
      });
    },
  };
}

async function makeApp(agentCensus?: AgentCensusReadPort) {
  return createControlPlane({
    doctrine,
    authenticateOperator: (request: Request): Promise<TrustedOperatorIdentity | undefined> =>
      Promise.resolve(
        request.headers.get("authorization") === OPERATOR_HEADERS.authorization
          ? { operatorId: "operator-james" }
          : undefined,
      ),
    authenticateCaptain: (request: Request) =>
      Promise.resolve(
        request.headers.get("authorization") === CAPTAIN_HEADERS.authorization
          ? { captainId: "captain-test" }
          : undefined,
      ),
    ...(agentCensus ? { agentCensus } : {}),
  });
}

const adoptBody = (overrides: Partial<AdoptWorkerRequest> = {}): string =>
  JSON.stringify({
    schemaVersion: 1,
    transport: "herdr",
    terminalId: "term_a",
    grade: "observed",
    writeScope: [],
    adoptedBy: { kind: "captain", id: "eve" },
    ...overrides,
  });

describe("agent census routes", () => {
  it("requires authentication to see what is running", async () => {
    const app = await makeApp(stubCensusPort());

    const response = await app.request("/v1/agents/census");

    expect(response.status).toBe(401);
  });

  it("lets the captain read the census without an operator present", async () => {
    const app = await makeApp(stubCensusPort());

    const response = await app.request("/v1/agents/census", { headers: CAPTAIN_HEADERS });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ census });
  });

  it("reports an unwired runner instead of an empty machine", async () => {
    const app = await makeApp();

    const response = await app.request("/v1/agents/census", { headers: CAPTAIN_HEADERS });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "agent_census_unavailable" });
  });

  it("surfaces an upstream failure rather than a fabricated census", async () => {
    const port = stubCensusPort();
    const app = await makeApp({ ...port, census: () => Promise.reject(new Error("socket gone")) });

    const response = await app.request("/v1/agents/census", { headers: CAPTAIN_HEADERS });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "agent_census_upstream_failure" });
  });

  it("lets the captain adopt at observed grade", async () => {
    const port = stubCensusPort();
    const app = await makeApp(port);

    const response = await app.request("/v1/agents/adopt", {
      method: "POST",
      headers: { ...CAPTAIN_HEADERS, "content-type": "application/json" },
      body: adoptBody(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { outcome: "adopted" } });
    expect(port.adopted).toHaveLength(1);
  });

  it("refuses a directed adoption backed only by a captain token", async () => {
    const port = stubCensusPort();
    const app = await makeApp(port);

    const response = await app.request("/v1/agents/adopt", {
      method: "POST",
      headers: { ...CAPTAIN_HEADERS, "content-type": "application/json" },
      body: adoptBody({ grade: "directed", writeScope: ["apps/**"] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      result: { outcome: "refused", reason: "approval_required" },
    });
    // The refusal is decided before the runner is asked, so nothing was adopted.
    expect(port.adopted).toEqual([]);
  });

  it("allows a directed adoption backed by an operator", async () => {
    const port = stubCensusPort();
    const app = await makeApp(port);

    const response = await app.request("/v1/agents/adopt", {
      method: "POST",
      headers: { ...OPERATOR_HEADERS, "content-type": "application/json" },
      body: adoptBody({ grade: "directed", writeScope: ["apps/**"] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { outcome: "adopted" } });
    expect(port.adopted[0]?.grade).toBe("directed");
  });

  it("rejects a malformed adoption request", async () => {
    const port = stubCensusPort();
    const app = await makeApp(port);

    const response = await app.request("/v1/agents/adopt", {
      method: "POST",
      headers: { ...CAPTAIN_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, transport: "carrier-pigeon" }),
    });

    expect(response.status).toBe(400);
    expect(port.adopted).toEqual([]);
  });

  it("delivers bounded direction to an adopted agent", async () => {
    const port = stubCensusPort();
    const app = await makeApp(port);

    const response = await app.request("/v1/agents/direct", {
      method: "POST",
      headers: { ...CAPTAIN_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        adoptionId: "adopt-1",
        text: "check the failing migration first",
        directedBy: { kind: "captain", id: "eve" },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ result: { outcome: "delivered" } });
    expect(port.directed[0]?.text).toBe("check the failing migration first");
  });

  it("refuses unbounded direction text", async () => {
    const port = stubCensusPort();
    const app = await makeApp(port);

    const response = await app.request("/v1/agents/direct", {
      method: "POST",
      headers: { ...CAPTAIN_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        adoptionId: "adopt-1",
        text: "x".repeat(20_001),
        directedBy: { kind: "captain", id: "eve" },
      }),
    });

    expect(response.status).toBe(400);
    expect(port.directed).toEqual([]);
  });

  it("requires authentication to direct an agent", async () => {
    const port = stubCensusPort();
    const app = await makeApp(port);

    const response = await app.request("/v1/agents/direct", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        adoptionId: "adopt-1",
        text: "hello",
        directedBy: { kind: "captain", id: "eve" },
      }),
    });

    expect(response.status).toBe(401);
    expect(port.directed).toEqual([]);
  });

  it("releases an adoption", async () => {
    const port = stubCensusPort();
    const app = await makeApp(port);

    const response = await app.request("/v1/agents/release", {
      method: "POST",
      headers: { ...CAPTAIN_HEADERS, "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        adoptionId: "adopt-1",
        releasedBy: { kind: "captain", id: "eve" },
      }),
    });

    expect(response.status).toBe(200);
    expect(port.released).toEqual(["adopt-1"]);
  });
});
