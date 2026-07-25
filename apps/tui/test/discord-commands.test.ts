import { describe, expect, it } from "vitest";
import { resolveGuildList } from "../src/discord-commands.ts";

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

  it("tolerates spacing and stray separators in typed input", () => {
    expect(resolveGuildList(" 111111111111111111 , , 222222222222222222 ", [], undefined)).toEqual([
      "111111111111111111",
      "222222222222222222",
    ]);
  });
});
