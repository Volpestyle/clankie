// Frozen acceptance probes for the terminal gateway (VUH-894), promoted from the
// VUH-870 independent verification counterexamples repaired in 4e61cb94. Each probe
// reproduces the exact adversarial scenario that was proven to fail closed:
// 1. attribution mismatch → one static typed error, then CLOSE; a queued valid
//    request on the same socket is never processed;
// 2. dev-handoff credential publication onto an occupied path → EEXIST fail-closed
//    with the occupant (inode, symlink, target, content, mode, open readers)
//    untouched and no temp or token leakage; absent-path 0600 publication succeeds.
import { lstat, mkdtemp, open, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { TerminalAccessAuthority } from "../src/terminal-access-authority.ts";
import { createTerminalGateway, TERMINAL_GATEWAY_PATH } from "../src/terminal-gateway.ts";
import {
  writeTerminalGatewayCredential,
  type TerminalGatewayCredential,
} from "../src/terminal-gateway-dev-handoff.ts";
import { TerminalManager } from "../src/terminals.ts";

const SECRET = Buffer.alloc(32, 7);
const PRINCIPAL = "principal-1";
const DEVICE = "device-1";
const ATTR = { principalId: PRINCIPAL, deviceId: DEVICE, clientInstanceId: "client-1" };

const teardown: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (teardown.length) await teardown.pop()?.();
});

function discover(requestId: string, principalId = PRINCIPAL) {
  return {
    protocolVersion: 1,
    type: "terminal.discover",
    requestId,
    supportedProtocolVersions: [1],
    attribution: { ...ATTR, principalId },
  };
}

describe("terminal gateway acceptance — attribution mismatch fails closed", () => {
  it("emits exactly one static typed error, closes the connection, and never processes a queued valid request", async () => {
    const manager = new TerminalManager();
    const authority = new TerminalAccessAuthority({ secret: SECRET });
    const gateway = await createTerminalGateway({ manager, authority, config: { port: 0 } });
    teardown.push(() => gateway.close());
    const secretToken = authority.mintObserveToken({ principalId: PRINCIPAL, deviceId: DEVICE });

    const received: Array<Record<string, unknown>> = [];
    const socket = new WebSocket(`ws://127.0.0.1:${gateway.address.port}${TERMINAL_GATEWAY_PATH}`, {
      headers: { authorization: `Bearer ${secretToken}` },
    });
    teardown.push(() => socket.terminate());
    socket.on("message", (data: Buffer) => received.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      socket.on("open", () => resolve());
      socket.on("unexpected-response", (_request, response) =>
        reject(new Error(`http ${response.statusCode}`)),
      );
    });

    const closed = new Promise<string>((resolve) => socket.on("close", () => resolve("closed")));
    const queuedRequestProcessed = new Promise<string>((resolve) => {
      socket.on("message", (data: Buffer) => {
        if ((JSON.parse(data.toString()) as { type: string }).type === "terminal.discovery") {
          resolve("processed_queued_request");
        }
      });
    });

    // A schema-valid mismatched discover with a correctly attributed discover already
    // queued behind it on the same socket.
    socket.send(JSON.stringify(discover("mismatch", "someone-else")));
    socket.send(JSON.stringify(discover("good")));

    // Fail-closed: the connection must close before the queued valid request is answered.
    await expect(Promise.race([closed, queuedRequestProcessed])).resolves.toBe("closed");
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    const errors = received.filter((message) => message.type === "terminal.error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      type: "terminal.error",
      code: "attribution_mismatch",
      requestId: "mismatch",
      retryable: false,
    });
    expect(received.filter((message) => message.type === "terminal.discovery")).toHaveLength(0);
    // Static/redacted error content: neither the bearer token nor the mismatched
    // attribution payload is echoed back.
    const serialized = JSON.stringify(errors[0]);
    expect(serialized).not.toContain(secretToken);
    expect(serialized).not.toContain("someone-else");
  });
});

