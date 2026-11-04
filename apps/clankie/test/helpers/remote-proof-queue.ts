import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { RemoteFleetRelay } from "../../src/remote-fleet-relay.ts";
import { createRemoteProjectObserver } from "../../src/remote-project-proof.ts";

type Timing = { id: number; kind: string; load?: string; run: number; queueMs: number; executionMs: number };

/** Real child, nonce-bound loopback relay and controller; only Windows execution is a fixture. */
export async function queuedProofFixture(repeatMs = 0, proofMs = 0) {
  const response = createServer();
  await new Promise<void>((resolve) => response.listen(0, "127.0.0.1", resolve));
  const address = response.address();
  if (!address || typeof address === "string") throw Error("Missing fixture return listener");
  const started = performance.now();
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../fixtures/serial-remote-observer.mjs", import.meta.url)),
      String(address.port),
      fileURLToPath(new URL("../fixtures/pc-native-goldens/pc-sender-probe.json", import.meta.url)),
      String(repeatMs),
      String(proofMs),
    ],
    { stdio: ["pipe", "pipe", "pipe", "ipc"] },
  );
  const timings: Timing[] = [];
  child.on("message", (value) => timings.push(value as Timing));
  let relay!: RemoteFleetRelay;
  let stderr = "",
    closed = false;
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-4000);
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    const exit =
      child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "exit");
    relay?.close();
    if (!relay) child.kill();
    await exit;
    await new Promise<void>((resolve) => response.close(() => resolve()));
  };
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(Error(`Fixture exited before relay readiness: ${stderr}`)));
      relay = new RemoteFleetRelay({ child, localPort: 9, responseServer: response, ready: () => resolve() });
    });
  } catch (error) {
    await close();
    throw error;
  }
  const setupMs = performance.now() - started;
  const fleet = {
    id: "fixture",
    session: "default",
    ssh: { host: "unused.invalid", shell: "powershell" as const },
  };
  const observe = createRemoteProjectObserver({
    fleet: async () => fleet,
    shell: () => relay.execute.bind(relay),
  });
  const proofReceipt = () =>
    new Promise<Timing>((resolve, reject) => {
      const completed = timings.find((event) => event.kind === "proof");
      if (completed) {
        resolve(completed);
        return;
      }
      const exit = () => {
        child.off("message", message);
        reject(Error("Fixture exited before proof receipt"));
      };
      const message = (value: unknown) => {
        const timing = value as Timing;
        if (timing.kind === "proof") {
          child.off("message", message);
          child.off("exit", exit);
          resolve(timing);
        }
      };
      child.on("message", message);
      child.once("exit", exit);
    });
  return { relay, child, timings, setupMs, proofReceipt, observe: () => observe(fleet.id, "wE:p2"), close };
}
