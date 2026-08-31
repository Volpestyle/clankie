import { describe, expect, it } from "vitest";
import { parseHerdrSessionSocket, pinHerdrSessionEnvironment } from "../src/herdr-session.ts";

const sessions = {
  sessions: [
    { default: true, name: "default", running: true, socket_path: "/home/op/.config/herdr/herdr.sock" },
    {
      default: false,
      name: "clankies",
      running: false,
      socket_path: "/home/op/.config/herdr/sessions/clankies/herdr.sock",
    },
  ],
};

const inherited = () => ({
  HERDR_ENV: "1",
  HERDR_PANE_ID: "w1:p1",
  HERDR_TAB_ID: "w1:t1",
  HERDR_WORKSPACE_ID: "w1",
  HERDR_SOCKET_PATH: "/somewhere/else/herdr.sock",
});

describe("pinHerdrSessionEnvironment", () => {
  it("resolves a session name to its socket", () => {
    expect(parseHerdrSessionSocket(JSON.stringify(sessions), "clankies")).toBe(
      "/home/op/.config/herdr/sessions/clankies/herdr.sock",
    );
    expect(parseHerdrSessionSocket(JSON.stringify(sessions), "nope")).toBeUndefined();
  });

  it("pins the configured session's socket and scrubs inherited pane identity", async () => {
    const env: NodeJS.ProcessEnv = inherited();
    const pin = await pinHerdrSessionEnvironment("clankies", env, (command, args) => {
      expect(command).toBe("herdr");
      expect(args).toEqual(["session", "list", "--json"]);
      return Promise.resolve({ stdout: JSON.stringify(sessions), stderr: "" });
    });
    expect(pin).toEqual({
      outcome: "pinned",
      session: "clankies",
      socketPath: "/home/op/.config/herdr/sessions/clankies/herdr.sock",
    });
    expect(env.HERDR_SOCKET_PATH).toBe("/home/op/.config/herdr/sessions/clankies/herdr.sock");
    expect(env.HERDR_ENV).toBeUndefined();
    expect(env.HERDR_PANE_ID).toBeUndefined();
    expect(env.HERDR_TAB_ID).toBeUndefined();
    expect(env.HERDR_WORKSPACE_ID).toBeUndefined();
  });

  it("leaves the env scrubbed for an unknown session so herdr's own default applies", async () => {
    const env: NodeJS.ProcessEnv = inherited();
    const pin = await pinHerdrSessionEnvironment("nope", env, () =>
      Promise.resolve({ stdout: JSON.stringify(sessions), stderr: "" }),
    );
    expect(pin).toEqual({ outcome: "unknown_session", session: "nope" });
    expect(env.HERDR_SOCKET_PATH).toBeUndefined();
  });

  it("is fail-soft when the herdr CLI is missing", async () => {
    const env: NodeJS.ProcessEnv = inherited();
    const pin = await pinHerdrSessionEnvironment("default", env, () =>
      Promise.reject(Object.assign(new Error("spawn herdr ENOENT"), { code: "ENOENT" })),
    );
    expect(pin).toEqual({ outcome: "cli_missing" });
    expect(env.HERDR_ENV).toBeUndefined();
    expect(env.HERDR_SOCKET_PATH).toBeUndefined();
  });
});
