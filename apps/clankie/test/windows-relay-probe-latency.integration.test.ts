import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { expect, test } from "vitest";
import { linkSshArgs } from "../src/fleet-link.ts";
import { createHerdrFleetRun } from "../src/herdr-fleet.ts";
import { RemoteFleetRelay } from "../src/remote-fleet-relay.ts";
import { windowsFleetRelayLaunch } from "../src/windows-fleet-relay.ts";
import { windowsProcessCommand } from "../src/windows-process-probe.ts";

// Manual, read-only: starts a private resident relay on an explicitly supplied
// Windows SSH host and runs real proof and census observations through it. It
// publishes no link file, so no pane can connect to it; it creates no pane or file.
const host = process.env.WINDOWS_RELAY_PROOF_HOST;
const pane = process.env.WINDOWS_RELAY_PROOF_PANE ?? "w1:p1";

test.skipIf(!host)(
  "every fresh proof stays fast in the resident relay, not only a repeated one",
  async () => {
    const fleet = { id: "proof", session: "default", ssh: { host: host!, shell: "powershell" as const } };
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const link = spawn("ssh", linkSshArgs(fleet, (server.address() as { port: number }).port), {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let relay: RemoteFleetRelay | undefined;
    try {
      let stderr = "";
      const forwarded = await new Promise<number>((resolve, reject) => {
        link.stderr.setEncoding("utf8");
        link.stderr.on("data", (chunk: string) => {
          stderr += chunk;
          const allocated = /Allocated port (\d+) for remote forward/u.exec(stderr);
          if (allocated) resolve(Number(allocated[1]));
        });
        link.once("exit", () => reject(new Error("SSH link exited")));
      });
      const launch = windowsFleetRelayLaunch(forwarded);
      const child = spawn("ssh", ["-T", "-o", "BatchMode=yes", "--", host!, launch.command], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdin.write(launch.stdin);
      child.stderr.resume();
      await new Promise<number>((ready) => {
        relay = new RemoteFleetRelay({ child, localPort: 9, ready, responseServer: server });
      });
      const durations: number[] = [];
      // Each relayed stream has its own tuple, so live proofs are new script text almost every call.
      for (let i = 0; i < 5; i++) {
        const started = performance.now();
        const output = await relay!.execute(
          windowsProcessCommand({
            session: fleet.session,
            pane,
            codexControl: true,
            clientPort: 40_000 + i,
            serverPort: 50_000 + i,
          }),
          20_000,
        );
        durations.push(performance.now() - started);
        expect(JSON.parse(output)).toHaveProperty("first");
      }
      const census = createHerdrFleetRun(fleet, {
        observer: () => (command: string, timeoutMs: number) => relay!.execute(command, timeoutMs),
      } as never);
      expect(JSON.parse(await census(["pane", "list"]))).toHaveProperty("result");
      // The first run compiles the native helper type once; later fresh proofs must not pay seconds each.
      expect(Math.max(...durations.slice(1))).toBeLessThan(1_500);
    } finally {
      relay?.close();
      link.kill();
      server.close();
    }
  },
  120_000,
);
