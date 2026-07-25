import { writeFileSync } from "node:fs";
import { encodeFramebufferPng } from "../src/framebuffer-png.ts";
import type { MgbaFramebuffer } from "../src/mgba-core.ts";

/** Write an RGB565 framebuffer as a truecolor PNG (no external encoder). */
export function writeFramebufferPng(frame: MgbaFramebuffer, outPath: string): void {
  writeFileSync(outPath, encodeFramebufferPng(frame));
}
