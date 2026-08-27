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
 * injects keypad state through the input-state callback, and reads mapped GBA
 * memory plus the raw framebuffer straight out of the WASM heap.
 * Determinism comes from frame-stepped execution: identical ROM, savestate,
 * and input schedule produce byte-identical RAM and framebuffers.
 *
 * libretro C ABI, wasm32: all pointers and size_t values are 32-bit.
 */

const RETRO_DEVICE_JOYPAD = 1;
/** One frame per observation is hardware rate. */
const OBSERVE_CHUNK_FRAMES = 1;
/** Wall-clock milliseconds one emulated frame represents. */
const FRAME_INTERVAL_MS = 1_000 / 59.7275;
/** RETRO_MEMORY_SYSTEM_RAM: the GBA's 256 KB EWRAM (bus address 0x02000000). */
const RETRO_MEMORY_SYSTEM_RAM = 2;
const GBA_EWRAM_BUS_ADDRESS = 0x02000000;
const GBA_EWRAM_BYTE_LENGTH = 0x40000;
export const GBA_IWRAM_BUS_ADDRESS = 0x03000000;
export const GBA_IWRAM_BYTE_LENGTH = 0x8000;

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
/** RETRO_ENVIRONMENT_SET_MEMORY_MAPS includes RETRO_ENVIRONMENT_EXPERIMENTAL. */
const ENV_SET_MEMORY_MAPS = 36 | 0x10000;

/**
 * wasm32 layout of libretro's `retro_memory_descriptor`.
 *
 * `uint64_t flags` gives the struct 8-byte alignment, so the eight 32-bit
 * pointer/size fields occupy offsets 8..35 and the descriptor is padded to a
 * 40-byte stride. mGBA passes a stack-allocated descriptor array to the
 * environment callback; callers must copy values during the callback.
 */
const RETRO_MEMORY_DESCRIPTOR_STRIDE = 40;
const MAX_MEMORY_DESCRIPTORS = 64;

export interface LibretroMemoryDescriptor {
  flags: bigint;
  heapPointer: number;
  offset: number;
  busAddress: number;
  select: number;
  disconnect: number;
  byteLength: number;
}

const requireHeapRange = (heap: Uint8Array, pointer: number, byteLength: number, label: string): void => {
  if (
    !Number.isSafeInteger(pointer) ||
    !Number.isSafeInteger(byteLength) ||
    pointer < 0 ||
    byteLength < 0 ||
    pointer + byteLength > heap.byteLength
  ) {
    throw new Error(`${label} is outside the mGBA WASM heap`);
  }
};

/**
 * Copy a libretro memory map out of the transient callback payload.
 *
 * Exported for an ABI-level synthetic-heap test. The returned descriptors do
 * not retain a view of the callback's stack memory.
 */
export function decodeLibretroMemoryMap(
  heap: Uint8Array,
  memoryMapPointer: number,
): LibretroMemoryDescriptor[] {
  requireHeapRange(heap, memoryMapPointer, 8, "libretro memory map");
  const view = new DataView(heap.buffer, heap.byteOffset, heap.byteLength);
  const descriptorsPointer = view.getUint32(memoryMapPointer, true);
  const descriptorCount = view.getUint32(memoryMapPointer + 4, true);
  if (descriptorCount === 0 || descriptorCount > MAX_MEMORY_DESCRIPTORS) {
    throw new Error(`libretro memory map has invalid descriptor count ${String(descriptorCount)}`);
  }
  requireHeapRange(
    heap,
    descriptorsPointer,
    descriptorCount * RETRO_MEMORY_DESCRIPTOR_STRIDE,
    "libretro memory descriptors",
  );

  return Array.from({ length: descriptorCount }, (_, index) => {
    const base = descriptorsPointer + index * RETRO_MEMORY_DESCRIPTOR_STRIDE;
    const flags = view.getBigUint64(base, true);
    const heapPointer = view.getUint32(base + 8, true);
    const offset = view.getUint32(base + 12, true);
    const busAddress = view.getUint32(base + 16, true);
    const select = view.getUint32(base + 20, true);
    const disconnect = view.getUint32(base + 24, true);
    const byteLength = view.getUint32(base + 28, true);
    if (heapPointer !== 0) {
      requireHeapRange(heap, heapPointer + offset, byteLength, "libretro mapped memory");
    }
    return {
      flags,
      heapPointer,
      offset,
      busAddress,
      select,
      disconnect,
      byteLength,
    };
  });
}

