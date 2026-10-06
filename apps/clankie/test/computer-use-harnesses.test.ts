import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClankieSettingsSchema, SettingsStore } from "@clankie/settings";
import { runBrowserCommand } from "../../tui/src/command/browser.ts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { describe, expect, it } from "vitest";
import { assembleLanePrompt } from "../src/captain/captain.ts";
import {
  cachedComputerUseHarnesses,
  codexPluginDisabled,
  detectComputerUseHarnesses,
  parseCodexFeatures,
  renderComputerUseReach,
  type ComputerUseHarness,
  type ComputerUseProbe,
} from "../src/computer-use-harnesses.ts";

const HOME = "/home/owner";
const HOSTS = join(HOME, "Library/Application Support/Google/Chrome/NativeMessagingHosts");

const CODEX_FEATURES = [
  "apps                                     stable             true",
  "browser_use                              stable             true",
  "browser_use_external                     stable             true",
  "computer_use                             stable             true",
  "code_mode                                under development  false",
].join("\n");

const CODEX_CONFIG = [
  '["plugins"."chrome@openai-bundled"]',
  '"enabled" = true',
  "",
  '["plugins"."computer-use@openai-bundled"]',
  '"enabled" = true',
].join("\n");

/** A machine described by its harness answers and files; anything unlisted is absent. */
function machine(
  commands: Readonly<Record<string, { status: number; output: string }>>,
  files: Readonly<Record<string, string>>,
): ComputerUseProbe {
  return {
    run: (command, args) => Promise.resolve(commands[[command, ...args].join(" ")]),
    readText: (path) => Promise.resolve(files[path]),
    home: HOME,
  };
}

const JAMES_MAC = machine(
  {
    "codex login status": { status: 0, output: "Logged in using ChatGPT" },
    "codex features list": { status: 0, output: CODEX_FEATURES },
    "claude auth status": {
      status: 0,
      output: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }),
    },
  },
  {
    [join(HOME, ".codex/config.toml")]: CODEX_CONFIG,
    [join(HOSTS, "com.openai.codexextension.json")]: "{}",
    [join(HOSTS, "com.anthropic.claude_code_browser_extension.json")]: "{}",
    [join(HOME, ".claude.json")]: JSON.stringify({
      cachedChromeExtensionInstalled: true,
      claudeInChromeDefaultEnabled: false,
    }),
  },
);

describe("computer-use harness detection (ADR 0199)", () => {
  it("reads Codex desktop and Chrome, and Claude in Chrome, from each harness's own answers", async () => {
    expect(await detectComputerUseHarnesses(JAMES_MAC)).toEqual([
      {
        harness: "codex",
        signedIn: true,
        surfaces: ["desktop", "chrome"],
        chromeNeedsHireFlag: false,
      },
      {
        harness: "claude",
        signedIn: true,
        surfaces: ["chrome"],
        chromeNeedsHireFlag: true,
      },
    ]);
  });

  it("leaves out a harness that is not installed", async () => {
    expect(await detectComputerUseHarnesses(machine({}, {}))).toEqual([]);
  });

  it("reports an installed but signed-out harness with what the owner does about it", async () => {
    const found = await detectComputerUseHarnesses(
      machine(
        {
          "codex login status": { status: 1, output: "Not logged in" },
          "codex features list": { status: 0, output: CODEX_FEATURES },
        },
        { [join(HOSTS, "com.openai.codexextension.json")]: "{}" },
      ),
    );
    expect(found).toEqual([
      {
        harness: "codex",
        signedIn: false,
        surfaces: ["desktop", "chrome"],
        chromeNeedsHireFlag: false,
        missing: "not signed in: the owner runs `codex login`",
      },
    ]);
  });

  it("honours an owner who switched a Codex plugin or feature off", async () => {
    const found = await detectComputerUseHarnesses(
      machine(
        {
          "codex login status": {
            status: 0,
            output: "Logged in using ChatGPT",
          },
          "codex features list": {
            status: 0,
            output: CODEX_FEATURES.replace(
              /browser_use_external(\s+stable\s+)true/u,
              "browser_use_external$1false",
            ),
          },
        },
        {
          [join(HOME, ".codex/config.toml")]: CODEX_CONFIG.replace(
            '["plugins"."computer-use@openai-bundled"]\n"enabled" = true',
            '["plugins"."computer-use@openai-bundled"]\n"enabled" = false',
          ),
          [join(HOSTS, "com.openai.codexextension.json")]: "{}",
        },
      ),
    );
    expect(found[0]?.surfaces).toEqual([]);
    expect(found[0]?.missing).toMatch(/off/u);
  });

  it("needs Chrome's native host, not just the extension flag, for Claude in Chrome", async () => {
    const found = await detectComputerUseHarnesses(
      machine(
        { "claude auth status": { status: 0, output: '{"loggedIn": true}' } },
        {
          [join(HOME, ".claude.json")]: '{"cachedChromeExtensionInstalled": true}',
        },
      ),
    );
    expect(found).toEqual([
      {
        harness: "claude",
        signedIn: true,
        surfaces: [],
        chromeNeedsHireFlag: false,
        missing: "the Claude in Chrome extension is not installed: the owner adds it and runs `/chrome` once",
      },
    ]);
  });

  it("parses Codex's feature table and plugin tables in both TOML spellings", () => {
    expect(parseCodexFeatures(CODEX_FEATURES).get("computer_use")).toBe(true);
    expect(parseCodexFeatures(CODEX_FEATURES).get("code_mode")).toBe(false);
    expect(
      codexPluginDisabled('[plugins."chrome@openai-bundled"]\nenabled = false', "chrome@openai-bundled"),
    ).toBe(true);
    expect(codexPluginDisabled(CODEX_CONFIG, "chrome@openai-bundled")).toBe(false);
    // Absent table: Codex's own default, which the feature flag already reports.
    expect(codexPluginDisabled("", "chrome@openai-bundled")).toBe(false);
  });

  it("keeps the last answer when a refresh fails, and re-probes after the ttl", async () => {
    let clock = 0;
    let calls = 0;
    const answers: Array<() => Promise<readonly ComputerUseHarness[]>> = [
      () =>
        Promise.resolve([
          {
            harness: "codex",
            signedIn: true,
            surfaces: ["desktop"],
            chromeNeedsHireFlag: false,
          },
        ]),
      () => Promise.reject(new Error("codex hung")),
    ];
    const cache = cachedComputerUseHarnesses(
      () => answers[calls++]!(),
      1_000,
      () => clock,
    );
    const first = await cache.current();
    expect(await cache.current()).toBe(first);
    expect(calls).toBe(1);
    clock = 2_000;
    expect(await cache.current()).toEqual(first);
    expect(calls).toBe(2);
  });
});

