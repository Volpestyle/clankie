import { expect, it } from "vitest";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";

// ADR 0323: Herdr 0.9.3's `pane send-keys` refuses home, end, pageup, pagedown
// and delete as invalid_key, so the runner types their xterm bytes with
// `pane send-text` and presses every other key by name, in order. Proved live
// against herdr 0.9.3, whose pane received exactly these bytes.
it("presses the keys Herdr has no name for as the bytes an xterm sends, in order", async () => {
  const calls: (readonly string[])[] = [];
  const runner = createHerdrWatchRunner(
    undefined,
    async (args) => {
      calls.push(args);
      return "{}";
    },
    undefined,
    { localCodexRecovery: false },
  );
  await runner.sendKeys!("w1:p1", [
    "up",
    "esc",
    "pageup",
    "ctrl+pagedown",
    "home",
    "shift+end",
    "alt+delete",
    "q",
    "enter",
  ]);
  expect(calls).toEqual([
    ["pane", "send-keys", "w1:p1", "up", "esc"],
    ["pane", "send-text", "w1:p1", "\u001b[5~"],
    ["pane", "send-text", "w1:p1", "\u001b[6;5~"],
    ["pane", "send-text", "w1:p1", "\u001b[H"],
    ["pane", "send-text", "w1:p1", "\u001b[1;2F"],
    ["pane", "send-text", "w1:p1", "\u001b[3;3~"],
    ["pane", "send-keys", "w1:p1", "q", "enter"],
  ]);
});
