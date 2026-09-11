import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  bundledHerdrBinary,
  isHarnessSessionMarker,
  paneShellScript,
  startHerdrRuntime,
  watchHerdrSocket,
} from "../src/herdr-runtime.ts";

const roots: string[] = [];
async function temporary() {
  const root = await mkdtemp("/tmp/ch-test-");
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it("selects the built checkout or the installed native binary", async () => {
  const root = await temporary();
  await mkdir(join(root, ".data/herdr/bin"), { recursive: true });
  await writeFile(join(root, ".data/herdr/bin/herdr"), "");
  expect(bundledHerdrBinary(root)).toBe(join(root, ".data/herdr/bin/herdr"));
  await writeFile(join(root, "release.json"), "{}");
  expect(bundledHerdrBinary(root)).toBe(join(root, "libexec/herdr"));
  await expect(
    startHerdrRuntime({ binary: join(root, "missing"), repoRoot: root, stateRoot: root, env: {} }),
  ).rejects.toThrow("missing");
});

it("refuses to take over an occupied runtime socket", async () => {
  const root = await temporary();
  await mkdir(join(root, "herdr"));
  const server = createServer((socket) => socket.end());
  await new Promise<void>((done) => server.listen(join(root, "herdr/herdr.sock"), done));
  try {
    await expect(
      startHerdrRuntime({ binary: process.execPath, repoRoot: root, stateRoot: root, env: {} }),
    ).rejects.toThrow("already has an owner");
    expect(server.listening).toBe(true);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});

it("gives a bundled pane the owner's environment back before starting their login shell", async () => {
  const root = await temporary();
  // A stand-in for the owner's shell: it shows what the pane would inherit.
  const shell = join(root, "owner-shell");
  await writeFile(shell, '#!/bin/sh\necho "$1|${XDG_CONFIG_HOME-unset}|${XDG_STATE_HOME-unset}|$SHELL"\n', {
    mode: 0o700,
  });
  const script = join(root, "pane-shell");
  await writeFile(script, paneShellScript({ SHELL: shell, XDG_CONFIG_HOME: "/Users/o'wner/.config" }), {
    mode: 0o700,
  });
  // What the server, and so the pane, would otherwise carry: Clankie's isolation.
  const { stdout } = await promisify(execFile)(script, [], {
    env: {
      PATH: process.env.PATH ?? "",
      XDG_CONFIG_HOME: "/private/root",
      XDG_STATE_HOME: "/private/root",
      SHELL: script,
    },
  });
  expect(stdout.trim()).toBe(`-l|/Users/o'wner/.config|unset|${shell}`);
});

it("the owned runtime drops the markers a running harness stamps on its children", () => {
  for (const name of ["CLAUDECODE", "CLAUDE_PID", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_SESSION_ID"]) {
    expect(isHarnessSessionMarker(name)).toBe(true);
  }
  for (const name of ["PATH", "HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    expect(isHarnessSessionMarker(name)).toBe(false);
  }
});

it("unbinds from a watched session once its socket stops answering", async () => {
  const root = await temporary();
  const socketPath = join(root, "herdr.sock");
  const server = createServer((socket) => socket.end());
  await new Promise<void>((done) => server.listen(socketPath, done));
  await new Promise<void>((done) => {
    const watch = watchHerdrSocket({
      socketPath,
      intervalMs: 5,
      onLost: () => {
        watch.close();
        done();
      },
    });
    // Many checks against a live session, and only the stop unbinds him.
    setTimeout(() => server.close(), 50);
  });
  expect(server.listening).toBe(false);
});
