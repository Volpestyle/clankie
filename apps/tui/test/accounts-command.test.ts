import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { runAccountsCommand } from "../src/command/accounts.ts";

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const env = { CLANKIE_OPERATOR_TOKEN: "owner-token", CLANKIE_CONTROL_PLANE_URL: "http://clankie.test" };

describe("clankie accounts", () => {
  it("sends an app secret from stdin only to the authenticated account route", async () => {
    const request = vi.fn(async () => ({ ok: true, connection: { actor: "app", account: "Clankie" } }));
    const secret = "app-secret-from-stdin";
    const result = await runAccountsCommand(
      ["connect", "linear-app", "--client-id", "app-id", "--secret-stdin"],
      { request, stdin: Readable.from([secret, "\n"]) },
    );
    expect(request).toHaveBeenCalledExactlyOnceWith("/v1/accounts/linear/app", {
      clientId: "app-id",
      clientSecret: secret,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    await expect(
      runAccountsCommand(["connect", "linear-app", "--client-id", "app-id", "--secret-stdin"], {
        request,
        stdin: Readable.from([" "]),
      }),
    ).rejects.toThrow("Invalid Linear app credentials");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("sets and clears OAuth client configuration without restarting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "accounts-cli-"));
    dirs.push(dir);
    const settings = new SettingsStore(join(dir, "settings.json"));
    expect(
      await runAccountsCommand(
        [
          "apps",
          "set",
          "--github-client-id",
          "Ov23liClient",
          "--linear-redirect-uri",
          "https://clankie.bot/connect/linear",
        ],
        { env, settings },
      ),
    ).toMatchObject({
      ok: true,
      oauthApps: {
        github: { clientId: "Ov23liClient" },
        linear: { redirectUri: "https://clankie.bot/connect/linear" },
      },
    });
    expect(
      await runAccountsCommand(["apps", "clear", "--github-client-id"], { env, settings }),
    ).toMatchObject({
      oauthApps: { github: {}, linear: { redirectUri: "https://clankie.bot/connect/linear" } },
    });
    await expect(
      runAccountsCommand(["apps", "set", "--github-client-id"], { env, settings }),
    ).rejects.toThrow("Usage: clankie accounts");
  });

  it("prints the GitHub code, waits the interval, and returns the connection", async () => {
    const polls = [
      { ok: true, status: "pending", interval: 7 },
      {
        ok: true,
        status: "connected",
        connection: { provider: "github", status: "connected", scopes: ["repo"] },
      },
    ];
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url} ${new Headers(init.headers).get("authorization")}`);
      return Response.json(
        url.endsWith("/start")
          ? {
              ok: true,
              flowId: "f".repeat(20),
              userCode: "WDJB-MJHT",
              verificationUri: "https://github.com/login/device",
              expiresAt: "2026-09-26T12:15:00Z",
              interval: 5,
            }
          : polls.shift(),
      );
    });
    const lines: string[] = [];
    const waits: number[] = [];
    const result = await runAccountsCommand(["connect", "github"], {
      env,
      prompt: (line) => lines.push(line),
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    expect(result).toMatchObject({ ok: true, status: "connected" });
    expect(lines).toEqual(["Open https://github.com/login/device and enter WDJB-MJHT"]);
    expect(waits).toEqual([5000, 7000]);
    expect(calls).toEqual([
      "POST http://clankie.test/v1/accounts/github/start Bearer owner-token",
      "POST http://clankie.test/v1/accounts/github/poll Bearer owner-token",
      "POST http://clankie.test/v1/accounts/github/poll Bearer owner-token",
    ]);
  });
});
