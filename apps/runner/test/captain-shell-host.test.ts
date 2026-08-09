import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCaptainShellHost, type CaptainShellHost } from "../src/captain-shell-host.ts";

const doctrinePath = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "doctrine",
  "profiles",
  "self-build-lab.yaml",
);

const logger = { info: () => undefined, warn: () => undefined };

describe("captain shell host", () => {
  let stateRoot: string;
  let host: CaptainShellHost;

  beforeEach(async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "captain-shell-"));
    host = await createCaptainShellHost({
      doctrine: compileDoctrine([await loadDoctrineFile(doctrinePath)]),
      runnerStateRoot: stateRoot,
      logger,
    });
  });

  afterEach(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });

  it("runs a command and returns its output", async () => {
    const result = await host.run({ schemaVersion: 1, command: "echo hello" });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  it("writes into the scratchpad", async () => {
    const result = await host.run({ schemaVersion: 1, command: "echo noted > note.txt" });
    expect(result.outcome).toBe("ok");
    await expect(readFile(join(host.scratchPath, "note.txt"), "utf8")).resolves.toBe("noted\n");
  });

  /**
   * The load-bearing assertion: reads span the host while writes do not. A
   * regression here is the difference between a scratchpad and a free hand on
   * the operator's disk, and it is silent unless something checks it.
   */
  it("refuses a write outside the scratchpad while still reading outside it", async () => {
    const outside = join(stateRoot, "outside.txt");
    await writeFile(outside, "visible\n", "utf8");

    const read = await host.run({ schemaVersion: 1, command: `cat ${JSON.stringify(outside)}` });
    expect(read.outcome).toBe("ok");
    if (read.outcome === "ok") expect(read.stdout.trim()).toBe("visible");

    const write = await host.run({
      schemaVersion: 1,
      command: `echo tampered > ${JSON.stringify(outside)}`,
    });
    expect(write.outcome).toBe("ok");
    await expect(readFile(outside, "utf8")).resolves.toBe("visible\n");
    // The refusal has to be visible, not just effective: a blocked write that
    // reports nothing reads to him as a write that worked.
    if (write.outcome === "ok") expect(write.denials.join(" ")).toContain("Seatbelt");
  });

  /**
   * A script he writes and runs is still his shell. Seatbelt is inherited by
   * children, and `nohup`-style detachment does not shed it — without this,
   * "writes are confined" would only describe the first process.
   */
  it("confines a script it wrote, and a detached child of one", async () => {
    const outside = join(stateRoot, "guarded.txt");
    await writeFile(outside, "original\n", "utf8");
    const script = `printf '#!/bin/bash\\necho pwned > ${outside}\\n' > w.sh && chmod +x w.sh && ./w.sh; echo "exit=$?"`;
    const viaScript = await host.run({ schemaVersion: 1, command: script });
    expect(viaScript.outcome).toBe("ok");
    if (viaScript.outcome === "ok") expect(viaScript.stdout).toContain("exit=137");

    const detached = `nohup bash -c 'echo pwned > ${outside}' >/dev/null 2>&1 & wait; echo done`;
    await host.run({ schemaVersion: 1, command: detached });
    await expect(readFile(outside, "utf8")).resolves.toBe("original\n");
  });

  /**
   * No egress, ever. A seat that can read the whole disk and also reach the
   * network is an exfiltration tool regardless of how its description reads,
   * so this is the assertion that keeps the read boundary survivable.
   */
  it("denies network egress", async () => {
    const result = await host.run({
      schemaVersion: 1,
      command: `curl -s -m 5 -o /dev/null https://example.com; echo "exit=$?"`,
    });
    expect(result.outcome).toBe("ok");
    if (result.outcome === "ok") expect(result.stdout).toContain("exit=137");
  });

  it("carries no runner credentials into the command environment", async () => {
    process.env.CLANKIE_SHELL_HOST_SECRET_PROBE = "leaked";
    try {
      const result = await host.run({ schemaVersion: 1, command: "echo ${CLANKIE_SHELL_HOST_SECRET_PROBE:-absent}" });
      expect(result.outcome).toBe("ok");
      if (result.outcome === "ok") expect(result.stdout.trim()).toBe("absent");
    } finally {
      delete process.env.CLANKIE_SHELL_HOST_SECRET_PROBE;
    }
  });

  it("reads a file anywhere on the host with line bounds", async () => {
    const target = join(stateRoot, "lines.txt");
    await writeFile(target, "one\ntwo\nthree\nfour\n", "utf8");
    const result = await host.read({ schemaVersion: 1, path: target, offset: 2, limit: 2 });
    expect(result.outcome).toBe("ok");
    if (result.outcome !== "ok") return;
    expect(result.content).toBe("two\nthree");
    expect(result.firstLine).toBe(2);
    // Four lines, not five: the trailing newline terminates "four".
    expect(result.totalLines).toBe(4);
    expect(result.truncated).toBe(true);
  });

  it("refuses a directory rather than throwing", async () => {
    const result = await host.read({ schemaVersion: 1, path: stateRoot });
    expect(result).toMatchObject({ outcome: "refused", reason: "path_unreadable" });
  });

  it("times out a command that will not finish", async () => {
    const result = await host.run({ schemaVersion: 1, command: "sleep 30", timeoutMs: 1_000 });
    expect(result).toMatchObject({ outcome: "refused", reason: "timed_out" });
  });
});
