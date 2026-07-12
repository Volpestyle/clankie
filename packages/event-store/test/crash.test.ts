import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteEventStore } from "../src/index.ts";

const writerPath = join(import.meta.dirname, "crash-writer.ts");

describe("SqliteEventStore crash safety", () => {
  it("loses no acknowledged events when the writer is killed mid-stream", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "clankie-crash-")), "events.db");
    const child = spawn(process.execPath, [writerPath, path, "5000"], {
      stdio: ["ignore", "pipe", "inherit"],
    });

    const acknowledged: string[] = [];
    const killed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });

    let buffered = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      acknowledged.push(...lines.filter((line) => line.length > 0));
      if (acknowledged.length >= 25 && child.exitCode === null) child.kill("SIGKILL");
    });

    const exit = await killed;
    expect(exit.signal).toBe("SIGKILL");
    expect(acknowledged.length).toBeGreaterThanOrEqual(25);
    expect(acknowledged.length).toBeLessThan(5000);

    const store = new SqliteEventStore(path);
    const survivedIds = new Set((await store.readAll()).map((entry) => entry.event.id));
    const lost = acknowledged.filter((id) => !survivedIds.has(id));
    expect(lost).toEqual([]);
    expect(await store.verify()).toMatchObject({ valid: true });
    store.close();
  }, 30_000);
});
