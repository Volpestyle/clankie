import { FleetAutonomySchema } from "@clankie/protocol";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionError,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { ProjectsSettingsSchema, type Project } from "@clankie/protocol/projects";
import { SettingsStore } from "@clankie/settings";
import { afterEach, expect, it } from "vitest";
import { assembleLanePrompt } from "../src/captain/captain.ts";
import { captainFleetSettingsExtension } from "../src/captain/fleet-settings.ts";
import { resolveFleetSettingsContext } from "../src/fleet-settings-context.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const SOURCE = "Source-owned identity and authority instructions.";
const APPEND = "Owner's additional source prompt instructions.";
const BEFORE = "Instructions contributed before fleet refresh.";
const AFTER = "Instructions contributed after fleet refresh.";

// Real resource loading and native Pi event dispatch; no model/provider calls,
// mocked extension runner, or mocked settings/context reads.
async function fixture(throwUnrelated = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fleet-autonomy-pi-")));
  directories.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const settings = new SettingsStore(join(root, "settings.json"));
  const writer = new SettingsStore(settings.path);
  const loadPrompt = async () => {
    const current = await settings.load();
    const context = await resolveFleetSettingsContext(
      current,
      { workingDirectory: workspace, machine: "local" },
      {},
    );
    return assembleLanePrompt(
      "operator",
      true,
      { ...current, autonomy: { ...current.autonomy, fleet: FleetAutonomySchema.parse(context.effective) } },
      ["fleet"],
    );
  };
  const initialPrompt = await loadPrompt();
  const source = `${SOURCE}\n\n${initialPrompt}\n\nSource-owned final instructions.`;
  const sourcePath = join(root, "SYSTEM.md");
  const appendPath = join(root, "APPEND.md");
  await writeFile(sourcePath, source);
  await writeFile(appendPath, APPEND);
  const extensions: InlineExtension[] = [
    {
      name: "source-before",
      factory(pi) {
        pi.on("before_agent_start", (event) => ({
          systemPrompt: `${event.systemPrompt}\n\n${BEFORE}`,
        }));
      },
    },
    captainFleetSettingsExtension({ initialPrompt, loadPrompt }),
    ...(throwUnrelated
      ? [
          {
            name: "unrelated-failing-extension",
            factory(pi) {
              pi.on("before_agent_start", () => {
                throw new Error("An unrelated native extension failed");
              });
            },
          } satisfies InlineExtension,
        ]
      : []),
    {
      name: "source-after",
      factory(pi) {
        pi.on("before_agent_start", (event, context) => {
          expect(context.getSystemPrompt()).toBe(event.systemPrompt);
          return {
            systemPrompt: `${event.systemPrompt}\n\n${AFTER}`,
            message: {
              customType: "source-refresh-observed",
              content: "The later native extension ran.",
              display: false,
            },
          };
        });
      },
    },
  ];
  const loader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir: root,
    settingsManager: SettingsManager.inMemory(),
    systemPrompt: sourcePath,
    appendSystemPrompt: [appendPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: extensions,
  });
  await loader.reload();
  expect(loader.getSystemPromptSource()).toEqual({ path: sourcePath });
  const loaded = loader.getExtensions();
  expect(loaded.errors).toEqual([]);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    workspace,
    SessionManager.inMemory(workspace),
    new ModelRegistry(runtime),
  );
  const errors: ExtensionError[] = [];
  runner.onError((error) => errors.push(error));
  const refresh = async () => {
    // AgentSession starts each native event from its original base options,
    // rather than feeding a previous handler's forceSystemPrompt back in.
    const result = await runner.emitBeforeAgentStart("Continue this work", undefined, {
      cwd: workspace,
      customPrompt: loader.getSystemPrompt()!,
      appendSystemPrompt: loader.getAppendSystemPrompt().join("\n\n"),
      selectedTools: [],
    });
    const prompt = result.systemPromptOptions.forceSystemPrompt;
    expect(typeof prompt).toBe("string");
    for (const retained of [SOURCE, APPEND, BEFORE, AFTER, "Source-owned final instructions."])
      expect(prompt).toContain(retained);
    expect(prompt!.match(/^# Your fleet$/gmu)).toHaveLength(1);
    expect(result.messages).toEqual([
      {
        customType: "source-refresh-observed",
        content: "The later native extension ran.",
        display: false,
      },
    ]);
    expect(loader.getSystemPrompt()).toBe(source);
    return prompt!;
  };
  const project = (id: string, autonomy?: Project["autonomy"]): Project =>
    ProjectsSettingsSchema.parse({
      projects: [
        {
          id,
          name: id,
          workspaces: [{ id: "repo", machineId: "local", platform: "posix", path: workspace }],
          ...(autonomy ? { autonomy } : {}),
        },
      ],
    }).projects[0]!;
  return { settings, writer, refresh, loadPrompt, errors, project };
}

function policy(prompt: string, closure: "lead" | "owner", machineSetup: "lead" | "owner") {
  expect(prompt).toContain(`Work closure: ${closure}.`);
  expect(prompt).toContain(`Machine setup: ${machineSetup}.`);
  expect(prompt.match(/^Work closure:/gmu)).toHaveLength(1);
  expect(prompt.match(/^Machine setup:/gmu)).toHaveLength(1);
  expect(prompt).not.toContain("Current fleet responsibility could not be verified");
}

function unavailable(prompt: string) {
  expect(prompt).toContain("Current fleet responsibility could not be verified");
  expect(prompt).toContain("Do not close tracked work or change machine setup");
  expect(prompt).not.toContain("Work closure:");
  expect(prompt).not.toContain("Machine setup:");
  expect(prompt).not.toContain("Under lead closure");
  expect(prompt).not.toContain("already-linked machines");
}

it("refreshes disk-backed global and project leaves on repeated native Pi starts while retaining other prompt sources", async () => {
  const f = await fixture();
  policy(await f.refresh(), "lead", "lead");
  await f.writer.update((current) => ({
    ...current,
    fleet: { ...current.fleet, size: "small", models: "efficient", notes: "Current routing preference." },
    autonomy: {
      fleet: FleetAutonomySchema.parse({
        closure: "owner",
        machineSetup: "owner",
        commit: "owner",
        push: "owner",
        release: { mode: "time_rule", rule: "After one week with user-visible changes." },
        verification: "review_and_seal",
        reportingStyle: "Concise evidence links.",
      }),
    },
    projects: ProjectsSettingsSchema.parse({
      projects: [
        f.project("garden", {
          fleet: {
            machineSetup: "lead",
            push: "lead",
            release: { mode: "lead" },
            reportingStyle: "Project report.",
          },
        }),
      ],
    }),
  }));
  const narrowed = await f.refresh();
  policy(narrowed, "owner", "lead");
  expect(narrowed).toContain("Fleet size: small.");
  expect(narrowed).toContain("Models: efficient.");
  expect(narrowed).toContain("Current routing preference.");
  expect(narrowed).toContain("Commit: owner.");
  expect(narrowed).toContain("Push: lead.");
  expect(narrowed).toContain("Release: lead.");
  expect(narrowed).toContain("Verification: review_and_seal.");
  expect(narrowed).toContain("Reporting style: Project report.");
  expect(narrowed).toContain("including App Store or TestFlight, follows the resolved release preference");
  expect(narrowed).toContain("Evals require explicit owner authorization");
  await f.writer.update((current) => ({
    ...current,
    fleet: { ...current.fleet, notes: "Revised routing preference." },
    projects: ProjectsSettingsSchema.parse({ projects: [f.project("garden")] }),
  }));
  const inherited = await f.refresh();
  policy(inherited, "owner", "owner");
  expect(inherited).toContain("Revised routing preference.");
  expect(inherited).not.toContain("Current routing preference.");
  expect(inherited).toContain("Push: owner.");
  expect(inherited).toContain("Release: time_rule.");
  expect(inherited).toContain("After one week with user-visible changes.");
  expect(inherited).toContain("Reporting style: Concise evidence links.");
  expect(f.errors).toEqual([]);
});

it("replaces startup delegation when the real workspace becomes ambiguous and recovers on the next native start", async () => {
  const f = await fixture();
  policy(await f.refresh(), "lead", "lead");
  await f.writer.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        f.project("garden"),
        f.project("restricted", { fleet: { closure: "owner", machineSetup: "owner" } }),
      ],
    }),
  }));
  await expect(f.loadPrompt()).rejects.toThrow("ambiguous");
  unavailable(await f.refresh());
  unavailable(await f.refresh());
  await f.writer.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [f.project("restricted", { fleet: { closure: "owner", machineSetup: "owner" } })],
    }),
  }));
  policy(await f.refresh(), "owner", "owner");
  expect(f.errors).toEqual([]);
});

