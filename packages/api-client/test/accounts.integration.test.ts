import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  AccountClientError,
  createAccountsClient,
  parseLinearAccountCallback,
  validateLinearAccountStart,
  parseGoogleAccountCallback,
  validateGoogleAccountStart,
  type PendingGoogleAccountFlow,
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
  it("uses the selected Google capability across the consent, callback, check and disconnect HTTP boundary", async () => {
    const scopes = {
      "google-gmail": ["https://www.googleapis.com/auth/gmail.readonly"],
      "google-calendar": [
        "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
        "https://www.googleapis.com/auth/calendar.events.readonly",
      ],
      "google-drive": ["https://www.googleapis.com/auth/drive.file"],
    } as const;
    for (const provider of Object.keys(scopes) as Array<keyof typeof scopes>) {
      const drive = provider === "google-drive";
      const granted = [...(drive ? [] : ["openid", "email"]), ...scopes[provider]];
      const selectedFiles = drive ? { pickedFileIds: ["fixture-file_1", "fixture-file_2"] } : {};
      const googleRedirect = "http://127.0.0.1:4310/account/connections/google/callback";
      const pending: PendingGoogleAccountFlow = {
        ...flow,
        provider,
        redirectUri: googleRedirect,
        authorizeUrl: `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
          client_id: "fixture.apps.googleusercontent.com",
          redirect_uri: googleRedirect,
          state,
          nonce: "n".repeat(32),
          response_type: "code",
          scope: granted.join(" "),
          code_challenge_method: "S256",
          code_challenge: "c".repeat(43),
          access_type: "offline",
          prompt: drive ? "consent" : "consent select_account",
          include_granted_scopes: "false",
          ...(drive ? { trigger_onepick: "true", allow_multiple: "true" } : {}),
        })}`,
      };
      let connected = false;
      const connection = () => ({
        provider,
        name: "Body catalog name",
        description: "Body catalog purpose",
        readOnly: !drive,
        status: connected ? "connected" : "not_connected",
        scopes: connected ? granted : [],
      });
      const server = await fixture((path, body) => {
        if (path === "/v1/accounts") return { body: { connections: [connection()] } };
        const input = JSON.parse(body);
        expect(input.provider).toBe(provider);
        if (path === "/v1/accounts/google/start") {
          const { provider: _provider, ...result } = pending;
          return { body: result };
        }
        if (path === "/v1/accounts/google/complete") {
          expect(input).toEqual({ provider, state, code: "fixture-private-google-code", ...selectedFiles });
          connected = true;
          return { body: { ok: true, connection: connection() } };
        }
        if (path === "/v1/accounts/google/check") return { body: { ok: true, connection: connection() } };
        connected = false;
        return { body: { ok: true, revoked: false, manageUrl: "https://myaccount.google.com/connections" } };
      });
      const client = createAccountsClient({
        baseUrl: server.baseUrl,
        authorization: () => "fixture-tenant-device",
      });
      const start = await client.startGoogle(provider);
      if (!start.ok) throw new Error("Fixture start refused");
      validateGoogleAccountStart({ ...start, provider });
      const callback = parseGoogleAccountCallback(
        `clankie://accounts/google/callback?${new URLSearchParams({
          state,
          code: "fixture-private-google-code",
          scope: granted.join(" "),
          authuser: "0",
          prompt: "consent",
          iss: "https://accounts.google.com",
          ...(drive ? { picked_file_ids: selectedFiles.pickedFileIds!.join(",") } : {}),
        })}`,
        { ...start, provider },
      );
      if (!("code" in callback)) throw new Error("Fixture callback refused");
      const result = await client.completeGoogle(
        provider,
        callback.state,
        callback.code,
        callback.pickedFileIds,
      );
      expect(result).toMatchObject({
        ok: true,
        connection: { provider, scopes: granted, name: "Body catalog name" },
      });
      expect(JSON.stringify(result)).not.toContain("fixture-private-google-code");
      expect(await client.checkGoogle(provider)).toMatchObject({
        ok: true,
        connection: { provider, status: "connected" },
      });
      expect(await client.disconnect(provider)).toMatchObject({ ok: true, revoked: false });
      expect((await client.list()).connections[0]?.status).toBe("not_connected");
      expect(server.seen.map((request) => request.path)).toEqual([
        "/v1/accounts/google/start",
        "/v1/accounts/google/complete",
        "/v1/accounts/google/check",
        "/v1/accounts/disconnect",
        "/v1/accounts",
      ]);
      expect(server.seen.every((request) => request.authorization === "Bearer fixture-tenant-device")).toBe(
        true,
      );
      const callbackUrl = `clankie://accounts/google/callback?state=${state}&code=code`;
      for (const value of [
        callbackUrl.replace(state, "wrong"),
        `${callbackUrl}&code=other`,
        `${callbackUrl}&error=access_denied`,
        callbackUrl.replace("google/callback", "linear/callback"),
        `${callbackUrl}&access_token=private`,
        `${callbackUrl}&scope=readonly&scope=write`,
        `${callbackUrl}#fragment`,
        `${callbackUrl}&picked_file_ids=one,one`,
        `${callbackUrl}&picked_file_ids=`,
        `${callbackUrl}&picked_file_ids=one/unsafe`,
        `${callbackUrl}&picked_file_ids=${Array.from({ length: 101 }, (_, index) => `file_${index}`).join(",")}`,
      ])
        expect(() => parseGoogleAccountCallback(value, pending)).toThrow(AccountClientError);
      expect(() => parseGoogleAccountCallback(callbackUrl, pending, Date.parse(pending.expiresAt))).toThrow(
        AccountClientError,
      );
      expect(
        parseGoogleAccountCallback(
          `clankie://accounts/google/callback?state=${state}&error=access_denied&error_description=private`,
          pending,
        ),
      ).toEqual({ state, error: "denied" });
      if (!drive)
        expect(() => parseGoogleAccountCallback(`${callbackUrl}&picked_file_ids=one`, pending)).toThrow(
          AccountClientError,
        );
      if (drive) {
        expect(() => client.completeGoogle(provider, state, "code")).toThrow(AccountClientError);
        expect(() =>
          validateGoogleAccountStart({
            ...pending,
            authorizeUrl: pending.authorizeUrl.replace("drive.file", "drive.readonly"),
          }),
        ).toThrow(AccountClientError);
        const missingPicker = new URL(pending.authorizeUrl);
        missingPicker.searchParams.delete("trigger_onepick");
        expect(() => validateGoogleAccountStart({ ...pending, authorizeUrl: String(missingPicker) })).toThrow(
          AccountClientError,
        );
      }
      for (const [key, value] of [
        ["scope", `${granted.join(" ")} https://www.googleapis.com/auth/drive`],
        ["scope", "openid email"],
        ["code_challenge_method", "plain"],
        ["nonce", ""],
        ["access_type", "online"],
        ["include_granted_scopes", "true"],
        ["client_secret", "private"],
        ["redirect_uri", "http://lan.test/account/connections/google/callback"],
      ]) {
        const url = new URL(pending.authorizeUrl);
        url.searchParams.set(key!, value!);
        expect(() => validateGoogleAccountStart({ ...pending, authorizeUrl: String(url) })).toThrow(
          AccountClientError,
        );
      }
      expect(() =>
        validateGoogleAccountStart({
          ...pending,
          authorizeUrl: pending.authorizeUrl.replace("accounts.google.com", "evil.test"),
        }),
      ).toThrow(AccountClientError);
      expect(() =>
        validateGoogleAccountStart({ ...pending, authorizeUrl: `${pending.authorizeUrl}&state=duplicate` }),
      ).toThrow(AccountClientError);
      expect(server.seen).toHaveLength(5);
    }
  });
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
