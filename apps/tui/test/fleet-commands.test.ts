import { fleetSettingsClient } from "./fixtures/fleet-settings-client.ts";
import {
  FleetAutonomySchema,
  FleetResourcePolicySchema,
  ProjectSchema,
  effectiveHireProfile,
} from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptySettings, type ClankieSettings, SettingsStore } from "@clankie/settings";
import { fleetStatus, formatFleetLines, runFleetCommand } from "../src/command/fleet.ts";
import { buildFleetCommands } from "../src/fleet-commands.ts";
import type { SetupFlow } from "../src/shell/setup-flow.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";

function stubStore(initial: ClankieSettings = emptySettings()): {
  settings: SettingsStore;
  read: () => ClankieSettings;
} {
  let current = initial;
  return {
    read: () => current,
    settings: {
      path: "/tmp/settings.json",
      load: async () => current,
      update: async (mutate: (settings: ClankieSettings) => ClankieSettings) => {
        current = mutate(current);
        return current;
      },
    } as unknown as SettingsStore,
  };
}

/**
 * Routing preference is free text on purpose (no role enum), so the contract to
 * hold is only that what the owner typed round-trips and that clearing empties
 * it rather than leaving a stale preference in the prompt.
 */
describe("clankie fleet", () => {
  it("defaults to empty, so an owner who says nothing leaves the choice to him", async () => {
    const { settings } = stubStore();
    expect((await runFleetCommand([], fleetSettingsClient(settings))).fleet.notes).toBe("");
    expect(formatFleetLines((await fleetStatus(fleetSettingsClient(settings))).fleet).join("\n")).toContain(
      "he picks a harness per job on his own",
    );
  });

  it("round-trips the owner's notes and clears them back to empty", async () => {
    const { settings, read } = stubStore();

    const set = await runFleetCommand(["set", "--notes", "grok attacks what codex builds."], {
      ...fleetSettingsClient(settings),
    });
    expect(set.fleet.notes).toBe("grok attacks what codex builds.");
    expect(read().fleet.notes).toBe("grok attacks what codex builds.");
    expect(set.restart).toBe("clankie restart");

    expect((await runFleetCommand(["clear"], fleetSettingsClient(settings))).fleet.notes).toBe("");
  });

  it("refuses a shape it cannot store rather than silently truncating", async () => {
    const { settings } = stubStore();
    await expect(
      runFleetCommand(["set", "--notes", "x".repeat(4_001)], fleetSettingsClient(settings)),
    ).rejects.toThrow(/under 4000/u);
    await expect(runFleetCommand(["nope"], fleetSettingsClient(settings))).rejects.toThrow(/Usage/u);
  });

  it("opens the editor on what is already configured and saves what comes back", async () => {
    const { settings, read } = stubStore({
      ...emptySettings(),
      fleet: {
        notes: "codex is the workhorse.",
        size: "large",
        models: "optimal",
        tools: "connected",
        peerMessages: "on",
      },
    });
    const prompts: Parameters<SetupFlow["readText"]>[0][] = [];
    const selects: Parameters<SetupFlow["readSelect"]>[0][] = [];
    const picks = [
      "small",
      "efficient",
      "codex",
      "xhigh",
      "off",
      "off",
      "owner",
      "owner",
      "hands-off",
      "owner",
      "lead",
      "owner",
      "review_and_seal",
    ];
    const flow = {
      begin: () => undefined,
      end: () => undefined,
      readSelect: async (options: Parameters<SetupFlow["readSelect"]>[0]) => {
        selects.push(options);
        return picks.shift();
      },
      readText: async (options: Parameters<SetupFlow["readText"]>[0]) => {
        prompts.push(options);
        if (options.message.includes("worker model")) return " gpt-6.1-sol ";
        if (options.message.includes("worker account")) return "";
        return options.message.includes("reporting style")
          ? "Plain evidence."
          : "  claude when it needs skills.  ";
      },
      renderLine: () => undefined,
    } as unknown as SetupFlow;

    await buildFleetCommands(fleetSettingsClient(settings))[0]!.run("", {
      setupFlow: flow,
    } as unknown as ClankieFaceShell);

    expect(selects).toMatchObject([
      { currentValue: "large" },
      { currentValue: "optimal" },
      { currentValue: "auto" },
      { currentValue: "auto" },
      { currentValue: "connected" },
      { currentValue: "on" },
      { currentValue: "lead" },
      { currentValue: "lead" },
      { currentValue: "hands-off" },
      { currentValue: "lead" },
      { currentValue: "lead" },
      { currentValue: "owner" },
      { currentValue: "change_run_read" },
    ]);
    expect(prompts).toMatchObject([
      { defaultValue: "" },
      { defaultValue: "" },
      { defaultValue: "Short and plain.", multiline: true },
      { defaultValue: "codex is the workhorse.", multiline: true },
    ]);
    expect(read().fleet).toEqual({
      notes: "claude when it needs skills.",
      hire: { harness: "codex", model: "gpt-6.1-sol", effort: "xhigh" },
      size: "small",
      models: "efficient",
      tools: "off",
      peerMessages: "off",
    });
    expect(read().autonomy.fleet).toEqual(
      FleetAutonomySchema.parse({
        closure: "owner",
        machineSetup: "owner",
        hardToUndo: "lead",
        commit: "owner",
        push: "lead",
        verification: "review_and_seal",
        reportingStyle: "Plain evidence.",
      }),
    );
  });
});

