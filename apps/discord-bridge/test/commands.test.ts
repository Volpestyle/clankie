import { describe, expect, it } from "vitest";
import { commands } from "../src/commands.ts";

describe("Discord commands", () => {
  it("requires explicit join and leave commands", () => {
    const names = commands.map((command) => command.name);
    expect(names).toContain("captain-join");
    expect(names).toContain("captain-leave");
    expect(names).not.toContain("listen-always");
  });

  it("offers only the three user-facing ceremony presets", () => {
    const mission = commands.find((command) => command.name === "captain-mission");
    const doctrine = mission?.options?.find((option) => option.name === "doctrine");
    const choices = doctrine && "choices" in doctrine ? doctrine.choices : undefined;

    expect(choices?.map((choice) => choice.value)).toEqual(["rawdog", "structured", "fine-control"]);
  });
});
