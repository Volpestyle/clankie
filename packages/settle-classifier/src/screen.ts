import { createHash } from "node:crypto";

// oxlint-disable no-control-regex -- terminal normalization intentionally matches ANSI/OSC controls
const OSC_SEQUENCE = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const CSI_SEQUENCE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const SINGLE_ESCAPE = /\u001B[@-_]/g;
// oxlint-enable no-control-regex

/** Removes terminal control sequences and rendering-only trailing whitespace. */
export function normalizeScreenText(text: string): string {
  return text
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(SINGLE_ESCAPE, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd();
}

/** Stable, non-reversible cache key for a normalized rendered screen. */
export function screenSignature(text: string): string {
  return createHash("sha256").update(normalizeScreenText(text)).digest("hex");
}

/** Returns only the bounded visible tail supplied to a local classifier. */
export function screenTail(text: string, lineLimit: number): { tail: string; lineCount: number } {
  const lines = normalizeScreenText(text).split("\n");
  const bounded = lines.slice(-lineLimit);
  return { tail: bounded.join("\n"), lineCount: bounded.length };
}