/**
 * The budget is two targets the lead sizes toward, never a cap: the contract is
 * that each flag round-trips alone, leaves the others as they were, refuses a
 * value it cannot store, and that `clear` puts the no-limit default back.
 */
describe("clankie fleet budget", () => {
  it("applies the tool kill switch independently and rejects unsupported or repeated values", async () => {
    const { settings, read } = stubStore();
    await runFleetCommand(["set", "--notes", "keep me", "--size", "small"], fleetSettingsClient(settings));
    const off = await runFleetCommand(["set", "--tools", "off"], fleetSettingsClient(settings));
    expect(off.fleet).toEqual({
      notes: "keep me",
      size: "small",
      models: "optimal",
      tools: "off",
      peerMessages: "on",
      ...FleetAutonomySchema.parse({}),
    });
    expect(formatFleetLines(off.fleet).join("\n")).toContain("fleet tool access disabled");
    await expect(runFleetCommand(["set", "--tools", "all"], fleetSettingsClient(settings))).rejects.toThrow(
      "--tools must be connected or off",
    );
    await expect(
      runFleetCommand(["set", "--tools", "off", "--tools", "connected"], fleetSettingsClient(settings)),
    ).rejects.toThrow("Usage");
    expect(read().fleet.tools).toBe("off");
    expect((await runFleetCommand(["clear"], fleetSettingsClient(settings))).fleet.tools).toBe("connected");
  });
  it("defaults to maximum bandwidth with the strongest models", async () => {
    const { settings } = stubStore();
    const status = await runFleetCommand(["status"], fleetSettingsClient(settings));
    expect(status.fleet).toMatchObject({
      size: "max",
      models: "optimal",
      tools: "connected",
      peerMessages: "on",
    });
    const lines = formatFleetLines(status.fleet).join("\n");
    expect(lines).toContain("fleet size: max");
    expect(lines).toContain("No ceiling");
    expect(lines).toContain("models: optimal");
  });

  it("sets size and models independently of the notes, and clear restores every default", async () => {
    const { settings, read } = stubStore();
    await runFleetCommand(["set", "--notes", "codex is the workhorse."], fleetSettingsClient(settings));
    const set = await runFleetCommand(
      ["set", "--size", "solo", "--models", "efficient"],
      fleetSettingsClient(settings),
    );
    expect(set.fleet).toEqual({
      notes: "codex is the workhorse.",
      size: "solo",
      models: "efficient",
      tools: "connected",
      peerMessages: "on",
      ...FleetAutonomySchema.parse({}),
    });
    await runFleetCommand(["set", "--models", "optimal"], fleetSettingsClient(settings));
    expect(read().fleet).toEqual({
      notes: "codex is the workhorse.",
      size: "solo",
      models: "optimal",
      tools: "connected",
      peerMessages: "on",
    });
    expect((await runFleetCommand(["clear"], fleetSettingsClient(settings))).fleet).toEqual({
      notes: "",
      size: "max",
      models: "optimal",
      tools: "connected",
      peerMessages: "on",
      ...FleetAutonomySchema.parse({}),
    });
  });

  it("refuses unknown values, repeated flags and a flag without a value", async () => {
    const { settings, read } = stubStore();
    await expect(runFleetCommand(["set", "--size", "huge"], fleetSettingsClient(settings))).rejects.toThrow(
      /--size must be one of/u,
    );
    await expect(
      runFleetCommand(["set", "--models", "cheap"], fleetSettingsClient(settings)),
    ).rejects.toThrow(/--models must be one of/u);
    await expect(
      runFleetCommand(["set", "--size", "max", "--size", "solo"], fleetSettingsClient(settings)),
    ).rejects.toThrow(/Usage/u);
    await expect(runFleetCommand(["set", "--size"], fleetSettingsClient(settings))).rejects.toThrow(/Usage/u);
    await expect(runFleetCommand(["set"], fleetSettingsClient(settings))).rejects.toThrow(/Usage/u);
    expect(read().fleet).toEqual({
      notes: "",
      size: "max",
      models: "optimal",
      tools: "connected",
      peerMessages: "on",
    });
  });
});

