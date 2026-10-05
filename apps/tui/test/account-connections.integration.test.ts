import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { runAccountsCommand } from "../src/command/accounts.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("hands a stdin-only Linear code to the authenticated HTTP body API and refuses malformed or secret-bearing responses", async () => {
  const seen: { path: string; body: string; authorization: string | undefined }[] = [];
  const state = "s".repeat(24);
  const marker = "fixture-private-code-never-output";
  let unsafe = false;
  const server: Server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    seen.push({ path: request.url ?? "", body, authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        unsafe
          ? { ok: true, access_token: marker }
          : {
              ok: true,
              connection: {
                provider: "linear",
                status: "connected",
                actor: "app",
                scopes: ["read", "write"],
              },
            },
      ),
    );
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const env = {
    CLANKIE_OPERATOR_TOKEN: "fixture-owner",
    CLANKIE_CONTROL_PLANE_URL: `http://127.0.0.1:${address.port}`,
  };
  const run = (input: string) =>
    runAccountsCommand(["complete", "linear", "--json-stdin"], { env, stdin: Readable.from([input]) });
  const result = await run(JSON.stringify({ state, code: marker }));
  expect(result).toMatchObject({ ok: true, connection: { scopes: ["read", "write"] } });
  expect(JSON.stringify(result)).not.toContain(marker);
  expect(seen).toEqual([
    {
      path: "/v1/accounts/linear/complete",
      body: JSON.stringify({ state, code: marker }),
      authorization: "Bearer fixture-owner",
    },
  ]);
  for (const input of [
    marker,
    JSON.stringify({ state, code: "" }),
    JSON.stringify({ state, code: marker, access_token: marker }),
  ])
    await expect(run(input)).rejects.toThrow("Invalid Linear authorization response");
  expect(seen).toHaveLength(1);
  unsafe = true;
  await expect(run(JSON.stringify({ state, code: marker }))).rejects.toThrow(
    "Account connection unavailable",
  );
});

it("stores the developer GitHub revocation secret only in the body broker, bound to the configured app ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "github-revoke-cli-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const credentials = new FileCredentialStore(join(directory, "broker.json"));
  const secret = "fixture-developer-secret-never-output";
  const result = await runAccountsCommand(
    ["apps", "github-secret", "--client-id", "fixture-app", "--secret-stdin"],
    {
      env: { CLANKIE_OPERATOR_TOKEN: "fixture-owner" },
      credentials,
      stdin: Readable.from([secret]),
    },
  );
  expect(await credentials.get("github-oauth-app")).toEqual({
    type: "api",
    key: secret,
    metadata: { clientId: "fixture-app" },
  });
  expect(result).toEqual({ ok: true, provider: "github", revocation: "configured" });
  expect(JSON.stringify(result)).not.toContain(secret);
  await expect(
    runAccountsCommand(["apps", "github-secret", "--client-id", "fixture-app", "--secret-stdin"], {
      request: async () => {
        throw new Error("Must not dispatch");
      },
      credentials,
      stdin: Readable.from([secret]),
    }),
  ).rejects.toThrow("OAuth application configuration is managed by the hosted service");
});
