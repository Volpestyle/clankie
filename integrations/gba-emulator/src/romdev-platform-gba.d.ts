/**
 * Types for the pinned mGBA WASM core package (`romdev-platform-gba@0.11.0`,
 * MPL-2.0). Only the emulator-core surface is declared; the package's GBA
 * toolchain exports are unused here.
 */
declare module "romdev-platform-gba" {
  export const platform: "gba";
  export const core: {
    name: "mgba";
    /** Absolute path to the emscripten glue module for the libretro core. */
    jsPath: string;
    /** Absolute path to the prebuilt mgba_libretro.wasm binary. */
    wasmPath: string;
  };
}