describe("clankie fleet peer messages", () => {
  it("changes peer messages independently, reports the switch and clears back to on", async () => {
    const { settings, read } = stubStore();
    await runFleetCommand(["set", "--tools", "off", "--notes", "keep me"], fleetSettingsClient(settings));
    const off = await runFleetCommand(["set", "--peer-messages", "off"], fleetSettingsClient(settings));
    expect(off.fleet).toEqual({
      notes: "keep me",
      size: "max",
      models: "optimal",
      tools: "off",
      peerMessages: "off",
      ...FleetAutonomySchema.parse({}),
    });
    expect(formatFleetLines(off.fleet).join("\n")).toContain(
      "peer messages: off — new messages between fleet workers disabled",
    );
    await runFleetCommand(["set", "--peer-messages", "on"], fleetSettingsClient(settings));
    expect(read().fleet).toMatchObject({ tools: "off", peerMessages: "on" });
    await runFleetCommand(["set", "--peer-messages", "off"], fleetSettingsClient(settings));
    expect((await runFleetCommand(["clear"], fleetSettingsClient(settings))).fleet.peerMessages).toBe("on");
  });

  it("rejects unsupported, repeated and missing peer-message values without changing the setting", async () => {
    const { settings, read } = stubStore();
    await expect(
      runFleetCommand(["set", "--peer-messages", "connected"], fleetSettingsClient(settings)),
    ).rejects.toThrow("--peer-messages must be on or off");
    await expect(
      runFleetCommand(
        ["set", "--peer-messages", "off", "--peer-messages", "on"],
        fleetSettingsClient(settings),
      ),
    ).rejects.toThrow("Usage");
    await expect(runFleetCommand(["set", "--peer-messages"], fleetSettingsClient(settings))).rejects.toThrow(
      "Usage",
    );
    expect(read().fleet.peerMessages).toBe("on");
  });
});

