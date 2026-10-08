import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
        "Fleet resource lock helper exited with code 1: Fleet resource lock helper failed: FileExistsError (errno 17)",
    });
    await writeFile(join(directory, "state.json"), "private contents");
    await expect(new ResourceStore(directory).transaction(() => {})).rejects.toMatchObject({
      message:
        "Fleet resource lock helper exited with code 1: Fleet resource lock helper failed: JSONDecodeError",
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
