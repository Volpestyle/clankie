import { createServer } from "node:http";
import { Readable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { runAccountsCommand } from "../src/command/accounts.ts";
import { buildConnectCommands, type ConnectCommandServices } from "../src/connect-commands.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it("renders the body catalog and performs Google consent/check/grouped disconnect through the authenticated CLI boundary", async () => {
  const state = "s".repeat(32);
  const code = "fixture-private-google-code";
  const redirectUri = "http://127.0.0.1:4310/account/connections/google/callback";
  const flow = {
    ok: true,
    flowId: state,
    redirectUri,
    expiresAt: "2099-01-01T00:00:00Z",
    authorizeUrl: `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
      client_id: "fixture.apps.googleusercontent.com",
      redirect_uri: redirectUri,
      state,
      nonce: "n".repeat(32),
      response_type: "code",
      scope: "openid email https://www.googleapis.com/auth/gmail.readonly",
      code_challenge_method: "S256",
      code_challenge: "c".repeat(43),
      access_type: "offline",
      prompt: "consent select_account",
      include_granted_scopes: "false",
    })}`,
  };
  let connected = false;
  let revocationPending = false;
  const connection = () => ({
    provider: "google-gmail",
    name: "Mail for briefings",
    description: "A catalog purpose from the body",
    access: "A read-only permission disclosure from the body",
    readOnly: true,
    status: connected ? "connected" : revocationPending ? "disconnected" : "not_connected",
    scopes: connected ? ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"] : [],
    revocationPending,
  });
  const seen: { path: string; input: unknown; authorization: string | undefined }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const input = body ? JSON.parse(body) : undefined;
    const path = request.url ?? "";
    seen.push({ path, input, authorization: request.headers.authorization });
    let result: unknown;
    if (path === "/v1/accounts") result = { connections: [connection()] };
    else if (path === "/v1/accounts/google/start") result = flow;
    else if (path === "/v1/accounts/google/complete") {
      expect(input).toEqual({ provider: "google-gmail", state, code });
      connected = true;
      result = { ok: true, connection: connection() };
    } else if (path === "/v1/accounts/google/check") result = { ok: true, connection: connection() };
    else {
      connected = false;
      revocationPending = true;
      result = { ok: true, revoked: false, manageUrl: "https://myaccount.google.com/connections" };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture port");
  const env = {
    CLANKIE_OPERATOR_TOKEN: "fixture-body-operator",
    CLANKIE_CONTROL_PLANE_URL: `http://127.0.0.1:${address.port}`,
  };
  const selections = [
    "google-gmail",
    "connect",
    "google-gmail",
    "check",
    "google-gmail",
    "disconnect",
    undefined,
  ];
  const menus: { options: { value: string; label: string; description?: string; hint?: string }[] }[] = [];
  const lines: string[] = [];
  const shell = {
    setupFlow: {
      begin: () => undefined,
      end: () => undefined,
      readSelect: async (menu: (typeof menus)[number]) => {
        menus.push(menu);
        return selections.shift();
      },
      readSecret: async () => `clankie://accounts/google/callback?state=${state}&code=${code}&authuser=0`,
      renderLine: (line: string) => lines.push(line),
    },
  } as unknown as ClankieFaceShell;
  const services = {
    accounts: (args: readonly string[], input?: string) =>
      runAccountsCommand(args, {
        env,
        ...(input === undefined ? {} : { stdin: Readable.from([input]) }),
      }),
  } as unknown as ConnectCommandServices;
  await buildConnectCommands(services)[0]!.run("accounts", shell);
  expect(menus[0]?.options[0]).toMatchObject({ label: "Mail for briefings" });
  expect(menus[0]?.options[0]?.description).toContain("A catalog purpose from the body");
  expect(menus[0]?.options[0]?.description).toContain("A read-only permission disclosure from the body");
  expect(
    menus.some((menu) =>
      menu.options.some((option) =>
        option.description?.includes("also disconnects Gmail, Calendar and Drive"),
      ),
    ),
  ).toBe(true);
  expect(lines).toContain("Mail for briefings connected.");
  expect(lines.some((line) => line.includes("Provider revocation is pending"))).toBe(true);
  expect(lines.join("\n")).not.toContain(code);
  expect(menus.at(-1)?.options[0]?.hint).toContain("revocation pending");
  expect(seen.map((request) => request.path)).toEqual([
    "/v1/accounts",
    "/v1/accounts/google/start",
    "/v1/accounts/google/complete",
    "/v1/accounts",
    "/v1/accounts/google/check",
    "/v1/accounts",
    "/v1/accounts/disconnect",
    "/v1/accounts",
  ]);
  expect(seen.every((request) => request.authorization === "Bearer fixture-body-operator")).toBe(true);
});
