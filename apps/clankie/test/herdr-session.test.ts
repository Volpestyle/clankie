import { describe, expect, it } from "vitest";
import { resolveHerdrBinding } from "../src/herdr-session.ts";

const settings = { runtime: "auto", session: "default" } as const;
const current = () => ({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/tmp/current.sock" });
const sessions = JSON.stringify({
  sessions: [
    { name: "default", socket_path: "/tmp/current.sock" },
    { name: "chosen", socket_path: "/tmp/chosen.sock" },
  ],
});

/** A Herdr whose listed sessions are saved but only `live` ones answer. */
function runner(live: readonly string[]): NonNullable<Parameters<typeof resolveHerdrBinding>[2]> {
  return async (_command, args, env) => {
    if (args[0] === "session") return { stdout: sessions };
    expect(env.HERDR_PANE_ID).toBeUndefined();
    if (!live.includes(env.HERDR_SOCKET_PATH ?? "")) throw new Error("connection refused");
    return { stdout: JSON.stringify({ result: { snapshot: { panes: [] } } }) };
  };
}

describe("the Herdr the service leads", () => {
  it("is his own when he is launched outside every session", async () => {
    expect(await resolveHerdrBinding(settings, {}, runner(["/tmp/current.sock"]))).toEqual({
      runtime: "bundled",
      session: "default",
    });
  });

  it("is the session he was launched inside, named as Herdr names it (ADR 0170)", async () => {
    const env: NodeJS.ProcessEnv = current();
    expect(await resolveHerdrBinding(settings, env, runner(["/tmp/current.sock"]))).toEqual({
      runtime: "external",
      session: "default",
      socketPath: "/tmp/current.sock",
    });
    expect(env.HERDR_PANE_ID).toBeUndefined();
    expect(env.HERDR_SOCKET_PATH).toBe("/tmp/current.sock");
  });

  it("is the session the owner named, over the terminal he happened to start in", async () => {
    const env: NodeJS.ProcessEnv = current();
    const named = { ...settings, runtime: "external", session: "chosen" } as const;
    expect(await resolveHerdrBinding(named, env, runner(["/tmp/current.sock", "/tmp/chosen.sock"]))).toEqual({
      runtime: "external",
      session: "chosen",
      socketPath: "/tmp/chosen.sock",
    });
    expect(env.HERDR_SOCKET_PATH).toBe("/tmp/chosen.sock");
  });

  it("never leaves his own runtime when the owner asked for it", async () => {
    expect(
      await resolveHerdrBinding({ ...settings, runtime: "bundled" }, current(), async () => {
        throw new Error("no session may be probed");
      }),
    ).toEqual({ runtime: "bundled", session: "default" });
  });
});

describe("a bound session that is not there", () => {
  it("falls back to the session he was launched inside, and never refuses the boot", async () => {
    const named = { runtime: "external", session: "chosen", socketPath: "/tmp/chosen.sock" } as const;
    const env: NodeJS.ProcessEnv = current();
    expect(await resolveHerdrBinding(named, env, runner(["/tmp/current.sock"]))).toEqual({
      runtime: "external",
      session: "default",
      socketPath: "/tmp/current.sock",
    });
    expect(env.HERDR_SOCKET_PATH).toBe("/tmp/current.sock");
  });

  it("falls back to his own runtime when nothing else answers", async () => {
    const named = { runtime: "external", session: "chosen", socketPath: "/tmp/chosen.sock" } as const;
    expect(await resolveHerdrBinding(named, current(), runner([]))).toEqual({
      runtime: "bundled",
      session: "chosen",
    });
    expect(
      await resolveHerdrBinding({ ...settings, runtime: "external", session: "missing" }, {}, runner([])),
    ).toEqual({ runtime: "bundled", session: "missing" });
    expect(
      await resolveHerdrBinding(named, current(), async () => {
        throw new Error("herdr is not installed");
      }),
    ).toEqual({ runtime: "bundled", session: "chosen" });
  });

  it("reads an answerless snapshot as a session that is not there", async () => {
    expect(
      await resolveHerdrBinding(settings, current(), async (_command, args) =>
        args[0] === "session" ? { stdout: sessions } : { stdout: '{"error":{}}' },
      ),
    ).toEqual({ runtime: "bundled", session: "default" });
  });
});
