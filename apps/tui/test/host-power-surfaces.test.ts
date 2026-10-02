import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore } from "@clankie/credential-broker";
import { afterEach, describe, expect, it } from "vitest";
import type { ClankieFaceShell } from "../src/shell/shell.ts";
import { buildConsoleCommands } from "../src/commands.ts";
import type { AwakeCommandResult } from "../src/command/awake.ts";
import { inspectInstall, type ExecFileImpl } from "../src/install-doctor.ts";

// VUH-1461: `clankie doctor` and the console say when this Mac may sleep.

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const pmset =
  (source: "AC Power" | "Battery Power", sleepMinutes: { battery: number; ac: number }): ExecFileImpl =>
  async (command, args) => {
    if (command !== "pmset") throw Object.assign(new Error("not found"), { code: "ENOENT" });
    if (args[1] === "batt") return { stdout: `Now drawing from '${source}'\n`, stderr: "" };
    if (args[1] === "custom") {
      return {
        stdout: `Battery Power:\n sleep ${String(sleepMinutes.battery)}\nAC Power:\n sleep ${String(sleepMinutes.ac)}\n`,
        stderr: "",
      };
    }
    return { stdout: "Listed by owning process:\n", stderr: "" };
  };

async function doctor(execFileImpl: ExecFileImpl, fetchImpl: typeof fetch) {
  const root = await mkdtemp(join(tmpdir(), "clankie-doctor-power-"));
  tempDirs.push(root);
  await mkdir(join(root, "config", "clankie"), { recursive: true });
  return await inspectInstall({
    repoRoot: root,
    env: { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config") },
    credentialStore: new FileCredentialStore(join(root, "credentials.json")),
    execFileImpl,
    fetchImpl,
  });
}

const health = (body: unknown): typeof fetch =>
  (async (input) =>
    String(input).endsWith("/health")
      ? new Response(JSON.stringify(body), { status: 200 })
      : new Response("{}", { status: 401 })) as typeof fetch;

describe("doctor host power", () => {
  it("names a Mac on battery with sleep allowed, how to keep it awake, and the hosted alternative", async () => {
    const report = await doctor(
      pmset("Battery Power", { battery: 1, ac: 0 }),
      health({ doorway: { state: "connected" } }),
    );

    expect(report.power).toMatchObject({ state: "sleep_allowed", source: "battery", sleepAfterMinutes: 1 });
    const advice = report.remediations.find((line) => line.startsWith("On battery"));
    expect(advice).toContain("clankie awake on");
    expect(advice).toContain("hosted Clankie");
  });

  it("carries the service's last observed sleep, read from the one /health probe", async () => {
    const lastSleep = {
      sleptAt: "2026-09-30T03:00:00.000Z",
      wokeAt: "2026-09-30T03:14:00.000Z",
      seconds: 840,
    };
    const report = await doctor(
      pmset("AC Power", { battery: 1, ac: 0 }),
      health({
        doorway: { state: "connected" },
        power: {
          state: "always_on",
          source: "ac",
          sleepAfterMinutes: 0,
          heldAwakeBy: [],
          keepAwakeRequested: false,
          lastSleep,
        },
      }),
    );
    expect(report.power.lastSleep).toEqual(lastSleep);
    expect(report.power.state).toBe("always_on");
    expect(report.remediations.some((line) => /sleep/u.test(line))).toBe(false);
  });

  it("stays silent where there is no pmset", async () => {
    const report = await doctor(async () => {
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    }, health({}));
    expect(report.power.state).toBe("unknown");
    expect(report.remediations.some((line) => /sleep/u.test(line))).toBe(false);
  });
});

describe("/awake", () => {
  const result: AwakeCommandResult = {
    ok: true,
    keepAwake: true,
    service: { state: "healthy", detail: "holding this Mac awake while plugged in" },
    power: {
      state: "always_on",
      source: "ac",
      sleepAfterMinutes: 10,
      heldAwakeBy: ["caffeinate"],
      keepAwakeRequested: true,
    },
    note: "Keeps this Mac awake only while it is plugged in.",
  };

  async function run(
    argument: string,
    commandAwake?: (args: readonly string[]) => Promise<AwakeCommandResult>,
  ) {
    const results: { text: string; tone: unknown }[] = [];
    const shell = {
      insertCommandResult: (_command: string, text: string, tone: unknown) => results.push({ text, tone }),
    } as unknown as ClankieFaceShell;
    const commands = buildConsoleCommands(commandAwake === undefined ? {} : { commandAwake });
    await commands.find((command) => command.name === "awake")?.run(argument, shell);
    return results;
  }

  it("passes on/off through to the same command the CLI runs and prints the verdict", async () => {
    const seen: (readonly string[])[] = [];
    const [shown] = await run("on", async (args) => (seen.push(args), result));
    expect(seen).toEqual([["on"]]);
    expect(shown?.text).toContain("keep-awake: on");
    expect(shown?.text).toContain("held awake by: caffeinate");
  });

  it("rejects anything but status, on or off, and reports an unavailable command", async () => {
    expect((await run("sideways", async () => result))[0]).toMatchObject({ tone: "error" });
    expect((await run("on"))[0]).toMatchObject({ tone: "error" });
  });

  it("shows the launcher's error instead of swallowing it", async () => {
    const [shown] = await run("on", async () => {
      throw new Error("Keep-awake runs caffeinate, which is macOS only.");
    });
    expect(shown).toMatchObject({ tone: "error" });
    expect(shown?.text).toContain("macOS only");
  });
});
