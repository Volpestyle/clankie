import { EventEmitter } from "node:events";
import { lstat, mkdtemp, open, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installDevHandoffShutdown,
  readDevHandoffConfig,
  removeTerminalGatewayCredential,
  startTerminalGatewayDevHandoff,
  writeTerminalGatewayCredential,
  type TerminalGatewayCredential,
} from "../src/terminal-gateway-dev-handoff.ts";
import { TerminalManager } from "../src/terminals.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "clankie-terminal-handoff-"));
  roots.push(path);
  return path;
}

function credential(handoffId = "handoff-1"): TerminalGatewayCredential {
  return {
    schemaVersion: 1,
    handoffId,
    url: "ws://127.0.0.1:4312/v1/terminals",
    token: "sensitive-token",
    principalId: "principal-1",
    deviceId: "device-1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

describe("terminal gateway dev handoff", () => {
  it("is disabled by default and requires explicit complete runtime-only configuration", () => {
    expect(readDevHandoffConfig({})).toBeNull();
    expect(() => readDevHandoffConfig({ CLANKIE_TERMINAL_GATEWAY_ENABLED: "1" })).toThrow(
      /gateway_config_incomplete/,
    );
    expect(
      readDevHandoffConfig({
        CLANKIE_TERMINAL_GATEWAY_ENABLED: "1",
        CLANKIE_TERMINAL_GATEWAY_CREDENTIAL_PATH: "/runtime/dev-terminal.json",
        CLANKIE_TERMINAL_GATEWAY_PRINCIPAL_ID: "principal-1",
        CLANKIE_TERMINAL_GATEWAY_DEVICE_ID: "device-1",
        CLANKIE_TERMINAL_GATEWAY_PORT: "4312",
      }),
    ).toMatchObject({ credentialPath: "/runtime/dev-terminal.json", port: 4312 });
  });

  it("atomically stages a mode-0600 descriptor and removes only its matching handoff", async () => {
    const path = join(await root(), "handoff.json");
    const expected = credential();
    await writeTerminalGatewayCredential(path, expected);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(expected);

    await removeTerminalGatewayCredential(path, "different-handoff");
    expect(JSON.parse(await readFile(path, "utf8")).handoffId).toBe("handoff-1");
    await removeTerminalGatewayCredential(path, "handoff-1");
    await expect(lstat(path)).rejects.toThrow();
  });

  it("fails closed with EEXIST when the final path is a regular file, leaving it and open readers unchanged", async () => {
    const directory = await root();
    const path = join(directory, "handoff.json");
    await writeFile(path, `${JSON.stringify(credential("existing-handoff"))}\n`, { mode: 0o600 });
    const before = await lstat(path);
    const reader = await open(path, "r");
    try {
      await expect(writeTerminalGatewayCredential(path, credential("new-handoff"))).rejects.toMatchObject({
        code: "EEXIST",
      });
      // The occupant is untouched: same inode, same mode, same content — not atomically replaced.
      const after = await lstat(path);
      expect(after.ino).toBe(before.ino);
      expect(after.mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path, "utf8")).handoffId).toBe("existing-handoff");
      // The already-open reader FD still sees the original content.
      expect(JSON.parse(await reader.readFile("utf8")).handoffId).toBe("existing-handoff");
      // No private temp is stranded in the directory.
      expect((await readdir(directory)).filter((name) => name.includes(".tmp"))).toHaveLength(0);
    } finally {
      await reader.close();
    }
  });

  it("fails closed with EEXIST when the final path is a symlink, never following or replacing it", async () => {
    const directory = await root();
    const target = join(directory, "target.json");
    const path = join(directory, "handoff.json");
    await writeFile(target, `${JSON.stringify(credential("target-handoff"))}\n`, { mode: 0o600 });
    await symlink(target, path);
    await expect(writeTerminalGatewayCredential(path, credential("new-handoff"))).rejects.toMatchObject({
      code: "EEXIST",
    });
    // The symlink itself and its target are both untouched: no clobber, no follow-through write.
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(target, "utf8")).handoffId).toBe("target-handoff");
    expect((await readdir(directory)).filter((name) => name.includes(".tmp"))).toHaveLength(0);
  });

  it("never follows or deletes a symlink during cleanup", async () => {
    const directory = await root();
    const target = join(directory, "target.json");
    const path = join(directory, "handoff.json");
    await writeFile(target, JSON.stringify(credential()), { mode: 0o600 });
    await symlink(target, path);
    await removeTerminalGatewayCredential(path, "handoff-1");
    expect(await readFile(target, "utf8")).toContain("sensitive-token");
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
  });

  it("binds, stages, invalidates, and nonce-cleans the real dev gateway idempotently", async () => {
    const path = join(await root(), "handoff.json");
    const handoff = await startTerminalGatewayDevHandoff({
      manager: new TerminalManager(),
      config: {
        credentialPath: path,
        principalId: "principal-1",
        deviceId: "device-1",
        port: 0,
        ttlMs: 2_000,
      },
    });
    const staged = JSON.parse(await readFile(path, "utf8")) as TerminalGatewayCredential;
    expect(staged.url).toBe(`ws://127.0.0.1:${handoff.address.port}/v1/terminals`);
    expect(staged.token).not.toBe("");
    await Promise.all([handoff.close(), handoff.close()]);
    await expect(lstat(path)).rejects.toThrow();
  });

  it("awaits shutdown once, preserves signal exit semantics, and never hangs on a repeated signal", async () => {
    const exit = vi.fn((_code?: number): void => {});
    const processLike = Object.assign(new EventEmitter(), { exit });
    let release!: () => void;
    const close = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const timers = new Set<object>();
    installDevHandoffShutdown(
      { address: { host: "127.0.0.1", port: 4312 }, close },
      {
        processLike,
        setTimer: () => {
          const timer = { unref: vi.fn() };
          timers.add(timer);
          return timer;
        },
        clearTimer: (timer) => timers.delete(timer),
      },
    );
    processLike.emit("SIGTERM");
    processLike.emit("SIGINT");
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(143));
    expect(timers.size).toBe(0);
  });
});
