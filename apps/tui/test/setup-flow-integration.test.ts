import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { loadConfig } from "@clankie/model-provider";
import { SettingsStore } from "@clankie/settings";
import { SUPERVISE_GRANTS, PairingOfferWireSchema } from "@clankie/protocol";
import { createQaService } from "../../clankie/test/fixtures/qa-service.ts";
import { PersonaStore } from "../../clankie/src/captain/personas.ts";
import { listDevices } from "../bin/devices.ts";
import { inspectInstall } from "../src/install-doctor.ts";
import { createProviderServices } from "../src/provider-commands.ts";
import { runAutostartCommand } from "../src/command/autostart.ts";
import { runConsolePair } from "../src/pair-commands.ts";
import { buildSetupCommands, type SetupCommandServices } from "../src/setup-commands.ts";
import { ClankieFaceShell } from "../src/shell/shell.ts";
import { InteractiveSelectPrompt, InteractiveTextPrompt } from "../src/face/clankie-interactive-flow.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-guided-setup-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const host = await createQaService();
  cleanups.push(() => host.close());
  // Every path and credential belongs to this fixture. No host PATH probes,
  // developer Keychain entries, real account sign-ins, or native hires.
  const env = {
    HOME: root,
    PATH: "",
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    CLANKIE_STATE: join(root, "private-state"),
    CODEX_HOME: join(root, "codex"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    CLANKIE_CONTROL_PLANE_URL: host.baseUrl,
    CLANKIE_OPERATOR_TOKEN: host.operatorToken,
    CLANKIE_CREDENTIALS_FILE: join(root, "credentials.json"),
  };
  const store = new FileCredentialStore(env.CLANKIE_CREDENTIALS_FILE);
  await store.set("openai", { type: "api", key: "isolated-fixture-no-model-requests" });
  const settings = new SettingsStore(join(root, "settings.json"));
  const personas = new PersonaStore(join(root, "personas"));
  await personas.ready(settings);
  cleanups.push(() => personas.close());
  const services: SetupCommandServices = {
    provider: createProviderServices({ env, cwd: root }),
    canTalk: () => true,
    doctor: () => inspectInstall({ repoRoot: root, env, settings, credentialStore: store }),
    devices: (signal) =>
      listDevices({ controlPlaneUrl: host.baseUrl, operatorToken: host.operatorToken, signal }),
    agents: async () => personas.all([], () => undefined),
    workspace: () => root,
    pair: (shell) => runConsolePair("", shell, { repoRoot: root, env, host: host.baseUrl }),
    autostart: (verb) => runAutostartCommand([verb], { env }),
    commands: () => commands,
  };
  const commands = buildSetupCommands(services);
  const shell = new ClankieFaceShell({ cwd: root, env, commands, bannerFields: { title: "Clankie" } });
  const start = () => commands[0]!.run("", shell);
  const post = (path: string, body: unknown) =>
    fetch(`${host.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
  return { root, env, host, shell, start, post };
}

async function prompt(shell: ClankieFaceShell, text: string) {
  let focused!: InteractiveSelectPrompt | InteractiveTextPrompt;
  await vi.waitFor(() => {
    const current = shell.tui.getFocusedComponent();
    expect(current instanceof InteractiveSelectPrompt || current instanceof InteractiveTextPrompt).toBe(true);
    const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9 ]/gu, "");
    expect(normalize(stripVTControlCharacters(current!.render(160).join("\n")))).toContain(normalize(text));
    focused = current as InteractiveSelectPrompt | InteractiveTextPrompt;
  });
  return focused;
}
async function choose(shell: ClankieFaceShell, text: string, filter: string) {
  const current = await prompt(shell, text);
  current.handleInput("\x15");
  for (const char of filter) current.handleInput(char);
  current.handleInput("\r");
}
async function pickModel(shell: ClankieFaceShell) {
  await choose(shell, "How should Clankie think?", "Use OpenAI");
  (await prompt(shell, "Which model?")).handleInput("\r");
}

it("a fresh model config reaches the first-hire composer through the actual TUI and leaves a pending phone incomplete", async () => {
  const f = await fixture();
  const offer = PairingOfferWireSchema.parse(await (await f.host.operator("/v1/pairing/offer")).json());
  const pending = await f.post("/v1/pairing/redeem", {
    code: offer.localCode,
    device: { name: "Fixture iPhone", platform: "ios" },
  });
  expect(pending.status).toBe(200);
  const devices = await listDevices({ controlPlaneUrl: f.host.baseUrl, operatorToken: f.host.operatorToken });
  expect(devices[0]?.status).toBe("pending");
  const running = f.start();
  await pickModel(f.shell);
  await choose(f.shell, "Pair your phone or iPad", "Do this later");
  await choose(f.shell, "Optional:", "Continue to my first agent");
  (await prompt(f.shell, "Which folder should your first agent work in?")).handleInput("\r");
  (await prompt(f.shell, "What should your first agent do?")).handleInput("\r");
  await choose(f.shell, "Ask Clankie to hire", "Edit the request first");
  await running;
  const { config } = await loadConfig({ env: f.env, cwd: f.root });
  expect(config.model).toMatch(/^openai\//u);
  expect(f.shell.getDraft()).toContain(JSON.stringify(await realpath(f.root)));
  expect(f.shell.getDraft()).toContain("hire my first native agent");
  expect(f.shell.getDraft()).not.toContain(offer.code);
});

it("only a completed phone advances automatically; a completed Mac does not", async () => {
  const f = await fixture();
  async function pair(platform: "ios" | "macos") {
    const offer = PairingOfferWireSchema.parse(await (await f.host.operator("/v1/pairing/offer")).json());
    const redeem = await f.post("/v1/pairing/redeem", {
      code: offer.localCode,
      device: { name: `Fixture ${platform}`, platform },
    });
    const pending = await redeem.json();
    expect(
      (
        await f.post("/v1/pairing/complete", {
          completionToken: pending.completionToken,
          acceptedGrants: SUPERVISE_GRANTS,
        })
      ).status,
    ).toBe(200);
  }
  await pair("macos");
  const first = f.start();
  await pickModel(f.shell);
  (await prompt(f.shell, "Pair your phone or iPad")).handleInput("\x1b");
  await first;
  await pair("ios");
  const second = f.start();
  await choose(f.shell, "Optional:", "Continue to my first agent");
  (await prompt(f.shell, "Which folder should your first agent work in?")).handleInput("\r");
  (await prompt(f.shell, "What should your first agent do?")).handleInput("\x1b");
  await second;
  expect(f.shell.getDraft()).toBe("");
  const phone = (
    await listDevices({ controlPlaneUrl: f.host.baseUrl, operatorToken: f.host.operatorToken })
  ).find((device) => device.platform === "ios")!;
  expect((await f.host.operator(`/v1/devices/${phone.deviceId}/revoke`)).status).toBe(200);
  const third = f.start();
  (await prompt(f.shell, "Pair your phone or iPad")).handleInput("\x1b");
  await third;
});
