import {
  EnvironmentRuntime,
  type EnvironmentAdapter,
  type EnvironmentEventSink,
} from "@clankie/environment-runtime";
import {
  GbaEmulatorAdapter,
  GbaFrameStream,
  type GbaCoreFactory,
  type GbaAdapterScenario,
  type GbaFrameSource,
} from "@clankie/gba-emulator";
import {
  MineflayerMinecraftAdapter,
  RealMineflayerMotorFactory,
  type MineflayerMotorFactory,
} from "@clankie/minecraft-mineflayer";
import type { RenderedSurfaceFrame } from "@clankie/interactive-environment";

export interface RunnerEnvironmentLifecycleOptions {
  rootDir: string;
  adapter: EnvironmentAdapter;
  events: EnvironmentEventSink;
  clock?: () => Date;
}

/** Runner composition boundary; concrete game adapters remain separate. */
export function createRunnerEnvironmentLifecycle(
  options: RunnerEnvironmentLifecycleOptions,
): EnvironmentRuntime {
  return new EnvironmentRuntime(options);
}

export interface RunnerMinecraftEnvironmentLifecycleOptions extends Omit<
  RunnerEnvironmentLifecycleOptions,
  "adapter"
> {
  /** Test injection only; production uses the real Mineflayer motor. */
  motorFactory?: MineflayerMotorFactory;
}

export interface RunnerMinecraftEnvironmentLifecycle {
  runtime: EnvironmentRuntime;
  adapter: MineflayerMinecraftAdapter;
}

/** Production composition: the trusted runner owns both the durable lease and Mineflayer body. */
export function createRunnerMinecraftEnvironmentLifecycle(
  options: RunnerMinecraftEnvironmentLifecycleOptions,
): RunnerMinecraftEnvironmentLifecycle {
  const adapter = new MineflayerMinecraftAdapter(options.motorFactory ?? new RealMineflayerMotorFactory());
  return {
    adapter,
    runtime: new EnvironmentRuntime({
      rootDir: options.rootDir,
      adapter,
      events: options.events,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    }),
  };
}

export interface RunnerGbaEnvironmentLifecycleOptions extends Omit<
  RunnerEnvironmentLifecycleOptions,
  "adapter"
> {
  /** Frozen scenario the session must bind to. */
  scenario: GbaAdapterScenario;
  /** SHA-256 of the scenario fixture bytes. */
  fixtureSha256: string;
  /**
   * Core factory. Omitted, the adapter falls back to its clearly-labeled
   * deterministic double, so this composition stays runnable without a ROM.
   */
  coreFactory?: GbaCoreFactory;
  /**
   * Optional rendered-surface sink (ADR 0047). When present, the runner
   * publishes bounded encoded frames for the activity plane. Frames leave
   * through this seam only — never through the semantic event stream.
   */
  publishFrame?: (frame: RenderedSurfaceFrame) => void;
}

export interface RunnerGbaEnvironmentLifecycle {
  runtime: EnvironmentRuntime;
  adapter: GbaEmulatorAdapter;
  /**
   * Publish the current frame for the activity plane. Returns false when the
   * stream declined it (rate-limited, unchanged, or not yet rendered), or when
   * no sink is configured. Safe to call on every observation.
   */
  publishFrame(source: GbaFrameSource, frameNumber: number, options?: { force?: boolean }): boolean;
}

/**
 * Production composition: the trusted runner owns the durable lease and the
 * emulator body, so playing becomes an agent decision dispatched through the
 * environment runtime rather than a script invocation.
 */
export function createRunnerGbaEnvironmentLifecycle(
  options: RunnerGbaEnvironmentLifecycleOptions,
): RunnerGbaEnvironmentLifecycle {
  const adapter =
    options.coreFactory === undefined
      ? new GbaEmulatorAdapter(options.scenario as never, options.fixtureSha256)
      : new GbaEmulatorAdapter(options.scenario, options.fixtureSha256, options.coreFactory);
  const sink = options.publishFrame;
  // One stream per lifecycle so rate-limit and dedupe state survive across
  // calls; the core it reads from is late-bound through this holder.
  let current: GbaFrameSource = { framebuffer: () => null };
  const stream = new GbaFrameStream({ source: { framebuffer: () => current.framebuffer() } });

  return {
    adapter,
    runtime: new EnvironmentRuntime({
      rootDir: options.rootDir,
      adapter,
      events: options.events,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    }),
    publishFrame(source, frameNumber, publishOptions) {
      if (sink === undefined) return false;
      current = source;
      const frame = stream.capture(frameNumber, publishOptions);
      if (frame === null) return false;
      sink(frame);
      return true;
    },
  };
}
