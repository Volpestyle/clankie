import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { core as mgbaCoreFiles } from "romdev-platform-gba";
import type { GbaButton } from "@clankie/interactive-environment";
import { sha256 } from "./core-double.ts";

/**
 * In-process, single-threaded libretro driver for the pinned mGBA WASM core
 * (`romdev-platform-gba@0.11.0`). No frontend, no timers, no audio output,
 * and no network path: the caller pumps frames one `retro_run()` at a time,
 * injects keypad state through the input-state callback, and reads system
 * RAM (GBA EWRAM) and the raw framebuffer straight out of the WASM heap.
 * Determinism comes from frame-stepped execution: identical ROM, savestate,
 * and input schedule produce byte-identical RAM and framebuffers.
 *
 * libretro C ABI, wasm32: all pointers and size_t values are 32-bit.
 */

const RETRO_DEVICE_JOYPAD = 1;
/** RETRO_MEMORY_SYSTEM_RAM: the GBA's 256 KB EWRAM (bus address 0x02000000). */
const RETRO_MEMORY_SYSTEM_RAM = 2;

/** libretro joypad button ids, indexed by the strict contract button names. */
const JOYPAD_ID: Record<GbaButton, number> = {
  b: 0,
  select: 2,
  start: 3,
  up: 4,
  down: 5,
  left: 6,
  right: 7,
  a: 8,
  l: 10,
  r: 11,
};

const ENV_GET_CAN_DUPE = 3;
const ENV_GET_SYSTEM_DIRECTORY = 9;
const ENV_SET_PIXEL_FORMAT = 10;
const ENV_GET_VARIABLE = 15;
const ENV_GET_VARIABLE_UPDATE = 17;
const ENV_GET_SAVE_DIRECTORY = 31;

export interface MgbaFramebuffer {
  width: number;
  height: number;
  /** Row-packed RGB565 little-endian pixels (pitch removed). */
  bytes: Uint8Array;
}

interface EmscriptenModule {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  addFunction(fn: (...args: number[]) => number | void, signature: string): number;
  cwrap(name: string, returnType: string | null, argTypes: string[]): (...args: number[]) => number;
  setValue(ptr: number, value: number, type: string): void;
  getValue(ptr: number, type: string): number;
}

/** SHA-256 of the pinned core's wasm binary, for supply-chain verification. */
export function mgbaCoreWasmSha256(): string {
  return sha256(readFileSync(mgbaCoreFiles.wasmPath));
}

export class MgbaLibretroCore {
  public frameCount = 0;
  private module: EmscriptenModule | null = null;
  private pixelFormat = 2; // RGB565, mGBA's default
  private frame: MgbaFramebuffer | null = null;
  private keymask = 0;
  private retroRun: () => number = () => 0;
  private retroLoadGame: (infoPtr: number) => number = () => 0;
  private retroGetMemoryData: (id: number) => number = () => 0;
  private retroGetMemorySize: (id: number) => number = () => 0;
  private retroSerializeSize: () => number = () => 0;
  private retroSerialize: (ptr: number, size: number) => number = () => 0;
  private retroUnserialize: (ptr: number, size: number) => number = () => 0;
  private retroSetControllerPortDevice: (port: number, device: number) => number = () => 0;

  public static async create(): Promise<MgbaLibretroCore> {
    const core = new MgbaLibretroCore();
    await core.initialize();
    return core;
  }

