import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { resourceNativeHelperPath, resourcePython } from "../src/process.ts";
import { ResourceStore } from "../src/store.ts";

it("cancels an OS lock waiter without entering its transaction or disturbing the holder", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clankie-lock-cancel-"));
  const holder = spawn(resourcePython, ["-I", resourceNativeHelperPath(), "lock", directory], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const done = new Promise<number | null>((resolve) => holder.once("exit", resolve));
  const lines = createInterface({ input: holder.stdout });
  try {
    expect((await lines[Symbol.asyncIterator]().next()).done).toBe(false);
    const controller = new AbortController();
    let applied = false;
    const waiting = new ResourceStore(directory).transaction(
      () => {
        applied = true;
      },
      { signal: controller.signal },
    );
    const cancelled = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    await delay(100);
    controller.abort();
    await cancelled;
    expect(applied).toBe(false);
    expect(holder.exitCode).toBe(null);
    holder.stdin.end("{}\n");
    expect(await done).toBe(0);
    await new ResourceStore(directory).transaction((state) => {
      expect(state.queue).toEqual([]);
    });
  } finally {
    lines.close();
    holder.stdin.destroy();
    if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGTERM");
    await done;
    await rm(directory, { recursive: true, force: true });
  }
});

it("names native filesystem and journal decoding failures without echoing their paths or contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clankie-lock-errors-"));
  try {
    const file = join(directory, "private-path");
    await writeFile(file, "private contents");
    await expect(new ResourceStore(file).transaction(() => {})).rejects.toMatchObject({
      message:
        "Fleet resource lock helper exited with code 1: Fleet resource lock helper failed: FileExistsError (errno 17) at directory-create",
    });
    await writeFile(join(directory, "state.json"), "private contents");
    await expect(new ResourceStore(directory).transaction(() => {})).rejects.toMatchObject({
      message:
        "Fleet resource lock helper exited with code 1: Fleet resource lock helper failed: JSONDecodeError at journal-read",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("discards a cancelled acquired mutation before sending a journal write", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clankie-lock-cancel-write-"));
  try {
    const controller = new AbortController();
    const store = new ResourceStore(directory);
    await expect(
      store.transaction(
        (state) => {
          state.policy.heavySlots = 99;
          controller.abort();
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect((await store.read()).policy.heavySlots).toBe(null);
    await store.transaction(() => {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("still bounds an acquired transaction and identifies its deadline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clankie-lock-deadline-"));
  try {
    const store = new ResourceStore(directory);
    await expect(
      store.transaction(async (state) => {
        state.policy.heavySlots = 99;
        await delay(16_000);
      }),
    ).rejects.toThrow("Fleet resource lock transaction exceeded 15000ms after acquisition");
    expect((await store.read()).policy.heavySlots).toBe(null);
    await store.transaction(() => {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

// VUH-2027: a queued `clankie heavy` died on one helper fault (EBADF at request-read).
// A fault before the helper reads our request committed nothing, so a fresh helper reruns it.
it("reruns a transaction on a fresh helper after a fault that committed nothing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clankie-lock-retry-"));
  try {
    // A real native fault: the helper locks, then fails reading a journal that is a directory.
    await mkdir(join(directory, "state.json"));
    let applied = 0;
    const retries: string[] = [];
    const result = await new ResourceStore(directory).transaction(
      (state) => {
        applied++;
        state.policy.simulatorIdleMs = 123_456;
        return "committed";
      },
      {
        // Repair the journal between attempts: the retry, not luck, must commit it.
        onRetry: (error) => {
          retries.push(error.message);
          rmSync(join(directory, "state.json"), { recursive: true });
        },
      },
    );
    expect(result).toBe("committed");
    expect(retries).toEqual([
      "Fleet resource lock helper exited with code 1: Fleet resource lock helper failed: IsADirectoryError (errno 21) at journal-read",
    ]);
    expect(applied).toBe(1);
    await new ResourceStore(directory).transaction((state) => {
      expect(state.policy.simulatorIdleMs).toBe(123_456);
    });
    // A fault that persists is still reported after the bounded attempts.
    await mkdir(join(directory, "blocked"));
    await mkdir(join(directory, "blocked", "state.json"));
    const persistent: number[] = [];
    await expect(
      new ResourceStore(join(directory, "blocked")).transaction(() => {}, {
        onRetry: (_error, attempt) => persistent.push(attempt),
      }),
    ).rejects.toThrow("IsADirectoryError (errno 21) at journal-read");
    expect(persistent).toEqual([1, 2]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
