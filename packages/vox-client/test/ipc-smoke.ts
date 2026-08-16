import { fileURLToPath } from "node:url";
import { createVoxClient, type VoxClient } from "../src/index.ts";

let client: VoxClient | undefined;
let timeout: ReturnType<typeof setTimeout> | undefined;
const requestedBin =
  process.argv[2] === "debug"
    ? fileURLToPath(
        new URL(
          `../../../apps/vox/target/debug/clankvox${process.platform === "win32" ? ".exe" : ""}`,
          import.meta.url,
        ),
      )
    : undefined;

try {
  await new Promise<void>((resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error("Vox did not emit process_ready within five seconds")),
      5_000,
    );
    client = createVoxClient({
      ...(requestedBin === undefined ? {} : { bin: requestedBin }),
      onStatus: (status) => {
        if (status === "ready") resolve();
      },
      onError: (message) => reject(new Error(message)),
    });
    if (!client.available) reject(new Error(client.detail));
  });
  const readyClient = client;
  if (readyClient === undefined) throw new Error("Vox client was not created");
  process.stdout.write(`Vox IPC ready: ${readyClient.detail}\n`);
} finally {
  if (timeout !== undefined) clearTimeout(timeout);
  client?.close();
}
