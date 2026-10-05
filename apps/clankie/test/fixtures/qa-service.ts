import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createClankieApp } from "../../src/app.ts";
import { FileCredentialStore } from "@clankie/credential-broker";
import { createCredentialBackedOperatorAuthenticator } from "../../src/operator-auth.ts";
import { createStubCaptain } from "../../src/captain/port.ts";

/** Real loopback HTTP and durable device state, with no model or operator configuration. */
export async function createQaService() {
  const root = await mkdtemp(join(tmpdir(), "clankie-qa-"));
  const operatorToken = randomBytes(24).toString("hex");
  const deviceSessionKey = randomBytes(32);
  const eventLogPath = join(root, "events.jsonl");
  let now = Date.parse("2026-09-01T12:00:00Z");
  const boot = () =>
    createClankieApp({
      captain: createStubCaptain(),
      deviceSessionKey,
      eventLogPath,
      clock: () => new Date(now),
      hostDisplayName: "QA host",
      authenticateOperator: createCredentialBackedOperatorAuthenticator({
        env: { CLANKIE_OPERATOR_TOKEN: operatorToken },
        store: new FileCredentialStore(join(root, "credentials.json")),
        identity: { operatorId: "qa-operator" },
      }),
    });
  let service: Awaited<ReturnType<typeof createClankieApp>>;
  try {
    service = await boot();
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const server = serve({ fetch: (request) => service.app.fetch(request), hostname: "127.0.0.1", port: 0 });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
  } catch (error) {
    service.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("QA server has no TCP address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    operatorToken,
    eventLogPath,
    now: () => now,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    async operator(path: string, body: unknown = {}) {
      return fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${operatorToken}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
    },
    async restart() {
      service.close();
      service = await boot();
    },
    async close() {
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          if ("closeAllConnections" in server) server.closeAllConnections();
        });
      } finally {
        service.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}
