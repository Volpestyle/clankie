import { existsSync, readFileSync } from "node:fs";
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
  /**
   * The savestate the core booted from — the configured beginning. Held so a
   * restart (ADR 0075) reboots to it without re-reading the operator's file;
   * the bytes were digest-verified at core creation.
   */
  bootSavestate: () => Uint8Array;
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

/**
 * Where the operator's ROM and savestate live when no env names them —
 * `~/.local/share/clankie/gba/`, the same well-known operator-local home the
 * checkpoint and body-lock directories use. Existence-gated: a machine without
 * the files keeps today's deterministic-double behavior, so a supervised
 * runner starts with no env prefix at all on a machine that has them.
 */
export function defaultGbaGameDir(env: NodeJS.ProcessEnv = process.env): string {
  const dataHome =
    env["XDG_DATA_HOME"] !== undefined && env["XDG_DATA_HOME"].length > 0
      ? env["XDG_DATA_HOME"]
      : path.join(homedir(), ".local", "share");
  return path.join(dataHome, "clankie", "gba");
}

function defaultedGamePath(configured: string | undefined, fallback: string): string | undefined {
  if (configured !== undefined) return configured;
  return existsSync(fallback) ? fallback : undefined;
}

export async function bootGbaGame(options: BootGbaGameOptions): Promise<BootedGbaGame> {
  const env = options.env ?? process.env;
  const gameDir = defaultGbaGameDir(env);
  const romPath = defaultedGamePath(env["CLANKIE_GBA_ROM_PATH"], path.join(gameDir, "firered.gba"));
  const savestatePath = defaultedGamePath(
    env["CLANKIE_GBA_SAVESTATE_PATH"],
    path.join(gameDir, "firered-bedroom.state"),
  );
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
  const savestateBytes = readFileSync(savestatePath);
  const core = await MgbaFireRedCore.create({
    coreId: routeScenario.coreId,
    romBytes: readFileSync(romPath),
    savestateBytes,
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
      bootSavestate: () => savestateBytes,
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

// The body root resolver moved to `@clankie/body-lock` with the mutex it
// scopes (VUH-938); re-exported so existing imports keep working.
export { defaultGbaBodyRootDir } from "@clankie/body-lock";
