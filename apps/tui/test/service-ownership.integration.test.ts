import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { stopService } from "../bin/service-supervisor.ts";
import { managedService } from "../bin/services.ts";

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.once("exit", () => resolve());
          child.kill("SIGKILL");
        }),
    ),
  );
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function directory(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

/** A process the launcher's command match recognises as the Discord bridge. */
async function lookAlike(root: string, shape: "release" | "workspace"): Promise<ChildProcess> {
  let child: ChildProcess;
  if (shape === "release") {
    mkdirSync(join(root, "libexec"), { recursive: true });
    symlinkSync(process.execPath, join(root, "libexec/node"));
    mkdirSync(join(root, "apps/discord-bridge/src"), { recursive: true });
    writeFileSync(join(root, "apps/discord-bridge/src/index.js"), "setInterval(() => {}, 1000);\n");
    child = spawn(join(root, "libexec/node"), [join(root, "apps/discord-bridge/src/index.js")], {
      cwd: root,
      stdio: "ignore",
    });
  } else {
    child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", "--", "--filter", "@clankie/discord-bridge", "start"],
      { cwd: root, stdio: "ignore" },
    );
  }
  children.push(child);
  await new Promise<void>((resolve) => child.once("spawn", resolve));
  return child;
}

it("another runtime's look-alike services never block this runtime's stop (VUH-2293)", async () => {
  const runtime = directory("clankie-ownership-runtime-");
  const env = { ...process.env, CLANKIE_STATE_HOME: join(runtime, "state") };
  // Test fixtures and other checkouts on the same Mac, as during the 2026-10-15 deploy.
  await lookAlike(directory("clankie-ownership-fixture-"), "release");
  await lookAlike(directory("clankie-ownership-checkout-"), "workspace");
  await expect(stopService(managedService("discord-bridge"), { repoRoot: runtime, env })).resolves.toEqual({
    stopped: true,
  });

  // An unrecorded bridge in this runtime still blocks: the launcher never signals what it did not start.
  const own = await lookAlike(runtime, "workspace");
  await expect(stopService(managedService("discord-bridge"), { repoRoot: runtime, env })).rejects.toThrow(
    "Discord bridge is running but was not started by the clankie launcher",
  );
  own.kill("SIGKILL");
  await new Promise<void>((resolve) => own.once("exit", () => resolve()));
  await lookAlike(runtime, "release");
  await expect(stopService(managedService("discord-bridge"), { repoRoot: runtime, env })).rejects.toThrow(
    "Discord bridge is running but was not started by the clankie launcher",
  );
});
