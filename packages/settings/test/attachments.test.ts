import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discordAttachmentRoot } from "../src/attachments.ts";

/**
 * The writer and the reader live in different processes. When they disagreed
 * about this path — the service falling back to runner state, the bridge
 * throwing — a screenshot became an unresolvable reference and the reply
 * carrying it died whole. The point of the function is that there is nothing
 * left to disagree about.
 */
describe("discordAttachmentRoot", () => {
  it("resolves to the same place for every process on one environment", () => {
    const env = { CLANKIE_STATE: "/var/clankie" };
    expect(discordAttachmentRoot(env)).toBe("/var/clankie/attachments");
    expect(discordAttachmentRoot({ ...env })).toBe(discordAttachmentRoot(env));
  });

  it("defaults to the state root rather than to nothing", () => {
    expect(discordAttachmentRoot({})).toBe(join(homedir(), ".clankie", "attachments"));
  });

  it("honours an explicit override, absolute", () => {
    expect(discordAttachmentRoot({ CLANKIE_DISCORD_ATTACHMENT_ROOT: "  /srv/art  " })).toBe("/srv/art");
  });

  it("treats a blank setting as unset instead of as the current directory", () => {
    expect(discordAttachmentRoot({ CLANKIE_DISCORD_ATTACHMENT_ROOT: "   ", CLANKIE_STATE: "/s" })).toBe(
      "/s/attachments",
    );
  });
});
