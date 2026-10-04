import { describe, expect, it, vi } from "vitest";
import { DesktopExpressions, desktopTools } from "../src/captain/desktop.ts";
import { DesktopExpressionSchema } from "../../../packages/protocol/src/presence.ts";
import { DesktopSettingsSchema, desktopIsQuiet } from "../../../packages/settings/src/desktop.ts";
import { pollPresence, projectPresence } from "../src/captain/presence.ts";

const idle = { thinking: false, inVoice: false, playing: false, activeSeats: 0 };
const overnight = { quietHours: { start: "22:00", end: "07:00", timeZone: "America/Chicago" } };
describe("desktop expressions", () => {
  it("validates clocks, time zones, equal bounds, positions and strict bodies", async () => {
    for (const quietHours of [
      { ...overnight.quietHours, start: "24:00" },
      { ...overnight.quietHours, timeZone: "Mars/Olympus" },
      { ...overnight.quietHours, end: "22:00" },
    ])
      expect(DesktopSettingsSchema.safeParse({ quietHours }).success).toBe(false);
    const desktop = new DesktopExpressions(async () => ({}));
    for (const input of [
      { kind: "move", x: -0.1, y: 0.5 },
      { kind: "move", x: 0.5, y: 1.1 },
      { kind: "say", text: " " },
      { kind: "say", text: "x".repeat(201) },
      { kind: "emote", animation: "invented" },
      { kind: "emote", animation: "hop", durationMs: 30001 },
      { kind: "say", text: "hi", extra: true },
    ])
      await expect(desktop.publish(input)).rejects.toThrow();
  });
  it("uses inclusive start/exclusive end in the owner's zone for overnight and daylight hours", () => {
    expect(desktopIsQuiet(overnight, new Date("2026-10-05T03:00:00Z"))).toBe(true);
    expect(desktopIsQuiet(overnight, new Date("2026-10-05T11:59:59Z"))).toBe(true);
    expect(desktopIsQuiet(overnight, new Date("2026-10-05T12:00:00Z"))).toBe(false);
    const daytime = { quietHours: { start: "09:00", end: "17:00", timeZone: "UTC" } };
    expect(desktopIsQuiet(daytime, new Date("2026-10-05T09:00:00Z"))).toBe(true);
    expect(desktopIsQuiet(daytime, new Date("2026-10-05T17:00:00Z"))).toBe(false);
    expect(desktopIsQuiet({}, new Date())).toBe(false);
  });
  it("replaces one expression with a unique id and leaves source mood untouched", async () => {
    const desktop = new DesktopExpressions(
      async () => ({}),
      () => Date.parse("2026-10-04T15:00:00Z"),
    );
    const first = await desktop.publish({ kind: "say", text: "Hello" });
    const second = await desktop.publish({ kind: "emote", animation: "happy" });
    expect(first.outcome).toBe("published");
    expect(second.outcome).toBe("published");
    if (first.outcome !== "published" || second.outcome !== "published") throw Error("Missing expression");
    expect(second.expression.id).not.toBe(first.expression.id);
    expect(second.expression.expiresAt).toBe("2026-10-04T15:00:05.000Z");
    expect(DesktopExpressionSchema.safeParse(second.expression).success).toBe(true);
    expect(projectPresence({ ...idle, expression: await desktop.current() }).mood).toBe("idle");
    expect(await desktop.current()).toEqual(second.expression);
    expect(desktopTools(desktop)[0]?.name).toBe("desktop");
  });
  it("suppresses publishing and clears an existing expression when quiet hours begin", async () => {
    let now = Date.parse("2026-10-05T02:59:59Z");
    const desktop = new DesktopExpressions(
      async () => overnight,
      () => now,
    );
    expect((await desktop.publish({ kind: "move", x: 0, y: 1 })).outcome).toBe("published");
    now += 1000;
    expect(await desktop.current()).toBeUndefined();
    expect(await desktop.publish({ kind: "say", text: "hello" })).toEqual({ outcome: "quiet_hours" });
  });
  it("expires at the boundary and wakes a held presence cursor", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-04T15:00:00Z"));
      const desktop = new DesktopExpressions(async () => ({}));
      await desktop.publish({ kind: "emote", animation: "hop", durationMs: 1000 });
      const read = async () => projectPresence({ ...idle, expression: await desktop.current() });
      const first = await read();
      const pending = pollPresence(read, first.cursor, 30000);
      await vi.advanceTimersByTimeAsync(1000);
      const expired = await pending;
      expect(expired.expression).toBeUndefined();
      expect(expired.cursor).not.toBe(first.cursor);
      expect(expired.mood).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });
});
