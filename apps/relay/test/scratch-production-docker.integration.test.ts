import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { ownProcess } from "../../../scripts/testing/owned-process.ts";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));

// Manual only: a real Linux network namespace proves canonical ports without
// opening or contacting either port on the owner's Mac.
it.skipIf(process.env.VUH_1996_DOCKER_PROOF !== "1")(
  "boots custom-state production service and relay on 4310/4321 without the scratch flag (VUH-1996)",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "scratch-production-"));
    let container: string | undefined;
    let stop: (() => Promise<void>) | undefined;
    try {
      const image = process.env.VUH_1996_DOCKER_IMAGE ?? "clankie-hosted:local";
      await exec("docker", ["image", "inspect", image], { timeout: 10_000 });
      await exec(
        "pnpm",
        [
          "exec",
          "esbuild",
          "apps/clankie/src/index.ts",
          "apps/relay/src/index.ts",
          "--bundle",
          "--platform=node",
          "--format=esm",
          "--target=node24",
          "--outbase=.",
          `--outdir=${directory}`,
          ...[
            "@browser_use/pi",
            "mineflayer",
            "mineflayer-pathfinder",
            "minecraft-data",
            "prismarine-viewer",
            "playwright-core",
            "express",
            "socket.io",
            "vec3",
          ].map((name) => `--external:${name}`),
          '--banner:js=import { createRequire as __clankieCreateRequire } from "node:module"; const require = __clankieCreateRequire(import.meta.url);',
        ],
        { cwd: root, maxBuffer: 1024 * 1024, timeout: 30_000 },
      );
      const settings = join(directory, "settings.json");
      await writeFile(
        settings,
        JSON.stringify({
          schemaVersion: 1,
          herdr: { runtime: "disabled" },
          captain: { workingDirectory: "/workspace" },
        }),
      );
      const cidfile = join(directory, "container-id");
      const child = spawn(
        "docker",
        [
          "run",
          "--cidfile",
          cidfile,
          "--rm",
          "--init",
          "--network",
          "none",
          "--entrypoint",
          "node",
          "--env",
          "CLANKIE_STATE=/state/runtime",
          "--env",
          "NODE_ENV=development",
          "--env",
          "CLANKIE_OPERATOR_TOKEN=production-regression-operator",
          "--env",
          "CLANKIE_CAPTAIN_TOKEN=production-regression-captain",
          "--env",
          "CLANKIE_SETTINGS_FILE=/state/config/scratch-production-settings.json",
          "--env",
          "CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE=/opt/clankie/apps/discord-bridge/src/presence-runtime-module.js",
          "--env",
          "CLANKIE_DISCORD_USER_PRESENCE_RUNTIME_MODULE=/opt/clankie/apps/discord-user-session/src/presence-runtime-module.js",
          "--mount",
          `type=bind,src=${settings},dst=/state/config/scratch-production-settings.json,readonly`,
          ...["clankie", "relay"].flatMap((service) => [
            "--mount",
            `type=bind,src=${join(directory, `apps/${service}/src/index.js`)},dst=/opt/clankie/apps/${service}/src/index.js,readonly`,
          ]),
          image,
          "/opt/clankie/apps/clankie/src/index.js",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      stop = ownProcess(child, 10_000);
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        output += String(chunk);
      });
      const createdDeadline = Date.now() + 10_000;
      while (Date.now() < createdDeadline && !container) {
        if (child.exitCode !== null) throw new Error(`Production container exited: ${output}`);
        container = await readFile(cidfile, "utf8").then(
          (value) => value.trim(),
          () => undefined,
        );
        if (!container) await new Promise((done) => setTimeout(done, 100));
      }
      if (!container) throw new Error(`Production container was not created: ${output}`);
      const waitFor = async (port: number) => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          if (child.exitCode !== null) throw new Error(`Production container exited: ${output}`);
          const response = await exec(
            "docker",
            [
              "exec",
              container!,
              "node",
              "-e",
              `fetch('http://127.0.0.1:${port}/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))`,
            ],
            { timeout: 5_000 },
          ).then(
            () => true,
            () => false,
          );
          if (response) return;
          await new Promise((done) => setTimeout(done, 100));
        }
        throw new Error(`Production port ${port} unavailable: ${output}`);
      };
      await waitFor(4310);
      await exec("docker", ["exec", "--detach", container, "node", "/opt/clankie/apps/relay/src/index.js"]);
      await waitFor(4321);
      const configuration = JSON.parse((await exec("docker", ["inspect", container])).stdout) as Array<{
        HostConfig: { NetworkMode: string };
        Config: { Env: string[] };
      }>;
      expect(configuration[0]?.HostConfig.NetworkMode).toBe("none");
      expect(configuration[0]?.Config.Env).not.toContain("CLANKIE_SCRATCH=1");
      console.log(
        "Production regression: current service + relay healthy on container-only 4310/4321, custom /state/runtime, NODE_ENV=development, no scratch flag or host port publication.",
      );
    } finally {
      try {
        if (container)
          await exec("docker", ["rm", "--force", container], { timeout: 10_000 }).catch(
            (error: { stderr: string }) => {
              if (!error.stderr.includes("No such container")) throw error;
            },
          );
      } finally {
        if (stop) await stop();
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
  120_000,
);
