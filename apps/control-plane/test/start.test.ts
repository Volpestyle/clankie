import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { describe, expect, it } from "vitest";

const appRoot = resolve(import.meta.dirname, "..");

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing test server address");
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
  return address.port;
}

async function waitForListening(child: ChildProcess, output: () => string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const timeout = setTimeout(() => reject(new Error(`control plane did not start:\n${output()}`)), 10_000);
    const onData = () => {
      if (!output().includes('"msg":"control plane listening"')) return;
      clearTimeout(timeout);
      resolvePromise();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`control plane exited ${String(code)} before listening:\n${output()}`));
    });
  });
}

describe("control-plane entrypoint", () => {
  it("loads the repository doctrine when started from the package directory", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "clankie-control-plane-start-"));
    const port = await availablePort();
    let output = "";
    const child = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
      cwd: appRoot,
      env: {
        ...process.env,
        PORT: String(port),
        CLANKIE_EVENT_STORE: join(stateRoot, "events.db"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => (output += String(chunk)));
    child.stderr?.on("data", (chunk) => (output += String(chunk)));

    try {
      await waitForListening(child, () => output);
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        doctrine: "self-build-lab",
      });
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
      await rm(stateRoot, { recursive: true, force: true });
    }
  });
});
