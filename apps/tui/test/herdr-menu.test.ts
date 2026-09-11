import { expect, it, vi } from "vitest";
import { emptySettings, type SettingsStore, type ClankieSettings } from "@clankie/settings";
import { buildConsoleCommands } from "../src/commands.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";

const optionValues = (call: unknown[]) =>
  (call[0] as { options: { value: string }[] }).options.map((item) => item.value);

function herdrMenu(restartCaptain?: () => Promise<void>) {
  let current = emptySettings();
  const settings = {
    path: "/tmp/herdr-menu-settings.json",
    load: async () => current,
    update: async (mutate: (value: ClankieSettings) => ClankieSettings) => (current = mutate(current)),
  } as SettingsStore;
  const readSelect = vi.fn();
  const end = vi.fn();
  const shell = {
    setupFlow: { begin: vi.fn(), end, readSelect, renderLine: vi.fn(), setStatus: vi.fn() },
    insertCommandResult: vi.fn(),
  } as unknown as ClankieFaceShell;
  const command = buildConsoleCommands({
    settings,
    herdrSessions: async () => [
      { name: "default", running: false, socketPath: "/tmp/default.sock" },
      { name: "workers", running: true, socketPath: "/tmp/workers.sock" },
    ],
    ...(restartCaptain ? { restartCaptain } : {}),
  }).find((item) => item.name === "herdr")!;
  return { readSelect, end, run: () => command.run("", shell), herdr: () => current.herdr };
}

it("picks a listed session, saves before restarting, and allows cancellation", async () => {
  const restartCaptain = vi.fn(async () => {
    expect(menu.herdr()).toEqual({ runtime: "external", session: "workers" });
  });
  const menu = herdrMenu(restartCaptain);
  menu.readSelect
    .mockResolvedValueOnce("session")
    .mockResolvedValueOnce("workers")
    .mockResolvedValueOnce("restart");
  await menu.run();
  expect(optionValues(menu.readSelect.mock.calls[0]!)).toEqual(["session", "runtime", "open", "restart"]);
  expect(optionValues(menu.readSelect.mock.calls[1]!)).toEqual(["workers", "default"]);
  expect(restartCaptain).toHaveBeenCalledTimes(1);
  expect(menu.end).toHaveBeenCalledTimes(1);
  menu.readSelect.mockResolvedValueOnce("runtime").mockResolvedValueOnce(undefined);
  await menu.run();
  expect(menu.herdr().session).toBe("workers");
  expect(restartCaptain).toHaveBeenCalledTimes(1);
  expect(menu.end).toHaveBeenCalledTimes(2);
});

it("asks which session when the runtime is set to external", async () => {
  const menu = herdrMenu();
  menu.readSelect
    .mockResolvedValueOnce("runtime")
    .mockResolvedValueOnce("external")
    .mockResolvedValueOnce("workers");
  await menu.run();
  expect(menu.herdr()).toEqual({ runtime: "external", session: "workers" });
});
