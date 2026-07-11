import { describe, expect, it } from "vitest";
import { commands } from "../src/commands.ts";

describe("Discord commands", () => {
  it("requires explicit join and leave commands", () => {
    const names = commands.map((command) => command.name);
    expect(names).toContain("captain-join");
    expect(names).toContain("captain-leave");
    expect(names).not.toContain("listen-always");
  });
});
