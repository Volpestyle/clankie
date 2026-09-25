import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactCredential, type CredentialStore, type ProviderCredential } from "@clankie/credential-broker";
import { afterEach, describe, expect, it } from "vitest";
import type { InstallDoctorReport } from "../src/install-doctor.ts";
import type { ProviderServices } from "../src/provider-commands.ts";
import {
  buildSetupCommands,
  checklistEntries,
  WALKTHROUGH_DRAFT,
  type SetupCommandServices,
} from "../src/setup-commands.ts";
import type { MenuOption, SetupFlow } from "../src/shell/setup-flow.ts";
import type { ClankieFaceShell, FaceShellCommand } from "../src/shell/shell.ts";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

const report: InstallDoctorReport = {
  ok: true,
  kind: "release",
  version: "0.3.0",
  repoRoot: "/install",
  model: "openai/gpt-5.5",
  captain: { ready: true, model: "openai/gpt-5.5", providerId: "openai", auth: "credential" },
  imageModel: null,
  videoModel: null,
  persona: { displayName: "Clankie" },
  discord: {
    activeBody: "bot",
    textIngressEnabled: false,
    voiceEnabled: false,
    userSessionEnabled: false,
    machineGrantUsers: 0,
    machineGrantGuilds: 0,
  },
  voice: { realtimeProvider: "openai", ttsProvider: "openai" },
  gameplay: { pokeagentMmoEnabled: false },
  emailConfigured: false,
  mcpServers: [],
  credentials: [{ id: "openai", type: "api" }],
  commands: { codex: { present: true }, claude: { present: false } },
  herdrPlugin: { bundled: false },
  laneTools: { url: "http://127.0.0.1:4310/v1/mcp", reachable: true },
  doorway: { state: "disabled" },
  selectedModel: null,
  remediations: [],
};

async function fixture(options: {
  readonly model?: string;
  readonly credentials?: readonly string[];
  readonly canTalk?: boolean;
}): Promise<{
  readonly services: SetupCommandServices;
  readonly opened: string[];
  readonly autostartCalls: string[];
}> {
  const root = await mkdtemp(join(tmpdir(), "clankie-setup-commands-"));
  tempDirs.push(root);
  const env = { XDG_CONFIG_HOME: join(root, "config") };
  if (options.model !== undefined) {
    await mkdir(join(root, "config", "clankie"), { recursive: true });
    await writeFile(
      join(root, "config", "clankie", "clankie.json"),
      JSON.stringify({ model: options.model }),
    );
  }
  const values = new Map<string, ProviderCredential>(
    (options.credentials ?? []).map((id) => [id, { type: "api", key: `${id}-test-key` }]),
  );
  const store: CredentialStore = {
    async delete(id) {
      return values.delete(id);
    },
    async get(id) {
      return values.get(id);
    },
    async list() {
      return Object.fromEntries([...values].map(([id, value]) => [id, redactCredential(value)]));
    },
    async set(id, credential) {
      values.set(id, credential);
    },
  };
  const provider = {
    cwd: root,
    env,
    store,
    captainModels: {
      async providers() {
        return [];
      },
      async models() {
        return [];
      },
    },
    onConfigChanged() {},
  } as unknown as ProviderServices;
  const opened: string[] = [];
  const autostartCalls: string[] = [];
  const commands: FaceShellCommand[] = ["persona", "gateway", "discord"].map((name) => ({
    name,
    aliases: [],
    description: name,
    takesArgument: false,
    run() {
      opened.push(name);
    },
  }));
  return {
    opened,
    autostartCalls,
    services: {
      provider,
      canTalk: () => options.canTalk ?? true,
      doctor: async () => report,
      autostart: async (verb) => {
        autostartCalls.push(verb);
        return {
          ok: true,
          status: verb === "enable" ? "enabled" : "disabled",
          label: "bot.clankie.autostart",
          plist: "/plist",
          loaded: verb === "enable",
          command: [],
          log: "/log",
        };
      },
      commands: () => commands,
    },
  };
}

