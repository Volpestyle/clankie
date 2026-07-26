import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { FrozenGbaScenarioSchema } from "./contracts.ts";
import { sha256 } from "./core-double.ts";
import type { GbaAdapterScenario, GbaCoreFactory } from "./core-seam.ts";
import { MgbaFireRedCore, type MgbaFireRedCoreIdentity } from "./firered-core.ts";
import { encodeFramebufferPng } from "./framebuffer-png.ts";
import { RealGbaRouteScenarioSchema, type RealGbaRouteScenario } from "./real-scenario.ts";

/**
 * Resolve which game Clankie is looking at.
 *
 * Shared by the free-play CLI and the MCP server so there is exactly one path
 * to the core. A second loader would be a second place for ROM digests to be
 * checked — or not checked.
 *
 * ROM-gated: with a ROM and savestate configured this is the real game behind
 * the pinned mGBA core, which fails closed unless every digest matches. Without
 * them it is the clearly-labeled deterministic double, so the surface is usable
 * without copyrighted bytes.
 */
/**
 * Savestate capture and restore, present only on the real core.
 *
 * The deterministic double has no serializable state — its determinism *is*
 * its identity — so on the double the capability is absent rather than stubbed.
 */
export interface GbaCheckpointCapability {
  saveState: () => Uint8Array;
  loadState: (bytes: Uint8Array) => void;
  /** Digests verified at core creation; a checkpoint must match them to load. */
  identity: MgbaFireRedCoreIdentity;
  /** The booted route scenario — the template a checkpoint's companion scenario is minted from. */
  scenario: RealGbaRouteScenario;
}

export interface BootedGbaGame {
  scenario: GbaAdapterScenario;
  fixtureSha256: string;
  /** Undefined when running the deterministic double. */
  coreFactory: GbaCoreFactory | undefined;
  /** Undefined when running the deterministic double. */
  checkpoints: GbaCheckpointCapability | undefined;
  /** Latest rendered screen, upscaled, or null when nothing has rendered. */
  framePng: (scale?: number) => Uint8Array | null;
  /**
   * Watch the screen during an action rather than only after it.
   *
   * One action otherwise yields one frame, because the core advances only when
   * driven — a watcher sees a teleport, not a step. `pace` additionally runs the
   * action at hardware speed so it reads as gameplay instead of a burst.
   * No-op on the deterministic double, which renders nothing.
   */
  observeFrames: (observer: (() => void) | null, options?: { pace?: boolean }) => void;
  framebufferSha256: () => string | null;
  real: boolean;
}

export interface BootGbaGameOptions {
  env?: NodeJS.ProcessEnv;
  /** Directory holding the ROM-gated fixtures, i.e. the package's own. */
  fixturesDir: string;
  /** Fallback frozen double scenario when no ROM is configured. */
  doubleScenarioPath: string;
}

export async function bootGbaGame(options: BootGbaGameOptions): Promise<BootedGbaGame> {
  const env = options.env ?? process.env;
  const romPath = env["CLANKIE_GBA_ROM_PATH"];
  const savestatePath = env["CLANKIE_GBA_SAVESTATE_PATH"];
  const real = romPath !== undefined && savestatePath !== undefined;

  const scenarioPath =
    env["CLANKIE_GBA_SCENARIO_PATH"] ??
    (real
      ? path.join(options.fixturesDir, "firered-bedroom-route/v1/scenario.json")
      : options.doubleScenarioPath);
  const fixtureBytes = readFileSync(scenarioPath);
  const parsed: unknown = JSON.parse(fixtureBytes.toString("utf8"));

  if (!real) {
    return {
      scenario: FrozenGbaScenarioSchema.parse(parsed) as GbaAdapterScenario,
      fixtureSha256: sha256(fixtureBytes),
      coreFactory: undefined,
      checkpoints: undefined,
      framePng: () => null,
      observeFrames: () => undefined,
      framebufferSha256: () => null,
      real: false,
    };
  }

  const routeScenario = RealGbaRouteScenarioSchema.parse(parsed);
  const core = await MgbaFireRedCore.create({
    coreId: routeScenario.coreId,
    romBytes: readFileSync(romPath),
    savestateBytes: readFileSync(savestatePath),
    romSha256: routeScenario.romSha256,
    savestateSha256: routeScenario.savestateSha256,
    coreWasmSha256: routeScenario.coreWasmSha256,
    mapId: routeScenario.map.mapId,
  });

  return {
    scenario: routeScenario as GbaAdapterScenario,
    fixtureSha256: sha256(fixtureBytes),
    coreFactory: () => core,
    checkpoints: {
      saveState: () => core.saveState(),
      loadState: (bytes) => {
        core.loadState(bytes);
      },
      identity: core.identity(),
      scenario: routeScenario,
    },
    framePng: (scale = 3) => {
      try {
        return encodeFramebufferPng(core.framebufferSnapshot(), scale);
      } catch {
        // Nothing rendered yet.
        return null;
      }
    },
    framebufferSha256: () => {
      try {
        return core.framebufferSha256();
      } catch {
        return null;
      }
    },
    observeFrames: (observer, options) => {
      core.observeFrames(observer, options ?? {});
    },
    real: true,
  };
}

/**
 * Where the emulator body's environment lease lives.
 *
 * Every entrypoint that drives the body must use the *same* directory, because
 * that is what makes `EnvironmentRuntime`'s existing one-writer rule apply
 * across processes: it already refuses a second writer with "Body already has
 * writer session", but only for sessions it can see.
 *
 * Previously each entrypoint made its own temp directory, so the free-play CLI
 * and the MCP server were invisible to one another and could drive the same
 * game at once — the footgun ADR 0053 recorded. A stable path turns that from a
 * documented warning into a refusal.
 */
export function defaultGbaBodyRootDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["CLANKIE_GBA_BODY_ROOT"];
  if (override !== undefined && override.length > 0) {
    mkdirSync(override, { recursive: true });
    return override;
  }
  const stateHome =
    env["XDG_STATE_HOME"] !== undefined && env["XDG_STATE_HOME"].length > 0
      ? env["XDG_STATE_HOME"]
      : path.join(homedir(), ".local", "state");
  const root = path.join(stateHome, "clankie", "gba-body");
  mkdirSync(root, { recursive: true });
  return root;
}
