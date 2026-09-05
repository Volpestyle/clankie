import { describe, expect, it } from "vitest";
import { resolveHerdrBinding } from "../src/herdr-session.ts";

const settings = { runtime: "auto", session: "default" } as const;
const current = () => ({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/current.sock" });
const run: NonNullable<Parameters<typeof resolveHerdrBinding>[2]> = async (_command, args, env) => {
  if (args[0] === "session")
    return { stdout: JSON.stringify({ sessions: [{ name: "chosen", socket_path: "/tmp/chosen.sock" }] }) };
  expect(env.HERDR_PANE_ID).toBeUndefined();
  expect(env.HERDR_SOCKET_PATH).toMatch(/^\/tmp\//u);
  return { stdout: JSON.stringify({ result: { snapshot: { panes: [] } } }) };
};

describe("the service's first Herdr binding", () => {
  it("chooses private outside Herdr, and later environments cannot change that choice", async () => {
    const binding = await resolveHerdrBinding(settings, {}, run);
    expect(binding).toEqual({ runtime: "bundled", session: "default" });
    expect(await resolveHerdrBinding(binding, current(), run)).toEqual(binding);
  });

  it("adopts the actual socket once and scrubs the launching pane's identity", async () => {
    const env: NodeJS.ProcessEnv = current();
    const binding = await resolveHerdrBinding(settings, env, run);
    expect(binding).toEqual({ runtime: "external", session: "default", socketPath: "/tmp/current.sock" });
    expect(env.HERDR_PANE_ID).toBeUndefined();
    expect(env.HERDR_SOCKET_PATH).toBe(binding.socketPath);
    const other = { ...current(), HERDR_SOCKET_PATH: "/tmp/other.sock" };
    expect(await resolveHerdrBinding(binding, other, run)).toEqual(binding);
    expect(other.HERDR_SOCKET_PATH).toBe(binding.socketPath);
  });

  it("resolves a named surrounding session and preserves an older explicit named setting", async () => {
    const env = { HERDR_ENV: "1", HERDR_SESSION: "chosen" };
    expect(await resolveHerdrBinding(settings, env, run)).toEqual({
      runtime: "external",
      session: "chosen",
      socketPath: "/tmp/chosen.sock",
    });
    expect(await resolveHerdrBinding({ ...settings, session: "chosen" }, current(), run)).toEqual({
      runtime: "external",
      session: "chosen",
      socketPath: "/tmp/chosen.sock",
    });
  });

  it("refuses missing, malformed, and dead external sessions instead of switching fleets", async () => {
    await expect(
      resolveHerdrBinding({ ...settings, runtime: "external", session: "missing" }, {}, run),
    ).rejects.toThrow("no usable socket");
    await expect(
      resolveHerdrBinding(settings, current(), async () => ({ stdout: '{"error":{}}' })),
    ).rejects.toThrow("unavailable");
    await expect(
      resolveHerdrBinding(settings, current(), async () => {
        throw new Error("connection refused");
      }),
    ).rejects.toThrow("connection refused");
  });
});
