import { describe, expect, it } from "vitest";
import { MineflayerMinecraftAdapter, type MineflayerMotorFactory } from "@clankie/minecraft-mineflayer";
import { EnvironmentRuntime } from "@clankie/environment-runtime";
import { GbaEmulatorAdapter } from "@clankie/gba-emulator";
import {
  createRunnerGbaEnvironmentLifecycle,
  createRunnerMinecraftEnvironmentLifecycle,
} from "../src/environment-lifecycle.ts";

describe("runner Minecraft composition", () => {
  it("keeps the Mineflayer body and durable lifecycle in the trusted runner", () => {
    const motorFactory = {
      connect: () => Promise.reject(new Error("not used")),
    } satisfies MineflayerMotorFactory;
    const lifecycle = createRunnerMinecraftEnvironmentLifecycle({
      rootDir: "/tmp/clankie-runner-minecraft-composition-test",
      events: { append: () => Promise.resolve() },
      motorFactory,
    });

    expect(lifecycle.adapter).toBeInstanceOf(MineflayerMinecraftAdapter);
    expect(lifecycle.runtime).toBeInstanceOf(EnvironmentRuntime);
  });
});

describe("runner GBA composition", () => {
  const fixtureSha256 = "a".repeat(64);
  const scenario = { scenarioId: "test", version: 1 } as never;
  const coreFactory = (() => ({})) as never;

  function framebuffer(fill: number) {
    const bytes = new Uint8Array(240 * 160 * 2);
    bytes.fill(fill);
    return { width: 240, height: 160, bytes };
  }

  it("puts the emulator body behind the durable environment runtime", () => {
    const lifecycle = createRunnerGbaEnvironmentLifecycle({
      rootDir: "/tmp/clankie-runner-gba-composition-test",
      events: { append: () => Promise.resolve() },
      scenario,
      fixtureSha256,
      coreFactory,
    });

    expect(lifecycle.adapter).toBeInstanceOf(GbaEmulatorAdapter);
    expect(lifecycle.runtime).toBeInstanceOf(EnvironmentRuntime);
  });

  it("publishes frames only when a sink is configured, and keeps dedupe state across calls", () => {
    const published: number[] = [];
    let fill = 0x11;
    const source = { framebuffer: () => framebuffer(fill) };

    // No sink: the activity plane is off, so nothing is encoded or published.
    const silent = createRunnerGbaEnvironmentLifecycle({
      rootDir: "/tmp/clankie-runner-gba-silent",
      events: { append: () => Promise.resolve() },
      scenario,
      fixtureSha256,
      coreFactory,
    });
    expect(silent.publishFrame(source, 1)).toBe(false);

    const lifecycle = createRunnerGbaEnvironmentLifecycle({
      rootDir: "/tmp/clankie-runner-gba-frames",
      events: { append: () => Promise.resolve() },
      scenario,
      fixtureSha256,
      coreFactory,
      publishFrame: (frame) => published.push(frame.sequence),
    });

    expect(lifecycle.publishFrame(source, 1)).toBe(true);
    // Same picture: the stream's dedupe state survived the call, so nothing ships.
    expect(lifecycle.publishFrame(source, 2, { force: false })).toBe(false);
    // A changed picture ships again with a monotonic sequence.
    fill = 0x77;
    expect(lifecycle.publishFrame(source, 3, { force: true })).toBe(true);
    expect(published).toEqual([1, 2]);
  });
});
