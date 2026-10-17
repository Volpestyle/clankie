import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { rotateServiceLogs, serviceLogFile } from "../bin/service-supervisor.ts";

const children: number[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const pid of children.splice(0))
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function sequence(text: string): number[] {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { n: number }).n);
}

// VUH-2393: the live clankie.log reached 2.4 GB because nothing ever rotated it.
it("rotates a log a real service keeps appending to, keeping whole lines and bounded generations", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-log-rotation-"));
  roots.push(root);
  const env = { CLANKIE_STATE_HOME: root, CLANKIE_SERVICE_LOG_MAX_BYTES: String(16 * 1024) };
  const path = serviceLogFile("relay", env);
  await mkdir(join(root, "clankie"), { recursive: true });
  // The supervisor's own arrangement: an inherited O_APPEND descriptor the service writes through.
  const fd = openSync(path, "a", 0o600);
  const writer = spawn(
    process.execPath,
    [
      "-e",
      'let n = 0; setInterval(() => { for (let i = 0; i < 20; i++) process.stdout.write(JSON.stringify({ n: n++, pad: "x".repeat(120) }) + "\\n"); }, 2);',
    ],
    { stdio: ["ignore", fd, fd] },
  );
  closeSync(fd);
  children.push(writer.pid!);

  const archives = new Set<string>();
  for (let round = 0; round < 6; round++) {
    while ((await stat(path)).size <= 16 * 1024) await sleep(5);
    expect(await rotateServiceLogs(env)).toContain(path);
    archives.add(gunzipSync(await readFile(`${path}.1.gz`)).toString("utf8"));
  }
  await sleep(50);
  writer.kill("SIGKILL");
  await new Promise((resolve) => writer.once("exit", resolve));

  // Three compressed generations at most, beside the live file.
  const names = (await readdir(join(root, "clankie"))).filter((name) => name.startsWith("relay.log"));
  expect(names.sort()).toEqual(["relay.log", "relay.log.1.gz", "relay.log.2.gz", "relay.log.3.gz"]);
  // Truncation in place: the writer carried on at the start of the file, with no hole of NULs.
  const live = await readFile(path, "utf8");
  expect(live).not.toContain("\0");
  expect(live.length).toBeLessThan(1024 * 1024);
  // Every archive is whole lines in order; across rotations the sequence only moves forward.
  let last = -1;
  for (const text of archives) {
    const numbers = sequence(text);
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers[0]!).toBeGreaterThan(last);
    for (let index = 1; index < numbers.length; index++) expect(numbers[index]).toBe(numbers[index - 1]! + 1);
    last = numbers.at(-1)!;
  }
  expect(sequence(live)[0]!).toBeGreaterThan(last);
});