describe("terminal gateway acceptance — credential publication never clobbers", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  async function root(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "clankie-gateway-acceptance-"));
    roots.push(path);
    return path;
  }

  function credential(handoffId: string, token: string): TerminalGatewayCredential {
    return {
      schemaVersion: 1,
      handoffId,
      url: "ws://127.0.0.1:4312/v1/terminals",
      token,
      principalId: PRINCIPAL,
      deviceId: DEVICE,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  async function rejection(path: string, fresh: TerminalGatewayCredential): Promise<NodeJS.ErrnoException> {
    const outcome = await writeTerminalGatewayCredential(path, fresh).then(
      () => null,
      (error: unknown) => error as NodeJS.ErrnoException,
    );
    expect(outcome, "publication onto an occupied path must fail closed").not.toBeNull();
    return outcome as NodeJS.ErrnoException;
  }

  it("fails EEXIST on an occupied regular file, leaving inode, mode, content, and open readers unchanged", async () => {
    const directory = await root();
    const path = join(directory, "handoff.json");
    await writeFile(path, `${JSON.stringify(credential("existing-handoff", "OLD-KEEP-TOKEN"))}\n`, {
      mode: 0o600,
    });
    const before = await lstat(path);
    const reader = await open(path, "r");
    try {
      const error = await rejection(path, credential("new-handoff", "NEW-SECRET-TOKEN"));
      expect(error.code).toBe("EEXIST");
      // The fresh token never leaks through the failure surface.
      expect(`${String(error)}\n${error.stack ?? ""}`).not.toContain("NEW-SECRET-TOKEN");
      // The occupant is untouched: same inode, same mode, same content.
      const after = await lstat(path);
      expect(after.ino).toBe(before.ino);
      expect(after.mode & 0o777).toBe(0o600);
      const kept = JSON.parse(await readFile(path, "utf8")) as TerminalGatewayCredential;
      expect(kept).toMatchObject({ handoffId: "existing-handoff", token: "OLD-KEEP-TOKEN" });
      // An already-open reader FD still sees the original inode content.
      expect(JSON.parse(await reader.readFile("utf8")).handoffId).toBe("existing-handoff");
      // No private temp is stranded in the directory.
      expect((await readdir(directory)).filter((name) => name.includes(".tmp"))).toHaveLength(0);
    } finally {
      await reader.close();
    }
  });

  it("fails EEXIST on an occupied symlink, never following into or replacing the target", async () => {
    const directory = await root();
    const target = join(directory, "target.json");
    const path = join(directory, "handoff.json");
    await writeFile(target, `${JSON.stringify(credential("target-handoff", "TARGET-KEEP-TOKEN"))}\n`, {
      mode: 0o600,
    });
    await symlink(target, path);
    const error = await rejection(path, credential("new-handoff", "NEW-SECRET-TOKEN"));
    expect(error.code).toBe("EEXIST");
    expect(`${String(error)}\n${error.stack ?? ""}`).not.toContain("NEW-SECRET-TOKEN");
    // The symlink itself and its target are both untouched: no clobber, no follow-through write.
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    const kept = JSON.parse(await readFile(target, "utf8")) as TerminalGatewayCredential;
    expect(kept).toMatchObject({ handoffId: "target-handoff", token: "TARGET-KEEP-TOKEN" });
    expect((await readdir(directory)).filter((name) => name.includes(".tmp"))).toHaveLength(0);
  });

  it("publishes the complete descriptor at mode 0600 on an absent path with no temp remnants", async () => {
    const directory = await root();
    const path = join(directory, "handoff.json");
    const expected = credential("fresh-handoff", "fresh-token");
    await writeTerminalGatewayCredential(path, expected);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(expected);
    expect((await readdir(directory)).filter((name) => name.includes(".tmp"))).toHaveLength(0);
  });
});
