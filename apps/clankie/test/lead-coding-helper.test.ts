import { mkdtempSync, writeFileSync, readFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
const processPort = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => {
    processPort.calls.push(args);
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      child.stdout.write("fake contained output");
      child.emit("close", 0, null);
    });
    return child;
  },
}));
// @ts-expect-error -- immutable image helper; local tests use disposable files and fake process only.
import { codingOperation } from "../../../scripts/evals/lead-coding-helper.mjs";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  processPort.calls.length = 0;
});
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "coding-helper-fixture-"));
  roots.push(root);
  return root;
};
test("bounded text operations and no-follow paths on disposable files", async () => {
  const root = fixture();
  await codingOperation({ op: "write", path: "test.txt", content: "original" }, root);
  expect(await codingOperation({ op: "read", path: "test.txt" }, root)).toEqual({ content: "original" });
  await codingOperation({ op: "write", path: "test.txt", content: "replacement" }, root);
  expect(readFileSync(join(root, "test.txt"), "utf8")).toBe("replacement");
  symlinkSync(join(root, "test.txt"), join(root, "link"));
  await expect(codingOperation({ op: "write", path: "link", content: "bad" }, root)).rejects.toThrow();
  await expect(codingOperation({ op: "read", path: "../outside" }, root)).rejects.toThrow("bounded");
  writeFileSync(join(root, "binary"), Buffer.from([0, 255]));
  await expect(codingOperation({ op: "read", path: "binary" }, root)).rejects.toThrow();
  writeFileSync(join(root, "large"), Buffer.alloc(1024 * 1024 + 1));
  await expect(codingOperation({ op: "read", path: "large" }, root)).rejects.toThrow("bounded");
});
test("shell text remains data to one fixed clean shell inside the helper", async () => {
  const root = fixture();
  const command = "echo $(candidate-data)";
  expect(await codingOperation({ op: "bash", command }, root)).toEqual({
    output: "fake contained output",
    exitCode: 0,
  });
  expect(processPort.calls).toEqual([
    [
      "/bin/bash",
      ["--noprofile", "--norc", "-c", command],
      {
        cwd: root,
        env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", TMPDIR: "/tmp" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    ],
  ]);
  await expect(codingOperation({ op: "bash", command, env: { KEY: "bad" } }, root)).rejects.toThrow(
    "bounded",
  );
});
