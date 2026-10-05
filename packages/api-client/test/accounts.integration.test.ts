import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  AccountClientError,
  createAccountsClient,
  parseLinearAccountCallback,
  validateLinearAccountStart,
} from "../src/accounts.ts";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});
const state = "f".repeat(32);
const redirectUri = "https://api.clankie.bot/account/connections/callback";
const flow = {
  ok: true as const,
  flowId: state,
  redirectUri,
  expiresAt: "2099-01-01T00:00:00Z",
  authorizeUrl: `https://linear.app/oauth/authorize?${new URLSearchParams({ client_id: "fixture-client", redirect_uri: redirectUri, state, response_type: "code", scope: "read,write", actor: "app", code_challenge_method: "S256", code_challenge: "c".repeat(43) })}`,
};
async function fixture(handler: (path: string, body: string) => { status?: number; body: unknown }) {
  const seen: { path: string; body: string; authorization?: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const path = request.url ?? "/";
    seen.push({ path, body, authorization: request.headers.authorization });
    const result = handler(path, body);
    response.writeHead(result.status ?? 200, { "content-type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not listen");
  return { baseUrl: `http://127.0.0.1:${address.port}`, seen };
}

describe("body account client HTTP/schema boundary", () => {
  it("completes a valid PKCE callback once through the exact authenticated body routes and returns scopes only", async () => {
    let connected = false;
    const connection = () => ({
      provider: "linear",
      status: connected ? "connected" : "not_connected",
      scopes: connected ? ["read", "write"] : [],
    });
    const server = await fixture((path, body) => {
      if (path === "/v1/accounts") return { body: { connections: [connection()] } };
      if (path === "/v1/accounts/linear/start") return { body: flow };
      if (path === "/v1/accounts/linear/complete") {
        expect(JSON.parse(body)).toEqual({ state, code: "fixture-authorization-code" });
        connected = true;
        return { body: { ok: true, connection: connection() } };
      }
      connected = false;
      return { body: { ok: true, revoked: true } };
    });
    const client = createAccountsClient({
      baseUrl: server.baseUrl,
      authorization: () => "fixture-device-bearer",
    });
    expect((await client.list()).connections[0]?.status).toBe("not_connected");
    const start = await client.startLinear();
    if (!start.ok) throw new Error("Fixture start refused");
    validateLinearAccountStart(start);
    const callback = parseLinearAccountCallback(
      `clankie://accounts/linear/callback?state=${state}&code=fixture-authorization-code`,
      start,
    );
    if (!("code" in callback)) throw new Error("Fixture callback refused");
    expect(await client.completeLinear(callback.state, callback.code)).toMatchObject({
      ok: true,
      connection: { scopes: ["read", "write"] },
    });
    expect(await client.disconnect("linear")).toEqual({ ok: true, revoked: true });
    expect((await client.list()).connections[0]?.status).toBe("not_connected");
    expect(server.seen.map((request) => request.path)).toEqual([
      "/v1/accounts",
      "/v1/accounts/linear/start",
      "/v1/accounts/linear/complete",
      "/v1/accounts/disconnect",
      "/v1/accounts",
    ]);
    expect(server.seen.every((request) => request.authorization === "Bearer fixture-device-bearer")).toBe(
      true,
    );
  });

  it("refuses unsolicited, expired, duplicate and confused callbacks before any exchange", async () => {
    const server = await fixture(() => ({ body: flow }));
    const client = createAccountsClient({ baseUrl: server.baseUrl, authorization: () => "device" });
    const start = await client.startLinear();
    if (!start.ok) throw new Error("Fixture start refused");
    for (const callback of [
      `clankie://accounts/linear/callback?state=wrong&code=code`,
      `clankie://accounts/linear/callback?state=${state}&code=one&code=two`,
      `clankie://accounts/linear/callback?state=${state}&code=code&error=denied`,
      `clankie://pair/linear/callback?state=${state}&code=code`,
      `https://accounts/linear/callback?state=${state}&code=code`,
      `clankie://accounts/linear/callback?state=${state}&code=code#fragment`,
    ])
      expect(() => parseLinearAccountCallback(callback, start)).toThrow(AccountClientError);
    expect(() =>
      parseLinearAccountCallback(
        `clankie://accounts/linear/callback?state=${state}&code=code`,
        start,
        Date.parse(start.expiresAt),
      ),
    ).toThrow(AccountClientError);
    for (const authorizeUrl of [
      start.authorizeUrl.replace("linear.app", "evil.test"),
      `${start.authorizeUrl}&state=other`,
      `${start.authorizeUrl}&client_secret=secret-marker`,
      start.authorizeUrl.replace("S256", "plain"),
    ])
      expect(() => validateLinearAccountStart({ ...start, authorizeUrl })).toThrow(AccountClientError);
    expect(
      parseLinearAccountCallback(
        `clankie://accounts/linear/callback?state=${state}&error=access_denied&error_description=secret-marker`,
        start,
      ),
    ).toEqual({ state, error: "denied" });
    expect(server.seen).toHaveLength(1);
  });

  it("never exposes echoed credentials through HTTP errors or schema failures, and requires HTTP200 for a success", async () => {
    const marker = "gho_fixture_token_that_must_not_escape";
    for (const result of [
      { status: 401, body: { error: marker } },
      { status: 403, body: { error: marker } },
      { status: 502, body: { connections: [] } },
      { status: 201, body: { connections: [] } },
      { body: { connections: [], access_token: marker } },
      { body: { connections: [{ provider: "linear", status: "connected", scopes: [], token: marker }] } },
      { body: { echoed: marker.repeat(4096) } },
    ]) {
      const server = await fixture(() => result);
      const client = createAccountsClient({ baseUrl: server.baseUrl, authorization: () => "device" });
      try {
        await client.list();
        throw new Error("Unsafe response accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(AccountClientError);
        expect(String(error)).not.toContain(marker);
        expect(JSON.stringify(error)).not.toContain(marker);
      }
    }
  });

  it("refuses insecure, credential-bearing or unsealed gateway destinations before a request", () => {
    for (const baseUrl of [
      "http://lan.test",
      "https://user:secret@body.test",
      "https://body.test?code=secret",
      "https://api.clankie.bot",
      "https://body.test/unrelated",
    ]) {
      expect(() => createAccountsClient({ baseUrl, authorization: () => "device" })).toThrow(
        AccountClientError,
      );
    }
  });
});
