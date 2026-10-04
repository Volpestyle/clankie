import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { membershipNativeCommand } from "../src/fleet-project-membership-native.ts";

it("aborts only its own deterministic helper and waits for exit before settling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "membership-child-"));
  try {
    const pidfile = join(directory, "pid");
    const controller = new AbortController();
    const child = membershipNativeCommand(
      process.execPath,
      [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",
        pidfile,
      ],
      controller.signal,
    );
    const refusal = expect(child).rejects.toThrow();
    let pid = 0;
    await vi.waitFor(async () => {
      pid = Number(await readFile(pidfile, "utf8"));
      expect(pid).toBeGreaterThan(1);
    });
    controller.abort();
    await refusal;
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("bounds child output and fails missing executables without hanging cleanup", async () => {
  await expect(
    membershipNativeCommand(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(2*1024*1024))"],
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  await expect(
    membershipNativeCommand("/not-an-executable", [], new AbortController().signal),
  ).rejects.toThrow();
});