function testShell(selections: Array<string | undefined>): {
  readonly shell: ClankieFaceShell;
  readonly selects: Array<{ message: string; options: readonly MenuOption[] }>;
  readonly markdown: string[];
  readonly results: string[];
  readonly drafts: string[];
} {
  const selects: Array<{ message: string; options: readonly MenuOption[] }> = [];
  const markdown: string[] = [];
  const results: string[] = [];
  const drafts: string[] = [];
  const flow: SetupFlow = {
    begin: () => {},
    end: () => {},
    readSelect: async (options) => {
      selects.push(options);
      return selections.shift();
    },
    readSecret: async () => undefined,
    readText: async () => undefined,
    renderLine: () => {},
    setStatus: () => {},
    waitForInterrupt: () => ({ promise: new Promise<void>(() => {}), dispose: () => {} }),
  };
  const shell = {
    setupFlow: flow,
    insertMarkdown(text: string) {
      markdown.push(text);
    },
    insertCommandResult(_command: string, text: string) {
      results.push(text);
    },
    setDraft(text: string) {
      drafts.push(text);
    },
  } as unknown as ClankieFaceShell;
  return { shell, selects, markdown, results, drafts };
}

function setup(services: SetupCommandServices): FaceShellCommand {
  const found = buildSetupCommands(services).find((command) => command.name === "setup");
  if (found === undefined) throw new Error("missing /setup");
  return found;
}

describe("/setup", () => {
  it("asks only how he thinks when he cannot take a turn, and says so when abandoned", async () => {
    const { services } = await fixture({ model: "openai/gpt-5.5" });
    const view = testShell([undefined]);

    await setup(services).run("", view.shell);

    expect(view.selects.map((select) => select.message)).toEqual(["How should Clankie think?"]);
    expect(view.markdown.join("\n")).toContain("nothing signs in to openai");
    expect(view.drafts).toEqual([]);
  });

  it("shows a ready install its rooms and opens the command that owns the one picked", async () => {
    const { services, opened } = await fixture({ model: "openai/gpt-5.5", credentials: ["openai"] });
    const view = testShell(["persona"]);

    await setup(services).run("", view.shell);

    const options = view.selects[0]?.options ?? [];
    expect(options.find((option) => option.value === "think")?.hint).toBe("✓ openai/gpt-5.5");
    expect(options.find((option) => option.value === "autostart")?.hint).toBe("off");
    expect(options.find((option) => option.value === "workers")?.hint).toBe("✓ codex");
    expect(opened).toEqual(["persona"]);
  });

  it("enables autostart in place and hands the walkthrough to Clankie as an editable draft", async () => {
    const { services, autostartCalls } = await fixture({ model: "openai/gpt-5.5", credentials: ["openai"] });
    const autostart = testShell(["autostart"]);
    await setup(services).run("", autostart.shell);
    expect(autostartCalls).toEqual(["status", "enable"]);
    expect(autostart.results.join("\n")).toContain("starts when you log in");

    const ask = testShell(["ask"]);
    await setup(services).run("", ask.shell);
    expect(ask.drafts).toEqual([WALKTHROUGH_DRAFT]);
  });

  it("points a signed-in Mac at pairing and a signed-out one at the doorway", () => {
    const ready = { ready: true, model: "openai/gpt-5.5", providerId: "openai", auth: "credential" } as const;
    const phone = (state: InstallDoctorReport["doorway"]) =>
      checklistEntries({ ...report, doorway: state }, ready, undefined).find(
        (entry) => entry.value === "phone",
      );
    expect(phone({ state: "connected" })?.command).toBe("pair");
    expect(phone({ state: "sign_in_required", since: "2026-09-01" })).toMatchObject({
      command: "gateway",
      hint: "signed out",
    });
  });

  it("does not invite a message the console cannot deliver", async () => {
    const { services } = await fixture({
      model: "openai/gpt-5.5",
      credentials: ["openai"],
      canTalk: false,
    });
    const view = testShell(["ask"]);

    await setup(services).run("", view.shell);

    expect(view.drafts).toEqual([]);
    expect(view.results.join("\n")).toContain("can't reach Clankie's service");
  });
});
