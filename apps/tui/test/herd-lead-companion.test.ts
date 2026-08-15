import { describe, expect, it } from "vitest";
import {
  closeHerdLeadCompanion,
  ensureHerdLeadCompanion,
  focusHerdLeadCompanion,
  formatHerdLeadCompanionResult,
} from "../src/observation/herd-lead-companion.ts";
import { buildConsoleCommands } from "../src/commands.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";

describe("herd-lead companion", () => {
  it("is inert outside HERDR_ENV=1", async () => {
    await expect(
      ensureHerdLeadCompanion({
        env: {},
        runCommand: () => {
          throw new Error("must not run herdr-lead outside herdr");
        },
      }),
    ).resolves.toEqual({ outcome: "skipped", reason: "not_in_herdr" });
  });

  it("splits the board with this pane as the jump-back peer", async () => {
    const calls: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const result = await ensureHerdLeadCompanion({
      env: { HERDR_ENV: "1", HERDR_PANE_ID: "w3:p2J", PATH: "/usr/bin" },
      runCommand: (command, args, env) => {
        calls.push({ command, args, env });
        return Promise.resolve({ stdout: "w3:p9K\n", stderr: "" });
      },
    });
    expect(result).toEqual({ outcome: "ok", paneId: "w3:p9K", alreadyOpen: false });
    expect(calls).toEqual([
      {
        command: "herdr-lead",
        args: ["split"],
        env: expect.objectContaining({ HERD_LEAD_TARGET: "w3:p2J", HERDR_PANE_ID: "w3:p2J" }),
      },
    ]);
  });

  it("inherits an already-open board instead of opening another", async () => {
    const result = await ensureHerdLeadCompanion({
      env: { HERDR_ENV: "1", HERDR_PANE_ID: "w3:p2J" },
      runCommand: () =>
        Promise.resolve({
          stdout: "w3:p4A\n",
          stderr: "board already open in w3:p4A — herdr-lead focus jumps to it\n",
        }),
    });
    expect(result).toEqual({ outcome: "ok", paneId: "w3:p4A", alreadyOpen: true });
  });

  it("reports a missing binary honestly", async () => {
    const missing = Object.assign(new Error("spawn herdr-lead ENOENT"), { code: "ENOENT" });
    await expect(
      ensureHerdLeadCompanion({
        env: { HERDR_ENV: "1" },
        runCommand: () => Promise.reject(missing),
      }),
    ).resolves.toEqual({ outcome: "unavailable", error: "herdr-lead is not on PATH" });
  });

  it("focuses through the same peer env", async () => {
    const result = await focusHerdLeadCompanion({
      env: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" },
      runCommand: (_command, args, env) => {
        expect(args).toEqual(["focus"]);
        expect(env.HERD_LEAD_TARGET).toBe("w1:p1");
        return Promise.resolve({ stdout: "w1:p8\n", stderr: "" });
      },
    });
    expect(result).toEqual({ outcome: "ok", paneId: "w1:p8", alreadyOpen: false });
  });

  it("closes the labelled board pane and not this console", async () => {
    const calls: Array<readonly string[]> = [];
    const result = await closeHerdLeadCompanion({
      env: { HERDR_ENV: "1", HERDR_PANE_ID: "w15:p6" },
      runCommand: (_command, args) => {
        calls.push(args);
        if (args[0] === "pane" && args[1] === "list") {
          return Promise.resolve({
            stdout: JSON.stringify({
              result: {
                panes: [
                  { pane_id: "w15:p6", agent: "clankie" },
                  { pane_id: "w15:pT", label: "Herd Lead" },
                ],
              },
            }),
            stderr: "",
          });
        }
        return Promise.resolve({ stdout: "", stderr: "" });
      },
    });
    expect(result).toEqual({ outcome: "closed", paneId: "w15:pT" });
    expect(calls).toEqual([
      ["pane", "list"],
      ["pane", "close", "w15:pT"],
    ]);
  });

  it("treats a missing board as already closed", async () => {
    await expect(
      closeHerdLeadCompanion({
        env: { HERDR_ENV: "1", HERDR_PANE_ID: "w15:p6" },
        runCommand: () =>
          Promise.resolve({ stdout: JSON.stringify({ result: { panes: [{ pane_id: "w15:p6" }] } }), stderr: "" }),
      }),
    ).resolves.toEqual({ outcome: "absent" });
  });
});

describe("/board", () => {
  it("opens the companion board and prints where it landed", async () => {
    const results: Array<{ command: string; text: string; tone: string }> = [];
    const commands = buildConsoleCommands({
      herdLead: {
        ensure: () => Promise.resolve({ outcome: "ok", paneId: "w3:p9K", alreadyOpen: false }),
        focus: () => Promise.resolve({ outcome: "ok", paneId: "w3:p9K", alreadyOpen: true }),
        close: () => Promise.resolve({ outcome: "closed", paneId: "w3:p9K" }),
      },
    });
    const command = commands.find((candidate) => candidate.name === "board");
    if (command === undefined) throw new Error("board command not found");
    const shell = {
      insertCommandResult(invocation: string, text: string, tone: string) {
        results.push({ command: invocation, text, tone });
      },
    } as ClankieFaceShell;

    await command.run("", shell);
    expect(results[0]).toMatchObject({
      command: "/board",
      tone: "success",
      text: expect.stringContaining("w3:p9K"),
    });

    results.length = 0;
    await command.run("focus", shell);
    expect(results[0]?.text).toContain("already open");

    results.length = 0;
    await command.run("close", shell);
    expect(results[0]?.text).toContain("closed");
  });

  it("says so when the console is not inside herdr", () => {
    const formatted = formatHerdLeadCompanionResult({ outcome: "skipped", reason: "not_in_herdr" }, "open");
    expect(formatted.tone).toBe("error");
    expect(formatted.text).toContain("herdr pane");
  });
});
