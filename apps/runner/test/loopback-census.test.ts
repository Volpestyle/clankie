import type { AgentCensus } from "@clankie/protocol";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentCensusPort } from "../src/agent-census.ts";
import {
  agentCensusCapability,
  createLoopbackGateway,
  type LoopbackGateway,
} from "../src/loopback-gateway.ts";

const gateways: LoopbackGateway[] = [];

afterEach(async () => {
  await Promise.all(gateways.splice(0).map((gateway) => gateway.close()));
});

const emptyCensus: AgentCensus = {
  schemaVersion: 1,
  runnerId: "local",
  takenAt: "2026-08-07T00:00:00.000Z",
  transportAvailable: true,
  entries: [],
  counts: { owned: 0, adopted: 0, lapsed: 0, unclaimed: 0 },
  truncated: 0,
};

function stubPort(overrides: Partial<AgentCensusPort> = {}): AgentCensusPort & { adopted: unknown[] } {
  const adopted: unknown[] = [];
  return {
    adopted,
    census: () => Promise.resolve(emptyCensus),
    adopt: (request) => {
      adopted.push(request);
      return Promise.resolve({ outcome: "adopted" });
    },
    release: () => Promise.resolve(),
    direct: () => Promise.resolve({ outcome: "refused", reason: "unknown_adoption" }),
    ...overrides,
  };
}

async function openGateway(agents: AgentCensusPort): Promise<string> {
  const gateway = await createLoopbackGateway({ token: "secret", port: 0 });
  gateway.register(agentCensusCapability(agents));
  gateways.push(gateway);
  return `http://${gateway.address.host}:${String(gateway.address.port)}`;
}

describe("agent census gateway", () => {
  it("refuses to bind anything but exact loopback", async () => {
    await expect(
      createLoopbackGateway({ token: "secret", bindHost: "0.0.0.0", port: 0 }),
    ).rejects.toThrow(/exact loopback/);
  });

  it("is bearer-gated and no-store", async () => {
    const base = await openGateway(stubPort());

    expect((await fetch(`${base}/v1/agents/census`)).status).toBe(401);
    const response = await fetch(`${base}/v1/agents/census`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ census: emptyCensus });
  });

  it("rejects a token of the same length but different bytes", async () => {
    const base = await openGateway(stubPort());

    const response = await fetch(`${base}/v1/agents/census`, {
      headers: { authorization: "Bearer secrxt" },
    });

    expect(response.status).toBe(401);
  });

  it("validates an adoption request before it reaches the store", async () => {
    const port = stubPort();
    const base = await openGateway(port);

    const rejected = await fetch(`${base}/v1/agents/adopt`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, transport: "smoke-signal", terminalId: "t" }),
    });

    expect(rejected.status).toBe(400);
    expect(port.adopted).toEqual([]);
  });

  it("passes a well-formed adoption through and returns its typed result", async () => {
    const port = stubPort({
      adopt: () => Promise.resolve({ outcome: "refused", reason: "already_adopted" }),
    });
    const base = await openGateway(port);

    const response = await fetch(`${base}/v1/agents/adopt`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        transport: "herdr",
        transportInstanceId: "default",
        terminalId: "term_a",
        workspaceId: "workspace-a",
        grade: "directed",
        writeScope: ["apps/**"],
        adoptedBy: { kind: "operator", id: "james" },
        approval: {
          receiptId: "approval-1",
          approvedBy: { kind: "operator", id: "james" },
          approvedAt: "2026-08-07T00:00:00.000Z",
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { outcome: "refused", reason: "already_adopted" } });
  });

  it("exposes no steering or terminal route", async () => {
    const base = await openGateway(stubPort());

    for (const path of ["/v1/agents/steer", "/v1/terminals", "/v1/agents"]) {
      const response = await fetch(`${base}${path}`, { headers: { authorization: "Bearer secret" } });
      expect(response.status).toBe(404);
    }
  });

  it("refuses a write on the census route", async () => {
    const base = await openGateway(stubPort());

    const response = await fetch(`${base}/v1/agents/census`, {
      method: "POST",
      headers: { authorization: "Bearer secret" },
    });

    expect(response.status).toBe(405);
  });
});
