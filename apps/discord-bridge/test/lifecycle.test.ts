import { describe, expect, it } from "vitest";
import { assertOfficialBotBodyActive, discordBridgeHealth } from "../src/lifecycle.ts";

describe("official bot lifecycle", () => {
  it("refuses direct startup while the user-session body is active", () => {
    expect(() => assertOfficialBotBodyActive({ DISCORD_ACTIVE_BODY: "user_session" })).toThrow(
      "discord_bot_inactive_body",
    );
    expect(() => assertOfficialBotBodyActive({ DISCORD_ACTIVE_BODY: "bot" })).not.toThrow();
    expect(() => assertOfficialBotBodyActive({})).not.toThrow();
  });

  it("is unhealthy before Discord login and after terminal gateway or Vox failure", () => {
    const base = {
      shuttingDown: false,
      voiceEnabled: true,
      vox: { status: "ready" as const, detail: "Vox ready" },
    };
    expect(discordBridgeHealth({ ...base, discordReady: false }).ok).toBe(false);
    expect(discordBridgeHealth({ ...base, discordReady: true }).ok).toBe(true);
    expect(
      discordBridgeHealth({ ...base, discordReady: true, terminalFailure: "voice adapter failed" }).ok,
    ).toBe(false);
    expect(
      discordBridgeHealth({
        ...base,
        discordReady: true,
        vox: { status: "error", detail: "Vox exited unexpectedly" },
      }).ok,
    ).toBe(false);
  });
});