describe("the reach card's computer-use lines", () => {
  const ready: readonly ComputerUseHarness[] = [
    {
      harness: "codex",
      signedIn: true,
      surfaces: ["desktop", "chrome"],
      chromeNeedsHireFlag: false,
    },
    {
      harness: "claude",
      signedIn: true,
      surfaces: ["chrome"],
      chromeNeedsHireFlag: true,
    },
  ];
  const settings = ClankieSettingsSchema.parse({ schemaVersion: 1 });

  it("names each harness, its surfaces, and how to hire it", () => {
    const card = renderComputerUseReach(ready);
    expect(card).toContain("- codex: Mac apps and their Chrome");
    expect(card).toContain("- claude: their Chrome (hire with `chrome: true`)");
    expect(card).toContain("`hire_agent`");
    expect(card).toContain("`desktop-control`");
  });

  it("says nothing when no harness here can take the work", () => {
    expect(renderComputerUseReach([])).toBe("");
    expect(
      renderComputerUseReach([
        {
          harness: "codex",
          signedIn: false,
          surfaces: ["desktop"],
          chromeNeedsHireFlag: false,
          missing: "x",
        },
      ]),
    ).toBe("");
  });

  it("rides the operator's machine access and never reaches a social room", () => {
    const operator = assembleLanePrompt("operator", true, settings, undefined, {}, ready);
    expect(operator).toContain("# Computer use through a harness");
    expect(operator.indexOf("# Machine access")).toBeLessThan(
      operator.indexOf("# Computer use through a harness"),
    );
    expect(operator).not.toMatch(/\n\n\n/u);
    const social = assembleLanePrompt("discord_presence", false, settings, undefined, {}, ready);
    expect(social).not.toContain("Computer use through a harness");
  });

  it("drops off the card when the owner turns delegation off", () => {
    const off = ClankieSettingsSchema.parse({
      schemaVersion: 1,
      browser: { harnessDelegation: false },
    });
    expect(assembleLanePrompt("operator", true, off, undefined, {}, ready)).not.toContain(
      "Computer use through a harness",
    );
  });
});

describe("clankie browser harnesses / delegate", () => {
  it("reads the service's re-probed answer as the operator only, and toggles the card", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clankie-harnesses-"));
    const settings = new SettingsStore(join(dir, "settings.json"));
    let probes = 0;
    const app = await createClankieApp({
      captain: createStubCaptain(),
      computerUseHarnesses: {
        refresh: () => {
          probes += 1;
          return Promise.resolve([
            {
              harness: "codex",
              signedIn: true,
              surfaces: ["desktop"],
              chromeNeedsHireFlag: false,
            },
          ]);
        },
      },
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
    });
    const cli = {
      settings,
      host: "http://localhost",
      env: { CLANKIE_OPERATOR_TOKEN: "owner" },
      fetchImpl: (async (url, init) => app.app.request(new Request(String(url), init))) as typeof fetch,
    };
    try {
      expect((await app.app.request("/v1/browser/harnesses")).status).toBe(401);
      expect(probes).toBe(0);
      expect(await runBrowserCommand(["harnesses"], cli)).toEqual({
        ok: true,
        schemaVersion: 1,
        detected: true,
        harnesses: [
          {
            harness: "codex",
            signedIn: true,
            surfaces: ["desktop"],
            chromeNeedsHireFlag: false,
          },
        ],
        harnessDelegation: true,
      });
      expect(probes).toBe(1);
      expect(await runBrowserCommand(["delegate", "off"], cli)).toMatchObject({
        browser: { harnessDelegation: false },
        appliesTo: "next_session",
      });
      expect((await settings.load()).browser.harnessDelegation).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("answers an empty, undetected list on a body with no owner desktop", async () => {
    const app = await createClankieApp({
      captain: createStubCaptain(),
      authenticateOperator: async () => ({ operatorId: "owner" }),
    });
    const response = await app.app.request("/v1/browser/harnesses", {
      headers: { authorization: "Bearer x" },
    });
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      detected: false,
      harnesses: [],
    });
  });
});
