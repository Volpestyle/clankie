import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Receipt = { sessionId: string; event: { id: string; content: string; meta: unknown } };
/** One unresolved native dispatch per operator binding; survives launcher replacement. */
export class OpenCodeReceiptFence {
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
  }
  pending(): Receipt | undefined {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const value = JSON.parse(text) as Receipt;
    if (
      !value ||
      typeof value.sessionId !== "string" ||
      !value.event ||
      typeof value.event.id !== "string" ||
      typeof value.event.content !== "string"
    )
      throw new Error("Uncertain native receipt journal is invalid; dispatch is blocked");
    return value;
  }
  claim(receipt: Receipt): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    // Exclusive creation also fences two launchers for this same operator binding.
    writeFileSync(this.file, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
  }
  acknowledge(sessionId: string, eventId: string): boolean {
    const pending = this.pending();
    if (pending?.sessionId !== sessionId || pending.event.id !== eventId) return false;
    unlinkSync(this.file);
    return true;
  }
}
