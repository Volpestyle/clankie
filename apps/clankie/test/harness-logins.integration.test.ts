import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  HARNESS_LOGINS_PATH,
  HARNESS_LOGIN_CANCEL_PATH,
  HARNESS_LOGIN_CODE_PATH,
  HARNESS_LOGIN_START_PATH,
  HARNESS_LOGIN_STATUS_PATH,
} from "@clankie/protocol/harness-logins";
import { createHarnessLoginRoutes } from "../src/harness-login-routes.ts";
import { HarnessSignIns } from "../src/harness-logins.ts";

// The bin directory replays the real CLIs' captured output (see each fixture).
const bin = resolve(import.meta.dirname, "fixtures", "harness-login-bin");
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((step) => step()));

function fixture(env: NodeJS.ProcessEnv = {}, path = `${bin}:${process.env.PATH}`) {
  const home = mkdtempSync(join(tmpdir(), "harness-login-"));
  const logins = new HarnessSignIns({ env: { PATH: path, HOME: home, ...env } });
  cleanup.push(() => {
    logins.close();
    rmSync(home, { recursive: true, force: true });
  });
  const app = createHarnessLoginRoutes(
    logins,
    async (request) => (request.headers.get("x-principal") ? true : "authentication_required"),
    async (request) => request.headers.get("x-principal") ?? undefined,
  );
  const call = async (path: string, body?: unknown, principal = "device:phone") => {
    const response = await app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...(principal ? { "x-principal": principal } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const until = async (sessionId: string, states: readonly string[]) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { body } = await call(HARNESS_LOGIN_STATUS_PATH, { sessionId });
      if (states.includes(String(body.state))) return body;
      await new Promise((done) => setTimeout(done, 25));
    }
    throw Error(`never reached ${states.join("|")}`);
  };
  return { home, call, until };
}

it("signs Codex in with its device code, showing only the vendor link and code to its starter", async () => {
  const f = fixture();
  expect((await f.call(HARNESS_LOGINS_PATH)).body).toEqual({
    harnesses: [
      { harness: "claude", installed: true, signedIn: false },
      { harness: "codex", installed: true, signedIn: false },
    ],
  });
  const started = await f.call(HARNESS_LOGIN_START_PATH, { harness: "codex" });
  expect(started.status).toBe(200);
  const sessionId = String(started.body.sessionId);
  const shown = await f.until(sessionId, ["pending"]).then(async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { body } = await f.call(HARNESS_LOGIN_STATUS_PATH, { sessionId });
      if (body.userCode) return body;
      await new Promise((done) => setTimeout(done, 25));
    }
    throw Error("no device code");
  });
  expect(shown).toMatchObject({ url: "https://auth.openai.com/codex/device", userCode: "Q7RT-9KXWP" });
  // Another device cannot read it, and only one sign-in runs at a time.
  expect((await f.call(HARNESS_LOGIN_STATUS_PATH, { sessionId }, "device:other")).status).toBe(404);
  expect((await f.call(HARNESS_LOGIN_START_PATH, { harness: "claude" })).body).toEqual({
    ok: false,
    error: "busy",
  });

  writeFileSync(join(f.home, "codex-approved"), "");
  const done = await f.until(sessionId, ["complete", "failed"]);
  expect(done.state).toBe("complete");
  expect(done.url).toBeUndefined();
  expect((await f.call(HARNESS_LOGINS_PATH)).body.harnesses).toContainEqual({
    harness: "codex",
    installed: true,
    signedIn: true,
    method: "ChatGPT",
  });
});

it("signs Claude into the subscription with the code the owner copies back, ahead of an env key", async () => {
  const f = fixture({ ANTHROPIC_API_KEY: "sk-ant-owner-key-abcdefghijklmnopqrst" });
  writeFileSync(
    join(f.home, ".claude.json"),
    JSON.stringify({
      customApiKeyResponses: { approved: ["key-abcdefghijklmnopqrst".slice(-20)], rejected: [] },
    }),
  );
  // With only the env key, Claude runs on the key.
  expect((await f.call(HARNESS_LOGINS_PATH)).body.harnesses).toContainEqual({
    harness: "claude",
    installed: true,
    signedIn: true,
    method: "api_key",
  });

  const started = await f.call(HARNESS_LOGIN_START_PATH, { harness: "claude" });
  const sessionId = String(started.body.sessionId);
  const asked = await f.until(sessionId, ["needs_code"]);
  expect(String(asked.url)).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/u);
  // A mistyped code leaves the same sign-in waiting for another.
  expect((await f.call(HARNESS_LOGIN_CODE_PATH, { sessionId, code: "typo" })).body.state).toBe("verifying");
  expect(await f.until(sessionId, ["needs_code", "failed"])).toMatchObject({
    state: "needs_code",
    codeRejected: true,
  });
  await f.call(HARNESS_LOGIN_CODE_PATH, { sessionId, code: "good-code#state" });
  expect((await f.until(sessionId, ["complete", "failed"])).state).toBe("complete");
  expect((await f.call(HARNESS_LOGINS_PATH)).body.harnesses).toContainEqual({
    harness: "claude",
    installed: true,
    signedIn: true,
    method: "subscription",
  });
  // The login ran without the key, and the subscription now wins over it.
  expect(readFileSync(join(f.home, "claude-env.log"), "utf8")).toContain("login:nokey");
  const responses = JSON.parse(readFileSync(join(f.home, ".claude.json"), "utf8")).customApiKeyResponses;
  expect(responses).toEqual({ approved: [], rejected: ["abcdefghijklmnopqrst"] });
});

it("cancels a waiting sign-in, refuses unauthenticated callers, and reports a missing harness", async () => {
  const f = fixture();
  const started = await f.call(HARNESS_LOGIN_START_PATH, { harness: "claude" });
  const sessionId = String(started.body.sessionId);
  await f.until(sessionId, ["needs_code"]);
  expect((await f.call(HARNESS_LOGIN_CANCEL_PATH, { sessionId })).body.state).toBe("cancelled");
  expect((await f.call(HARNESS_LOGINS_PATH, undefined, "")).status).toBe(401);
  expect((await f.call(HARNESS_LOGIN_START_PATH, { harness: "gemini" })).status).toBe(400);

  const bare = fixture({}, "/usr/bin:/bin");
  expect((await bare.call(HARNESS_LOGIN_START_PATH, { harness: "codex" })).body).toEqual({
    ok: false,
    error: "not_installed",
  });
});
