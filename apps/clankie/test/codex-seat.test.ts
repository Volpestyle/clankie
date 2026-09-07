import { describe, expect, it } from "vitest";
import { parseHerdrForegroundProcesses, resolveCodexSessionId } from "../src/captain/codex-seat.ts";

const SESSION = "01a0740e-ea76-7aa2-8795-524c00368e71";
const PROCESS_INFO = JSON.stringify({
  result: {
    process_info: {
      foreground_processes: [
        { pid: 20879, name: "zsh", argv0: "zsh", argv: ["-zsh"] },
        { pid: 21290, name: "codex", argv0: "codex", argv: ["codex"] },
      ],
    },
  },
});
const OPEN_FILES = [
  "p21290",
  "fcwd",
  "n/Users/james/dev/grapple-game",
  "f0",
  "n/dev/ttys001",
  "f3",
  `n/Users/james/.codex/sessions/2026/09/05/rollout-2026-09-05T19-12-09-${SESSION}.jsonl`,
].join("\n");

describe("Codex session resolver", () => {
  it("reads the uuid from the first open rollout file of the codex process", () => {
    expect(resolveCodexSessionId(parseHerdrForegroundProcesses(PROCESS_INFO), OPEN_FILES)).toBe(SESSION);
  });

  it("accepts argv0 as a path whose basename is codex", () => {
    const processes = parseHerdrForegroundProcesses(
      JSON.stringify({
        result: {
          process_info: {
            foreground_processes: [
              { pid: 99, name: "codex", argv0: "/opt/homebrew/bin/codex", argv: ["codex"] },
            ],
          },
        },
      }),
    );
    expect(resolveCodexSessionId(processes, OPEN_FILES)).toBe(SESSION);
  });

  it("returns undefined when no foreground process is codex", () => {
    const processes = parseHerdrForegroundProcesses(
      JSON.stringify({
        result: { process_info: { foreground_processes: [{ pid: 1, name: "zsh", argv0: "zsh" }] } },
      }),
    );
    expect(resolveCodexSessionId(processes, OPEN_FILES)).toBeUndefined();
  });

  it("returns undefined when the codex process has no rollout open", () => {
    expect(
      resolveCodexSessionId(parseHerdrForegroundProcesses(PROCESS_INFO), "p21290\nfcwd\nn/Users/james\n"),
    ).toBeUndefined();
  });

  it("uses the first rollout when several are listed", () => {
    const first = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const listed = [
      `n/Users/james/.codex/sessions/2026/09/05/rollout-2026-09-05T01-00-00-${first}.jsonl`,
      `n/Users/james/.codex/sessions/2026/09/05/rollout-2026-09-05T19-12-09-${SESSION}.jsonl`,
    ].join("\n");
    expect(resolveCodexSessionId(parseHerdrForegroundProcesses(PROCESS_INFO), listed)).toBe(first);
  });
});
