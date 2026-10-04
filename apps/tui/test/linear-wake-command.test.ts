import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { runLinearCommand } from "../src/command/linear.ts";
import { buildConsoleCommands } from "../src/commands.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it("shows defaults, validates and persists partial flag edits, and preserves rules when clearing the webhook", async () => {
  const root = await mkdtemp(join(tmpdir(), "linear-wake-cli-"));
  roots.push(root);
  const settings = new SettingsStore(join(root, "settings.json"));
  const options = { settings, credentials: { get: async () => undefined } };
  expect(await runLinearCommand(["wake"], options)).toMatchObject({
    wake: { actors: ["owner"], excludedNotificationTypes: ["issueSubscribed"] },
  });
  await runLinearCommand(
    ["wake", "set", "--owner-user-ids", "james", "--actors", "owner,self", "--types", "issueMention"],
    options,
  );
  expect(await runLinearCommand(["wake", "show"], options)).toMatchObject({
    wake: {
      ownerUserIds: ["james"],
      actors: ["owner", "self"],
      notificationTypes: ["issueMention"],
      excludedNotificationTypes: ["issueSubscribed"],
    },
  });
  for (const args of [
    ["--actors", "anybody"],
    ["--types"],
    ["--unknown", "value"],
    ["--actors", "owner", "--actors", "self"],
  ])
    await expect(runLinearCommand(["wake", "set", ...args], options)).rejects.toThrow();
  await runLinearCommand(["wake", "set", "--types", "none"], options);
  await runLinearCommand(["webhook", "clear"], options);
  expect((await settings.load()).linearWebhook.wake).toMatchObject({
    actors: ["owner", "self"],
    notificationTypes: [],
  });
  await runLinearCommand(["wake", "set", "--json-stdin"], {
    ...options,
    stdin: Readable.from(['{"actors":["human"]}']),
  });
  expect((await settings.load()).linearWebhook.wake).toMatchObject({ actors: ["human"], ownerUserIds: [] });
});
it("bare /linear opens Follow Linear and its help names ownership and handoff commands", async () => {
  const linearFollowMenu = vi.fn(async () => undefined);
  const command = buildConsoleCommands({ linearFollowMenu }).find((item) => item.name === "linear")!;
  const shell = {} as ClankieFaceShell;
  await command.run("", shell);
  expect(linearFollowMenu).toHaveBeenCalledExactlyOnceWith(shell);
  expect(command.argumentHint).toContain("wake show/set");
  expect(command.argumentHint).toContain("work list/bind/unbind");
  expect(command.argumentHint).toContain("inbox read/ack/handoff");
});