  private async initialize(): Promise<void> {
    const glueUrl = pathToFileURL(mgbaCoreFiles.jsPath).href;
    const glue = (await import(glueUrl)) as {
      default: (options: Record<string, unknown>) => Promise<EmscriptenModule>;
    };
    const wasmDir = path.dirname(mgbaCoreFiles.wasmPath);
    const module = await glue.default({
      locateFile: (file: string) => path.join(wasmDir, file),
      print: () => undefined,
      printErr: () => undefined,
    });
    this.module = module;

    const cString = (value: string): number => {
      const bytes = Buffer.from(`${value}\0`, "utf8");
      const ptr = module._malloc(bytes.length);
      module.HEAPU8.set(bytes, ptr);
      return ptr;
    };
    const systemDirPtr = cString("/");

    const environmentCallback = (command: number, data: number): number => {
      switch (command) {
        case ENV_GET_CAN_DUPE:
          module.setValue(data, 1, "i8");
          return 1;
        case ENV_SET_PIXEL_FORMAT:
          this.pixelFormat = module.getValue(data, "i32");
          return 1;
        case ENV_GET_SYSTEM_DIRECTORY:
        case ENV_GET_SAVE_DIRECTORY:
          module.setValue(data, systemDirPtr, "i32");
          return 1;
        case ENV_GET_VARIABLE:
          module.setValue(data + 4, 0, "i32"); // value = NULL -> core defaults
          return 0;
        case ENV_GET_VARIABLE_UPDATE:
          module.setValue(data, 0, "i8");
          return 1;
        default:
          return 0; // unhandled -> false; the core copes
      }
    };

    const videoRefreshCallback = (data: number, width: number, height: number, pitch: number): void => {
      this.frameCount += 1;
      if (data === 0) return; // duplicated frame; keep the previous one
      if (this.pixelFormat !== 2) throw new Error(`Unsupported libretro pixel format ${String(this.pixelFormat)}`);
      const rowBytes = width * 2;
      const out = new Uint8Array(rowBytes * height);
      for (let y = 0; y < height; y += 1) {
        const source = data + y * pitch;
        out.set(module.HEAPU8.subarray(source, source + rowBytes), y * rowBytes);
      }
      this.frame = { width, height, bytes: out };
    };

    const inputStateCallback = (_port: number, device: number, _index: number, id: number): number => {
      if (device !== RETRO_DEVICE_JOYPAD) return 0;
      return (this.keymask >> id) & 1;
    };

    const wrap = (name: string, returnType: string | null, argTypes: string[]) =>
      module.cwrap(name, returnType, argTypes);
    const setEnvironment = wrap("retro_set_environment", null, ["number"]);
    const setVideoRefresh = wrap("retro_set_video_refresh", null, ["number"]);
    const setInputPoll = wrap("retro_set_input_poll", null, ["number"]);
    const setInputState = wrap("retro_set_input_state", null, ["number"]);
    const setAudioSample = wrap("retro_set_audio_sample", null, ["number"]);
    const setAudioSampleBatch = wrap("retro_set_audio_sample_batch", null, ["number"]);
    const retroInit = wrap("retro_init", null, []);
    this.retroRun = wrap("retro_run", null, []);
    this.retroLoadGame = wrap("retro_load_game", "number", ["number"]);
    this.retroGetMemoryData = wrap("retro_get_memory_data", "number", ["number"]);
    this.retroGetMemorySize = wrap("retro_get_memory_size", "number", ["number"]);
    this.retroSerializeSize = wrap("retro_serialize_size", "number", []);
    this.retroSerialize = wrap("retro_serialize", "number", ["number", "number"]);
    this.retroUnserialize = wrap("retro_unserialize", "number", ["number", "number"]);
    this.retroSetControllerPortDevice = wrap("retro_set_controller_port_device", null, ["number", "number"]);

    // Order matters: the environment callback must be registered before
    // retro_init because the core queries it during initialization.
    setEnvironment(module.addFunction(environmentCallback, "iii"));
    retroInit();
    setVideoRefresh(module.addFunction(videoRefreshCallback, "viiii"));
    setInputPoll(module.addFunction(() => undefined, "v"));
    setInputState(module.addFunction(inputStateCallback, "iiiii"));
    setAudioSample(module.addFunction(() => undefined, "vii"));
    setAudioSampleBatch(module.addFunction((_data: number, frames: number) => frames, "iii"));
  }

  private requireModule(): EmscriptenModule {
    if (!this.module) throw new Error("mGBA core is not initialized");
    return this.module;
  }

  /** Load a ROM from raw bytes (mGBA sets need_fullpath=false). */
  public loadRom(bytes: Uint8Array): void {
    const module = this.requireModule();
    const romPtr = module._malloc(bytes.length);
    module.HEAPU8.set(bytes, romPtr);
    // struct retro_game_info { const char* path; const void* data; size_t size; const char* meta; }
    const infoPtr = module._malloc(16);
    module.setValue(infoPtr, 0, "i32");
    module.setValue(infoPtr + 4, romPtr, "i32");
    module.setValue(infoPtr + 8, bytes.length, "i32");
    module.setValue(infoPtr + 12, 0, "i32");
    if (this.retroLoadGame(infoPtr) === 0) throw new Error("retro_load_game failed");
    this.retroSetControllerPortDevice(0, RETRO_DEVICE_JOYPAD);
  }

  /** Replace the held-button set applied to subsequent frames. */
  public setHeldButtons(buttons: readonly GbaButton[]): void {
    let mask = 0;
    for (const button of buttons) mask |= 1 << JOYPAD_ID[button];
    this.keymask = mask;
  }

  /** Step exactly `frames` frames at the current held-button state. */
  public runFrames(frames: number): void {
    for (let i = 0; i < frames; i += 1) this.retroRun();
  }

  /** Copy of the GBA's 256 KB EWRAM (snapshot; the heap mutates on growth). */
  public readEwram(): Uint8Array {
    const module = this.requireModule();
    const ptr = this.retroGetMemoryData(RETRO_MEMORY_SYSTEM_RAM);
    const size = this.retroGetMemorySize(RETRO_MEMORY_SYSTEM_RAM);
    if (ptr === 0 || size === 0) throw new Error("EWRAM is not available");
    return module.HEAPU8.slice(ptr, ptr + size);
  }

  /** Latest rendered framebuffer, or null before the first rendered frame. */
  public framebuffer(): MgbaFramebuffer | null {
    return this.frame ? { ...this.frame, bytes: this.frame.bytes.slice() } : null;
  }

  /** Serialize the full core state (deterministic pinned starting points). */
  public saveState(): Uint8Array {
    const module = this.requireModule();
    const size = this.retroSerializeSize();
    const ptr = module._malloc(size);
    try {
      if (this.retroSerialize(ptr, size) === 0) throw new Error("retro_serialize failed");
      return module.HEAPU8.slice(ptr, ptr + size);
    } finally {
      module._free(ptr);
    }
  }

  /** Restore a previously serialized core state. */
  public loadState(bytes: Uint8Array): void {
    const module = this.requireModule();
    const ptr = module._malloc(bytes.length);
    try {
      module.HEAPU8.set(bytes, ptr);
      if (this.retroUnserialize(ptr, bytes.length) === 0) throw new Error("retro_unserialize failed");
    } finally {
      module._free(ptr);
    }
  }
}
