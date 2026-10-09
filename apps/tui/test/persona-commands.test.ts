import { afterEach, describe, expect, it } from "vitest";
import { emptySettings } from "@clankie/settings";
import { buildPersonaCommands } from "../src/persona-commands.ts";
import type { SetupFlow } from "../src/shell/setup-flow.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";

import { ownerSettingsFixture } from "./owner-settings-fixture.ts";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

describe("/persona", () => {
  it("loads the current character, name, and aliases into their editors", async () => {
    const current = {
      ...emptySettings(),
      persona: {
        ...emptySettings().persona,
        aliases: ["Clanky", "Clank"],
        characterNotes: "First paragraph.\n\nSecond paragraph.",
      },
    };
    const fixture = await ownerSettingsFixture();
    cleanups.push(fixture.close);
    const settings = fixture.settings;
    await settings.update(() => current);
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

    await buildPersonaCommands({ ...fixture.options, settings })[0]!.run("", shell);

    expect(prompts).toMatchObject([
      { defaultValue: current.persona.characterNotes, multiline: true },
      { defaultValue: "Clankie" },
      { defaultValue: "Clanky, Clank" },
    ]);
  });

  it("returns from aliases to the name step", async () => {
    const fixture = await ownerSettingsFixture();
    cleanups.push(fixture.close);
    const settings = fixture.settings;
    const selections = ["names", "done"];
    const responses: Array<string | undefined> = ["Clankie Jr", undefined, "Clankie Jr", "Clanky"];
    const defaults: Array<string | undefined> = [];
    const flow = {
      begin: () => undefined,
      end: () => undefined,
      readSelect: async () => selections.shift(),
      readText: async (options: Parameters<SetupFlow["readText"]>[0]) => {
        defaults.push(options.defaultValue);
        return responses.shift();
      },
      renderLine: () => undefined,
    } as unknown as SetupFlow;

    await buildPersonaCommands({ ...fixture.options, settings })[0]!.run("", {
      setupFlow: flow,
    } as unknown as ClankieFaceShell);

    expect(defaults).toEqual(["Clankie", "", "Clankie Jr", ""]);
  });
});

it("refuses a stale persona wizard draft instead of overwriting another surface", async () => {
  const fixture = await ownerSettingsFixture();
  cleanups.push(fixture.close);
  const selections = ["character", "done"];
  const shell = {
    setupFlow: {
      begin() {},
      end() {},
      renderLine() {},
      readSelect: async () => selections.shift(),
      readText: async () => {
        await fixture.settings.update((current) => ({
          ...current,
          persona: { ...current.persona, displayName: "New name from app" },
        }));
        return "Stale character draft";
      },
    },
  } as unknown as ClankieFaceShell;
  await expect(buildPersonaCommands(fixture.options)[0]!.run("", shell)).rejects.toThrow(/Settings changed/i);
  expect((await fixture.settings.load()).persona).toMatchObject({
    displayName: "New name from app",
    characterNotes: "",
  });
});

it("refuses service-unavailable mutations without changing the local settings file", async () => {
  const fixture = await ownerSettingsFixture();
  cleanups.push(fixture.close);
  await fixture.settings.update((current) => current);
  const before = await fixture.settings.load();
  const { runPersonaCommand } = await import("../src/command/persona.ts");
  const { runVoiceCommand } = await import("../src/command/voice.ts");
  const options = { ...fixture.options, host: "http://127.0.0.1:1" };
  await expect(
    runPersonaCommand(["set", "--display-name", "Unsaved local draft"], options),
  ).rejects.toThrow();
  await expect(runVoiceCommand(["brain", "set", "xai"], options)).rejects.toThrow();
  expect(await fixture.settings.load()).toEqual(before);
});
