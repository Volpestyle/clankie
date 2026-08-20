import { describe, expect, it } from "vitest";
import { emptySettings, type ClankieSettings, type SettingsStore } from "@clankie/settings";
import { buildPersonaCommands } from "../src/persona-commands.ts";
import type { SetupFlow } from "../src/shell/setup-flow.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";

describe("/persona", () => {
  it("loads the current character, name, and aliases into their editors", async () => {
    let current: ClankieSettings = {
      ...emptySettings(),
      persona: {
        ...emptySettings().persona,
        aliases: ["Clanky", "Clank"],
        characterNotes: "First paragraph.\n\nSecond paragraph.",
      },
    };
    const settings = {
      path: "/tmp/settings.json",
      load: async () => current,
      update: async (mutate: (settings: ClankieSettings) => ClankieSettings) => {
        current = mutate(current);
        return current;
      },
    } as unknown as SettingsStore;
    const selections = ["character", "names", "done"];
    const prompts: Parameters<SetupFlow["readText"]>[0][] = [];
    const flow = {
      begin: () => undefined,
      end: () => undefined,
      readSelect: async () => selections.shift(),
      readText: async (options: Parameters<SetupFlow["readText"]>[0]) => {
        prompts.push(options);
        return options.defaultValue;
      },
      renderLine: () => undefined,
    } as unknown as SetupFlow;
    const shell = { setupFlow: flow } as unknown as ClankieFaceShell;

    await buildPersonaCommands({ settings })[0]!.run("", shell);

    expect(prompts).toMatchObject([
      { defaultValue: current.persona.characterNotes, multiline: true },
      { defaultValue: "Clankie" },
      { defaultValue: "Clanky, Clank" },
    ]);
  });

  it("returns from aliases to the name step", async () => {
    let current = emptySettings();
    const settings = {
      path: "/tmp/settings.json",
      load: async () => current,
      update: async (mutate: (settings: ClankieSettings) => ClankieSettings) => {
        current = mutate(current);
        return current;
      },
    } as unknown as SettingsStore;
    const selections = ["names", "done"];
    const responses: Array<string | undefined> = ["Clankie Jr", undefined, "Clankie Jr", "Clanky"];
    const messages: string[] = [];
    const defaults: Array<string | undefined> = [];
    const flow = {
      begin: () => undefined,
      end: () => undefined,
      readSelect: async () => selections.shift(),
      readText: async (options: Parameters<SetupFlow["readText"]>[0]) => {
        messages.push(options.message);
        defaults.push(options.defaultValue);
        return responses.shift();
      },
      renderLine: () => undefined,
    } as unknown as SetupFlow;

    await buildPersonaCommands({ settings })[0]!.run("", {
      setupFlow: flow,
    } as unknown as ClankieFaceShell);

    expect(messages).toEqual([
      "Name",
      "Other names he answers to (comma separated)",
      "Name",
      "Other names he answers to (comma separated)",
    ]);
    expect(defaults).toEqual(["Clankie", "", "Clankie Jr", ""]);
  });
});