it.each(["invalid JSON", "invalid schema", "filesystem read failure"] as const)(
  "replaces delegated guidance after a real %s instead of relying on a thrown extension error",
  async (failure) => {
    const f = await fixture();
    await f.writer.update((current) => current);
    policy(await f.refresh(), "lead", "lead");
    const saved = await readFile(f.settings.path, "utf8");
    if (failure === "filesystem read failure") {
      await rm(f.settings.path);
      await mkdir(f.settings.path);
    } else {
      await writeFile(
        f.settings.path,
        failure === "invalid JSON" ? "{broken" : '{"autonomy":{"fleet":{"closure":"everyone"}}}',
      );
    }
    await expect(f.loadPrompt()).rejects.toThrow();
    unavailable(await f.refresh());
    unavailable(await f.refresh());
    expect(f.errors).toEqual([]);
    if (failure === "filesystem read failure") await rm(f.settings.path, { recursive: true });
    await writeFile(f.settings.path, saved);
    await f.writer.update((current) => ({
      ...current,
      autonomy: { fleet: FleetAutonomySchema.parse({ closure: "owner", machineSetup: "owner" }) },
    }));
    policy(await f.refresh(), "owner", "owner");
    expect(f.errors).toEqual([]);
  },
);

it("uses native Pi's continue-after-extension-error semantics without keeping stale fleet delegation", async () => {
  const f = await fixture(true);
  await writeFile(f.settings.path, "{broken");
  unavailable(await f.refresh());
  expect(f.errors).toEqual([
    expect.objectContaining({
      extensionPath: "<inline:unrelated-failing-extension>",
      event: "before_agent_start",
      error: "An unrelated native extension failed",
    }),
  ]);
});
