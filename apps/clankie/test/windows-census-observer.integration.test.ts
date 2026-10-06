import { spawn, type ChildProcess, type execFile } from "node:child_process";
import { createServer, type Socket } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { linkSshArgs } from "../src/fleet-link.ts";
import {
  createHerdrFleetRun,
  powershellScriptCommand,
  SSH_BASE_OPTIONS,
  type HerdrFleet,
} from "../src/herdr-fleet.ts";
import { RemoteFleetRelay } from "../src/remote-fleet-relay.ts";
import { windowsFleetRelayCommand } from "../src/windows-fleet-relay.ts";

// Manual only: uses the caller's authenticated SSH destination and installed
// Windows PowerShell/Herdr. It starts its own relay, publishes no link file,
// and reads an already-running Herdr session without changing any pane.
test.skipIf(!process.env.WINDOWS_CENSUS_HOST)(
  "real Windows resident relay preserves framing across native census reads and a CLI failure",
  async () => {
    const fleet: HerdrFleet = {
      id: "owned-windows-observer",
      session: process.env.WINDOWS_CENSUS_SESSION ?? "default",
      ssh: { host: process.env.WINDOWS_CENSUS_HOST!, shell: "powershell" },
    };
    const root = await mkdtemp(join(tmpdir(), "clankie-windows-observer-"));
    const children: ChildProcess[] = [];
    const sockets = new Set<Socket>();
    const responseServer = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    let relay: RemoteFleetRelay | undefined;
    const observations: { command: string; bytes: number; elapsedMs: number }[] = [];
    let sshFallbacks = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        responseServer.once("error", reject);
        responseServer.listen({ host: "127.0.0.1", port: 0 }, resolve);
      });
      const address = responseServer.address();
      if (typeof address !== "object" || !address) throw new Error("Missing response listener");
      const forward = spawn("ssh", linkSshArgs(fleet, address.port), { stdio: "pipe" });
      children.push(forward);
      const remoteReturnPort = await new Promise<number>((resolve, reject) => {
        let stderr = "";
        const timer = setTimeout(() => reject(new Error("Owned reverse forward not ready")), 20_000);
        const finish = (error?: Error, port?: number) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve(port!);
        };
        forward.once("error", (error) => finish(error));
        forward.once("exit", () => finish(new Error("Owned reverse forward exited")));
        forward.stderr!.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-4_096);
          const port = /Allocated port (\d+) for remote forward/u.exec(stderr)?.[1];
          if (port) finish(undefined, Number(port));
        });
      });
      const child = spawn(
        "ssh",
        [
          ...SSH_BASE_OPTIONS,
          "-o",
          "ControlMaster=no",
          "-o",
          "ControlPath=none",
          "--",
          fleet.ssh.host,
          windowsFleetRelayCommand(remoteReturnPort),
        ],
        { stdio: "pipe" },
      );
      children.push(child);
      let stderr = "";
      child.stderr!.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4_096);
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Owned Windows relay not ready: ${stderr}`)), 20_000);
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error(`Owned Windows relay exited before ready: ${stderr}`));
        });
        relay = new RemoteFleetRelay({
          child,
          localPort: address.port,
          responseServer,
          ready: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
      const options = {
        controlDirectory: root,
        execFile: (() => {
          sshFallbacks += 1;
          throw new Error("A resident observation must not fall back to SSH");
        }) as unknown as typeof execFile,
        observer: () => relay!.execute.bind(relay),
      };
      const run = createHerdrFleetRun(fleet, options);
      for (const args of [
        ["api", "snapshot"],
        ["agent", "list"],
        ["pane", "list"],
        ["api", "snapshot"],
      ]) {
        const start = performance.now();
        const output = await run(args);
        const parsed = JSON.parse(output);
        if (args[0] === "api") {
          expect(Array.isArray(parsed.result?.snapshot?.agents)).toBe(true);
          expect(typeof parsed.result?.snapshot?.workspaces).toBe("object");
        } else expect(Array.isArray(parsed.result?.[args[0] === "agent" ? "agents" : "panes"])).toBe(true);
        observations.push({
          command: args.join(" "),
          bytes: Buffer.byteLength(output),
          elapsedMs: performance.now() - start,
        });
        expect(relay!.alive()).toBe(true);
      }
      const missing = createHerdrFleetRun({ ...fleet, session: `kai-missing-${randomUUID()}` }, options);
      // The installed CLI writes this failure outside its JSON stdout. The
      // observer returns a fixed failure envelope rather than forwarding it.
      await expect(missing(["api", "snapshot"])).rejects.toMatchObject({ code: "fleet_command_failed" });
      expect(relay!.alive()).toBe(true);
      expect(JSON.parse(await run(["api", "snapshot"])).result.snapshot.agents).toBeInstanceOf(Array);
      expect(await relay!.execute(powershellScriptCommand("'証明 ✓'"))).toBe("証明 ✓");
      expect(relay!.alive()).toBe(true);
      expect(sshFallbacks).toBe(0);
      const result = {
        schemaVersion: 1,
        at: new Date().toISOString(),
        transport: "real SSH reverse forward and owned Windows PowerShell/C# resident relay",
        nativeCommands: "installed Herdr, existing session, read-only",
        observations,
        missingSession: "fleet_command_failed; next snapshot succeeded",
        unicode: "証明 ✓",
        relayAlive: relay!.alive(),
        sshFallbacks,
        linksPublished: 0,
        panesChanged: 0,
      };
      if (process.env.WINDOWS_CENSUS_EVIDENCE)
        await writeFile(process.env.WINDOWS_CENSUS_EVIDENCE, `${JSON.stringify(result, null, 2)}\n`);
      console.log(JSON.stringify(result));
    } finally {
      relay?.close();
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve) => {
              if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null)
                return resolve();
              const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
              child.once("exit", () => {
                clearTimeout(timer);
                resolve();
              });
              child.kill();
            }),
        ),
      );
      await new Promise<void>((resolve) => responseServer.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  90_000,
);