/** Real settings files exercise the CLI/profile/schema persistence boundary. */
describe("fleet worker defaults persistence", () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "clankie-worker-defaults-"));
    const settings = new SettingsStore(join(root, "settings.json"));
    const options = {
      ...fleetSettingsClient(settings),
      cwd: root,
    };
    return { root, settings, options };
  }

  it("patches one field at a time, preserves advanced defaults and reports effective role precedence", async () => {
    const f = await fixture();
    try {
      const resources = FleetResourcePolicySchema.parse({ heavySlots: 3, simulatorSlots: 0 });
      const advanced = {
        subagents: { model: "gpt-6.1-sol", effort: "medium" as const },
        delegation: "native-first" as const,
        account: "second",
        placement: "new-tab" as const,
      };
      await f.settings.update((current) => ({
        ...current,
        fleet: { ...current.fleet, hire: advanced, resources },
        autonomy: { fleet: { ...current.autonomy.fleet, commit: "owner" } },
        projects: {
          ...current.projects,
          projects: [
            ProjectSchema.parse({
              id: "example",
              name: "Example",
              workerCap: 2,
              roles: [{ role: "builder", model: "role-model", effort: "high" }],
            }),
          ],
        },
      }));
      await runFleetCommand(["set", "--harness", "codex"], f.options);
      await runFleetCommand(["set", "--model", " gpt-6.1-sol ", "--effort", "xhigh"], f.options);
      const fresh = await new SettingsStore(f.settings.path).load();
      expect(fresh.fleet.hire).toEqual({
        ...advanced,
        harness: "codex",
        model: "gpt-6.1-sol",
        effort: "xhigh",
      });
      expect(fresh.fleet.resources).toEqual(resources);
      expect(fresh.autonomy.fleet.commit).toBe("owner");
      const status = await runFleetCommand(["show"], f.options);
      expect(status.roleProfiles[0]?.profile).toMatchObject({
        ...advanced,
        model: "role-model",
        effort: "high",
      });
      expect(
        effectiveHireProfile({ model: "explicit-model" }, status.roleProfiles[0]?.profile, fresh.fleet.hire)
          .model,
      ).toBe("explicit-model");
      expect(formatFleetLines(status.fleet).join("\n")).toContain(
        "worker defaults: harness codex, model gpt-6.1-sol, effort xhigh",
      );
      const output: string[] = [];
      await buildFleetCommands(f.options)[0]!.run("show", {
        insertCommandResult: (_command: string, text: string) => output.push(text),
      } as unknown as ClankieFaceShell);
      expect(output.join("\n")).toContain("worker defaults: harness codex, model gpt-6.1-sol, effort xhigh");
      await runFleetCommand(["set", "--model", "auto"], f.options);
      expect((await f.settings.load()).fleet.hire).toEqual({
        ...advanced,
        harness: "codex",
        effort: "xhigh",
      });
      await runFleetCommand(["set", "--harness", "auto", "--effort", "auto"], f.options);
      expect((await f.settings.load()).fleet.hire).toEqual(advanced);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("refuses concurrent defaults edits and clears the last field", async () => {
    const f = await fixture();
    try {
      const outcomes = await Promise.allSettled([
        runFleetCommand(["set", "--model", "gpt-6.1-sol"], f.options),
        runFleetCommand(["set", "--effort", "xhigh"], f.options),
      ]);
      expect(outcomes.filter((result) => result.status === "rejected")).toHaveLength(1);
      const concurrent = (await f.settings.load()).fleet.hire;
      expect(concurrent?.model === "gpt-6.1-sol" || concurrent?.effort === "xhigh").toBe(true);
      const cleared = await runFleetCommand(["set", "--model", "auto", "--effort", "auto"], f.options);
      expect(cleared.fleet.hire).toEqual({});
      expect(formatFleetLines(cleared.fleet).join("\n")).toContain(
        "worker defaults: none (he picks harness, model, effort and account per job)",
      );
      await runFleetCommand(["set", "--harness", "claude"], f.options);
      const reset = await runFleetCommand(["clear"], f.options);
      expect(reset.fleet.hire).toBeUndefined();
      expect((await new SettingsStore(f.settings.path).load()).fleet.hire).toBeUndefined();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("replaces JSON profiles and rejects mixed, repeated and malformed field flags before saving", async () => {
    const f = await fixture();
    try {
      await runFleetCommand(["set", "--model", "original"], f.options);
      const profile = join(f.root, "profile.json");
      await writeFile(profile, JSON.stringify({ account: "second", subagents: null }));
      for (const args of [
        ["--harness", "unknown"],
        ["--model", ""],
        ["--model", " "],
        ["--model", "x".repeat(201)],
        ["--effort", " "],
        ["--effort", "x".repeat(65)],
        ["--model", "one", "--model", "two"],
        ["--harness", "auto", "--harness", "codex"],
        ["--effort", "high", "--effort", "low"],
        ["--model"],
        ["--hire-profile", profile, "--model", "new"],
        ["--effort", "high", "--hire-profile", profile],
      ]) {
        const before = await readFile(f.settings.path, "utf8");
        await expect(runFleetCommand(["set", ...args], f.options)).rejects.toThrow();
        expect(await readFile(f.settings.path, "utf8")).toBe(before);
      }
      await runFleetCommand(["set", "--hire-profile", profile], f.options);
      expect((await f.settings.load()).fleet.hire).toEqual({ account: "second", subagents: null });
      // Top-level effort remains harness-defined, matching the current profile schema.
      await runFleetCommand(["set", "--effort", "custom-effort"], f.options);
      expect((await f.settings.load()).fleet.hire?.effort).toBe("custom-effort");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it("the TUI can return fields to auto while preserving advanced defaults and custom effort options", async () => {
    const f = await fixture();
    try {
      await f.settings.update((current) => ({
        ...current,
        fleet: {
          ...current.fleet,
          hire: {
            harness: "claude",
            model: "old-model",
            effort: "custom-effort",
            account: "second",
            subagents: null,
          },
        },
      }));
      const selects: Parameters<SetupFlow["readSelect"]>[0][] = [];
      const flow = {
        begin: () => undefined,
        end: () => undefined,
        renderLine: () => undefined,
        readSelect: async (options: Parameters<SetupFlow["readSelect"]>[0]) => {
          selects.push(options);
          return options.message.includes("default worker") ? "auto" : options.currentValue;
        },
        readText: async (options: Parameters<SetupFlow["readText"]>[0]) =>
          options.message.includes("worker model") ? " " : options.defaultValue,
      } as unknown as SetupFlow;
      await buildFleetCommands(f.options)[0]!.run("", {
        setupFlow: flow,
      } as unknown as ClankieFaceShell);
      expect(selects.find((s) => s.message.includes("worker effort"))).toMatchObject({
        currentValue: "custom-effort",
        options: expect.arrayContaining([{ value: "custom-effort", label: "custom-effort" }]),
      });
      expect((await new SettingsStore(f.settings.path).load()).fleet.hire).toEqual({
        account: "second",
        subagents: null,
      });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
