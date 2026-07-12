import { describe, expect, it } from "vitest";
import { commands } from "../src/commands.ts";
import { DISCORD_WORKER_STEER_CHOICES } from "../src/steering.ts";

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

  it("exposes mission steering, ambient approval handoff, and memory controls", () => {
    const names = commands.map((command) => command.name);
    expect(names).toContain("captain-steer");
    expect(names).toContain("captain-approval");
    expect(names).toContain("captain-memory");
  });

  it("makes arbitrary steering text impossible in the registered command schema", () => {
    const steering = commands.find((command) => command.name === "captain-steer");
    const intent = steering?.options?.find((option) => option.name === "intent");
    const choices = intent && "choices" in intent ? intent.choices : undefined;

    expect(steering?.options?.map((option) => option.name)).toEqual(["intent"]);
    expect(choices).toEqual(DISCORD_WORKER_STEER_CHOICES.map(({ name, value }) => ({ name, value })));
    expect(choices).toHaveLength(8);
    expect(intent && "max_length" in intent ? intent.max_length : undefined).toBeUndefined();
  });
});
