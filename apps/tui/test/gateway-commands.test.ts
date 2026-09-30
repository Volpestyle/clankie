import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
vi.mock("@clankie/credential-broker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clankie/credential-broker")>()),
  beginClankieAccountLogin: async () => ({}),
  completeClankieAccountLogin: async () => ACCOUNT,
}));

import { buildGatewayCommands } from "../src/gateway-commands.ts";
import type { MenuOption, SetupFlow } from "../src/shell/setup-flow.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";

const GATEWAY = "https://api.clankie.bot";
const ACCOUNT = {
  type: "oauth",
  access: "a",
  refresh: "r",
  expires: Date.now() + 3_600_000,
  accountId: "acct",
} as const;

function health(doorway: unknown): typeof fetch {
  return (async () => Response.json({ doorway })) as typeof fetch;
}

function fixture(
  input: { readonly doorway: unknown; readonly signedIn: boolean },
  answers: { readonly select?: string; readonly text?: readonly string[] } = {},
) {
  const texts = [...(answers.text ?? [])];
  const selects: Array<{ message: string; options: readonly MenuOption[] }> = [];
  const results: string[] = [];
  const lines: string[] = [];
  const flow = {
    begin: () => {},
    end: () => {},
    readSelect: async (options: { message: string; options: readonly MenuOption[] }) => {
      selects.push(options);
      return answers.select;
    },
    readText: async () => texts.shift(),
    renderLine: (text: string) => void lines.push(text),
    setStatus: () => {},
  } as unknown as SetupFlow;
  const shell = {
    setupFlow: flow,
    insertCommandResult: (_command: string, text: string) => results.push(text),
  } as unknown as ClankieFaceShell;
  return { shell, selects, results, lines, input };
}

describe("/remote-access", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  async function command(
    state: { readonly doorway: unknown; readonly signedIn: boolean },
    fleet?: typeof fetch,
  ) {
    const directory = await mkdtemp(join(tmpdir(), "clankie-remote-access-"));
    directories.push(directory);
    const settings = new SettingsStore(join(directory, "settings.json"));
    const credentials = new FileCredentialStore(join(directory, "credentials.json"));
    if (state.signedIn) {
      await credentials.set("clankie-account", ACCOUNT);
      await settings.update((current) => ({
        ...current,
        publicGateway: { url: GATEWAY, installationId: "YWFhYWFhYWFhYWFhYWFhYQ" },
      }));
    }
    const [found] = buildGatewayCommands({
      settings,
      credentials,
      fetchImpl:
        fleet === undefined
          ? health(state.doorway)
          : (((input, init) =>
              String(input).includes("/fleet/")
                ? fleet(input, init)
                : health(state.doorway)(input, init)) as typeof fetch),
    });
    return { run: found!.run.bind(found), credentials, settings };
  }

  it("leads with signing this Mac back in when the doorway is signed out", async () => {
    const view = fixture({ doorway: undefined, signedIn: true });
    const remote = await command({
      doorway: { state: "sign_in_required", since: "2026-09-29T13:27:00Z" },
      signedIn: true,
    });
    await remote.run("", view.shell);

    const [menu] = view.selects;
    expect(menu?.message).toContain("signed out since 2026-09-29T13:27:00Z");
    expect(menu?.options[0]).toMatchObject({ value: "configure", label: "Sign this Mac back in" });
    expect(menu?.options.map((option) => option.label)).not.toContain("Enable remote access");
  });

  it("leads its status text with the sign-in step when signed out", async () => {
    const view = fixture({ doorway: undefined, signedIn: true });
    const remote = await command({
      doorway: { state: "sign_in_required", since: "2026-09-29T13:27:00Z" },
      signedIn: true,
    });
    await remote.run("status", view.shell);

    const [text] = view.results;
    expect(text?.split("\n")[0]).toContain('choose "Sign this Mac back in"');
    expect(text).toContain("doorway: signed out since 2026-09-29T13:27:00Z");
  });

  it("offers a first sign-in, not a re-sign-in, before remote access was ever set up", async () => {
    const view = fixture({ doorway: undefined, signedIn: false });
    const remote = await command({ doorway: { state: "disabled" }, signedIn: false });
    await remote.run("", view.shell);

    expect(view.selects[0]?.options[0]).toMatchObject({
      value: "configure",
      label: "Sign this Mac in to enable remote access",
    });
  });

  it("keeps status first and labels a second sign-in for what it does when the doorway is open", async () => {
    const view = fixture({ doorway: undefined, signedIn: true });
    const remote = await command({ doorway: { state: "connected" }, signedIn: true });
    await remote.run("", view.shell);

    const [menu] = view.selects;
    expect(menu?.message).toBe("Remote access for this Mac");
    expect(menu?.options.map((option) => option.label).slice(0, 2)).toEqual([
      "Show status",
      "Sign in with another account",
    ]);
  });

  it("still signs a signed-out Mac in when the fleet answers 401 to the hosted-account check", async () => {
    const view = fixture(
      { doorway: undefined, signedIn: true },
      { select: "configure", text: ["james@example.com", "123456"] },
    );
    const remote = await command(
      { doorway: { state: "sign_in_required", since: "2026-09-29T13:27:00Z" }, signedIn: true },
      (async () => Response.json({ error: "unauthorized" }, { status: 401 })) as typeof fetch,
    );
    await remote.run("", view.shell);

    expect(view.lines.join("\n")).toContain("Remote access is ready");
    expect((await remote.credentials.get("clankie-account"))?.type).toBe("oauth");
  });
});
