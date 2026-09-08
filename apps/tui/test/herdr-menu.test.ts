import { expect, it, vi } from "vitest";
import { emptySettings, type SettingsStore, type ClankieSettings } from "@clankie/settings";
import { buildConsoleCommands } from "../src/commands.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";

it("selects a session through modals, saves before restarting, and allows cancellation", async () => {
  let current = emptySettings();
  const settings = {
    path: "/tmp/herdr-menu-settings.json",
    load: async () => current,
    update: async (mutate: (value: ClankieSettings) => ClankieSettings) => (current = mutate(current)),
  } as SettingsStore;
  const restartCaptain = vi.fn(async () => {
    expect(current.herdr).toEqual({ runtime: "external", session: "workers" });
  });
  const readSelect = vi.fn().mockResolvedValueOnce("session").mockResolvedValueOnce("restart");
  const end = vi.fn();
  const shell = {
    setupFlow: {
      begin: vi.fn(),
      end,
      readSelect,
      readText: vi.fn().mockResolvedValue(" workers "),
      renderLine: vi.fn(),
      setStatus: vi.fn(),
    },
    insertCommandResult: vi.fn(),
  } as unknown as ClankieFaceShell;
  const command = buildConsoleCommands({ settings, restartCaptain }).find((item) => item.name === "herdr")!;
  await command.run("", shell);
  expect(readSelect.mock.calls[0]![0].options.map((item: { value: string }) => item.value)).toEqual([
    "session",
    "runtime",
    "open",
    "restart",
  ]);
  expect(restartCaptain).toHaveBeenCalledTimes(1);
  expect(end).toHaveBeenCalledTimes(1);
  readSelect.mockResolvedValueOnce("runtime").mockResolvedValueOnce(undefined);
  await command.run("", shell);
  expect(current.herdr.session).toBe("workers");
  expect(restartCaptain).toHaveBeenCalledTimes(1);
  expect(end).toHaveBeenCalledTimes(2);
});