export interface MgbaFramebuffer {
  width: number;
  height: number;
  /** Row-packed RGB565 little-endian pixels (pitch removed). */
  bytes: Uint8Array;
}

export interface MgbaCoreIdentity {
  readonly romSha256: string;
  readonly savestateSha256: string;
  readonly coreWasmSha256: string;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((done) => setTimeout(done, ms));
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
  private memoryDescriptors: LibretroMemoryDescriptor[] = [];
  private keymask = 0;
  private observedRunInProgress = false;
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
        case ENV_SET_MEMORY_MAPS:
          this.memoryDescriptors = decodeLibretroMemoryMap(module.HEAPU8, data);
          return 1;
        default:
          return 0; // unhandled -> false; the core copes
      }
    };

    const videoRefreshCallback = (data: number, width: number, height: number, pitch: number): void => {
      this.frameCount += 1;
      if (data === 0) return; // duplicated frame; keep the previous one
      if (this.pixelFormat !== 2)
        throw new Error(`Unsupported libretro pixel format ${String(this.pixelFormat)}`);
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

  /** Run console-clock frames between actions without interrupting a held input. */
  public idleFrames(frames: number, observer: (() => void) | null): boolean {
    if (this.observedRunInProgress || frames <= 0) return false;
    this.setHeldButtons([]);
    this.runFrames(frames);
    observer?.();
    return true;
  }

  /**
   * Run frames with optional hardware-speed pacing and per-frame observation.
   * The deadline stays anchored to the start so timer rounding does not make a
   * long action drift slower than the console.
   */
  public async runFramesObserved(
    frames: number,
    observer: (() => void) | null,
    paceToWallClock: () => boolean,
  ): Promise<void> {
    if (observer === null && !paceToWallClock()) {
      this.runFrames(frames);
      return;
    }
    this.observedRunInProgress = true;
    try {
      const startedAt = performance.now();
      let done = 0;
      while (done < frames) {
        const chunk = Math.min(OBSERVE_CHUNK_FRAMES, frames - done);
        this.runFrames(chunk);
        done += chunk;
        observer?.();
        if (paceToWallClock()) {
          await delay(startedAt + done * FRAME_INTERVAL_MS - performance.now());
        }
      }
    } finally {
      this.observedRunInProgress = false;
    }
  }

  private readMappedMemory(busAddress: number, byteLength: number, label: string): Uint8Array {
    const module = this.requireModule();
    const descriptor = this.memoryDescriptors.find(
      (candidate) =>
        candidate.busAddress === busAddress &&
        candidate.byteLength === byteLength &&
        candidate.heapPointer !== 0,
    );
    if (!descriptor) throw new Error(`${label} is absent from the libretro memory map`);
    const pointer = descriptor.heapPointer + descriptor.offset;
    requireHeapRange(module.HEAPU8, pointer, byteLength, label);
    return module.HEAPU8.slice(pointer, pointer + byteLength);
  }

  /** Copy of the GBA's 256 KB EWRAM (snapshot; the heap mutates on growth). */
  public readEwram(): Uint8Array {
    if (this.memoryDescriptors.length > 0) {
      return this.readMappedMemory(GBA_EWRAM_BUS_ADDRESS, GBA_EWRAM_BYTE_LENGTH, "EWRAM");
    }
    // Compatibility path for a libretro build that implements the legacy
    // system-RAM accessor but does not publish RETRO_ENVIRONMENT_SET_MEMORY_MAPS.
    const module = this.requireModule();
    const ptr = this.retroGetMemoryData(RETRO_MEMORY_SYSTEM_RAM);
    const size = this.retroGetMemorySize(RETRO_MEMORY_SYSTEM_RAM);
    if (ptr === 0 || size !== GBA_EWRAM_BYTE_LENGTH) throw new Error("EWRAM is not available");
    requireHeapRange(module.HEAPU8, ptr, size, "EWRAM");
    return module.HEAPU8.slice(ptr, ptr + size);
  }

  /** Copy of the GBA's 32 KB IWRAM from mGBA's published memory map. */
  public readIwram(): Uint8Array {
    return this.readMappedMemory(GBA_IWRAM_BUS_ADDRESS, GBA_IWRAM_BYTE_LENGTH, "IWRAM");
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
