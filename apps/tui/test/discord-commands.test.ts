import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore } from "@clankie/settings";
import type { SetupFlow } from "../src/shell/setup-flow.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";
import {
  DISCORD_BOT_INVITE_PERMISSIONS,
  describeEmptyAllowlist,
  describeRedactedCredential,
  discordBotInviteUrl,
  resolveGuildList,
  resolveIdList,
  runDiscordWizard,
} from "../src/discord-commands.ts";

describe("stored credential display", () => {
  it("shows enough of a stored key to identify it, and never the whole thing", () => {
    // The broker hands back only the first four characters; the point is to
    // answer "is the right token installed?" without revealing it.
    const shown = describeRedactedCredential({ type: "api", key: "MTIz…" });
    expect(shown).toBe("api key MTIz…");
    expect(shown).toContain("…");
  });

  it("describes oauth and wellknown credentials without inventing key material", () => {
    expect(describeRedactedCredential({ type: "oauth", accountId: "james", expires: 0 })).toBe(
      "oauth (james)",
    );
    expect(describeRedactedCredential({ type: "oauth", expires: 0 })).toBe("oauth");
    expect(describeRedactedCredential({ type: "wellknown" })).toBe("wellknown");
  });
});

describe("empty allowlist guard", () => {
  const guilds = ["111111111111111111"];
  const channels = ["222222222222222222"];

  it("always requires a server allowlist for both planes", () => {
    expect(describeEmptyAllowlist("voice", [], channels)).toMatch(/no server allowlisted/);
    expect(describeEmptyAllowlist("text ingress", [], channels)).toMatch(/no server allowlisted/);
  });

  it("lets either plane admit every channel in an allowlisted server", () => {
    // The channel list is refinement below the server allowlist on both planes;
    // empty admits every channel inside the servers the owner already chose.
    expect(describeEmptyAllowlist("voice", guilds, [])).toBeUndefined();
    expect(describeEmptyAllowlist("text ingress", guilds, [])).toBeUndefined();
  });

  it("allows a fully specified plane", () => {
    expect(describeEmptyAllowlist("voice", guilds, channels)).toBeUndefined();
    expect(describeEmptyAllowlist("text ingress", guilds, channels)).toBeUndefined();
  });

  it("keeps configured channels when the operator presses enter", () => {
    expect(resolveIdList("", channels)).toEqual(channels);
    expect(resolveIdList("333333333333333333", channels)).toEqual(["333333333333333333"]);
  });

  it("requires an explicit word to clear a security allowlist", () => {
    expect(resolveIdList("none", channels)).toEqual([]);
  });
});

describe("Discord server allowlist resolution", () => {
  it("keeps Clankie multi-server instead of collapsing to the command server", () => {
    // The regression this guards: the wizard used to derive the operating
    // allowlists from the single command-registration guild, so Clankie could
    // only ever be admitted in one server no matter how many he was installed in.
    expect(resolveGuildList("111111111111111111,222222222222222222", [], "999999999999999999")).toEqual([
      "111111111111111111",
      "222222222222222222",
    ]);
  });

  it("keeps an existing multi-server allowlist when the operator just presses enter", () => {
    const existing = ["111111111111111111", "222222222222222222"];
    expect(resolveGuildList("", existing, "999999999999999999")).toEqual(existing);
    // Blank must not silently narrow a configured allowlist down to one server.
    expect(resolveGuildList("", existing, "999999999999999999")).not.toEqual(["999999999999999999"]);
  });

  it("falls back to the command server only on a first-time blank", () => {
    expect(resolveGuildList("", [], "999999999999999999")).toEqual(["999999999999999999"]);
    // Commands registered globally and nothing configured yet: nothing to admit.
    expect(resolveGuildList("", [], undefined)).toEqual([]);
  });

  it("builds a bot invite that does not use a signed 32-bit shift", () => {
    expect(DISCORD_BOT_INVITE_PERMISSIONS).toBe(2_721_172_560);
    expect(discordBotInviteUrl("123456789012345678")).toContain("client_id=123456789012345678");
  });

  it("tolerates spacing and stray separators in typed input", () => {
    expect(resolveGuildList(" 111111111111111111 , , 222222222222222222 ", [], undefined)).toEqual([
      "111111111111111111",
      "222222222222222222",
    ]);
  });
});

describe("swarm home in /discord", () => {
  /** One pass through "Server, application, and roles" with the swarm-home answer given. */
  async function editSwarmHome(settings: SettingsStore, answer: string): Promise<void> {
    const picks = ["core", "done"];
    const texts = ["", "", answer, "", ""];
    const flow = {
      begin: () => undefined,
      end: () => undefined,
      readSelect: async () => picks.shift(),
      readText: async () => texts.shift(),
      renderLine: () => undefined,
    } as unknown as SetupFlow;
    await runDiscordWizard(
      { setupFlow: flow, insertCommandResult: () => undefined } as unknown as ClankieFaceShell,
      {
        settings,
        listCredentials: async () => ({}),
        removeCredential: async () => undefined,
        setCredential: async () => undefined,
      },
    );
  }

  it("sets the server agent channels may be projected into, keeps it on blank, and clears it on none", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-discord-swarm-"));
    const settings = new SettingsStore(join(root, "settings.json"));
    await editSwarmHome(settings, "123456789012345678");
    expect((await settings.load()).discord.swarmGuildId).toBe("123456789012345678");
    await editSwarmHome(settings, "");
    expect((await settings.load()).discord.swarmGuildId).toBe("123456789012345678");
    await editSwarmHome(settings, "none");
    expect((await settings.load()).discord.swarmGuildId).toBeUndefined();
  });
});
