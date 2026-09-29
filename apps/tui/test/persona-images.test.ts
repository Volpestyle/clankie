import { buildPersonaCommands } from "../src/persona-commands.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SettingsStore } from "@clankie/settings";
import { afterEach, expect, it } from "vitest";
import { runPersonaCommand } from "../src/command/persona.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("sets, diagnoses and clears a folder without touching owner images", async () => {
  const root = await mkdtemp(join(tmpdir(), "persona-cli-"));
  roots.push(root);
  const settings = new SettingsStore(join(root, "settings.json"));
  const options = { settings, env: { XDG_CACHE_HOME: root } };
  const result = await runPersonaCommand(["images", "set", "branding"], options);
  expect(result.persona.imagesDir).toBe(resolve("branding"));
  expect(result.images?.count).toBe(3);
  expect(result.restart).toContain("Restart Clankie");
  expect(
    (await runPersonaCommand(["images", "status"], options)).images?.files.every(
      (f) => f.status === "loaded",
    ),
  ).toBe(true);
  expect((await runPersonaCommand(["images", "clear"], options)).images?.count).toBe(0);
  expect((await settings.load()).persona.imagesDir).toBe("");
  await expect(runPersonaCommand(["images", "set"], options)).rejects.toThrow("Usage");
  const missing = await runPersonaCommand(["images", "set", join(root, "missing")], options);
  expect(missing.images?.error).toBeTruthy();
});

it("sets and clears images through the TUI Persona images choice", async () => {
  const root = await mkdtemp(join(tmpdir(), "persona-tui-"));
  roots.push(root);
  const settings = new SettingsStore(join(root, "settings.json"));
  const selections = ["images", "set", "images", "status", "images", "clear", "done"];
  const rendered: string[] = [];
  const shell = {
    setupFlow: {
      begin() {},
      end() {},
      readSelect: async () => selections.shift(),
      readText: async () => resolve("branding"),
      renderLine: (line: string) => rendered.push(line),
    },
  } as unknown as ClankieFaceShell;
  await buildPersonaCommands({ settings })[0]!.run("", shell);
  expect((await settings.load()).persona.imagesDir).toBe("");
  expect(rendered.join("\n")).toContain('"count": 3');
  expect(rendered.join("\n")).toContain('"count": 0');
  expect(rendered.join("\n")).toContain("Restart Clankie");
});
