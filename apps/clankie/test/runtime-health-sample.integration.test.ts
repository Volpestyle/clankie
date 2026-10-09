import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { createRuntimeHealthSampler } from "../src/runtime-health-sample.ts";

const runtime = {
  root: "/owned/runtime",
  commit: "a".repeat(40),
  instanceId: randomUUID(),
  pid: process.pid,
};
const health = { ok: true, service: "clankie", runtime };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Real loopback HTTP exercises transport, untrusted response bounds and boot identity. */
async function listener(handle: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handle);
  let connections = 0;
  server.on("connection", () => connections++);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address() as AddressInfo;
  return {
    healthUrl: `http://127.0.0.1:${address.port}/health`,
    connections: () => connections,
  };
}

it("uses a fresh metadata-only HTTP connection after idle, and retains process-bound CPU and full response timing", async () => {
  const requests: {
    url: string | undefined;
    authorization: string | undefined;
    connection: string | undefined;
  }[] = [];
  const host = await listener((request, response) => {
    requests.push({
      url: request.url,
      authorization: request.headers.authorization,
      connection: request.headers.connection,
    });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(health));
  });
  const sample = createRuntimeHealthSampler(host);
  const first = await sample(runtime);
  await sleep(50);
  const second = await sample(runtime);
  expect(host.connections()).toBe(2);
  expect(requests).toEqual([
    { url: "/health", authorization: undefined, connection: "close" },
    { url: "/health", authorization: undefined, connection: "close" },
  ]);
  expect(first.runtime).toEqual(runtime);
  expect(second.runtime).toEqual(runtime);
  expect(second.cpuPercent).toBeGreaterThanOrEqual(0);
  expect(second.intervalMs).toBeGreaterThanOrEqual(50);
  expect(second.healthLatencyMs).toBeGreaterThan(0);
  await expect(sample({ ...runtime, pid: process.pid + 1 })).rejects.toThrow(
    "runtime-health-cpu-identity-mismatch",
  );
  expect(host.connections()).toBe(2);
});

it.each([302, 503])("rejects HTTP %i without following redirects", async (status) => {
  let requests = 0;
  const host = await listener((_request, response) => {
    requests++;
    response.writeHead(status, { location: "/unexpected" });
    response.end(JSON.stringify(health));
  });
  await expect(createRuntimeHealthSampler(host)(runtime)).rejects.toThrow("runtime-health-http-unhealthy");
  expect(requests).toBe(1);
});

it("rejects an oversized response while reading the real HTTP stream", async () => {
  const host = await listener((_request, response) => response.end(" ".repeat(32_769)));
  await expect(createRuntimeHealthSampler(host)(runtime)).rejects.toThrow(
    "runtime-health-response-too-large",
  );
});

it("bounds the entire response body with the probe timeout", async () => {
  const host = await listener((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write("{");
  });
  await expect(createRuntimeHealthSampler({ ...host, timeoutMs: 50 })(runtime)).rejects.toMatchObject({
    code: "ABORT_ERR",
  });
});

it.each([
  { ...runtime, root: "/different/runtime" },
  { ...runtime, commit: "b".repeat(40) },
  { ...runtime, instanceId: randomUUID() },
  { ...runtime, pid: process.pid + 1 },
])("rejects a response belonging to another boot: %j", async (other) => {
  const host = await listener((_request, response) =>
    response.end(JSON.stringify({ ...health, runtime: other })),
  );
  const field = (["root", "commit", "instanceId", "pid"] as const).find(
    (key) => runtime[key] !== other[key],
  )!;
  await expect(createRuntimeHealthSampler(host)(runtime)).rejects.toMatchObject({
    message: "runtime-health-boot-identity-mismatch",
    diagnostic: `runtime-health-boot-identity-mismatch: ${field} expected=${JSON.stringify(runtime[field])} actual=${JSON.stringify(other[field])}`,
  });
});
