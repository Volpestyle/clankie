import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";
import { expect, it } from "vitest";

// Manual-only: real Linux kernels and native TUIs, no accounts or model turns.
// The README records the immutable images and owned native Pi installation.
const dockerIt = it.skipIf(process.env.LINUX_FLEET_DOCKER_TEST !== "1");
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = join(root, ".local/linux-journey");
const logs = join(root, ".local/linux-native-fleet-logs");
const prepare =
  "const {buildFleetProof}=await import('/proof-source/scripts/build-fleet-proof.mjs'); process.env.PROOF_HELPER=await buildFleetProof('/tmp/native-process-proof');";

async function docker(arch: string, program: string, host = true) {
  const args = [
    "run",
    "--rm",
    "--init",
    "--pull",
    "never",
    "--platform",
    `linux/${arch === "x64" ? "amd64" : "arm64"}`,
    ...(host ? ["--pid", "host"] : []),
    "--network",
    "none",
    "--cpus",
    "2",
    "--memory",
    "2048m",
    "--pids-limit",
    "256",
    "--user",
    "65534:65534",
    "--security-opt",
    "seccomp=unconfined",
    "--security-opt",
    "systempaths=unconfined",
    "--env",
    `PATH=/clankie/dist/hosted/libexec:/proof-owned/pi-${arch}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin`,
    "--env",
    "PROOF_HERDR=/clankie/dist/hosted/libexec/herdr",
    "--env",
    `PROOF_PI=/proof-owned/pi-${arch}/node_modules/.bin/pi`,
    "--env",
    "PROOF_EXTENSION=/proof-owned/linux-journey/pi-extension.js",
    "--env",
    "PROOF_FLEET_BRIDGE=/proof-source/integrations/claude-plugin/worker/bin/fleet-mcp.mjs",
    "--mount",
    `type=bind,src=${join(root, ".local")},dst=/proof-owned,readonly`,
    "--mount",
    `type=bind,src=${join(root, "scripts")},dst=/proof-source/scripts,readonly`,
    "--mount",
    `type=bind,src=${join(root, "integrations")},dst=/proof-source/integrations,readonly`,
    "--entrypoint",
    "/clankie/dist/hosted/libexec/node",
    `clankie-vuh1823-build:${arch}`,
    "--input-type=module",
    "-e",
    prepare + program,
  ];
  await mkdir(logs, { recursive: true });
  const result = await exec("docker", args, { timeout: 90_000, maxBuffer: 2_000_000 });
  await writeFile(
    join(
      logs,
      `${arch}-${host ? "host" : "container"}-${program.includes("journey.js") ? "native" : "kernel"}.log`,
    ),
    result.stdout + result.stderr,
  );
  return result;
}

for (const arch of ["arm64", "x64"]) {
  dockerIt(
    `proves real ${arch} kernel boundaries using the prepared release helper`,
    async () => {
      const result = await docker(
        arch,
        "const {execFileSync}=await import('node:child_process'); execFileSync('/usr/bin/python3',['-I','-B','/proof-source/integrations/fleet-proof/test/linux-proof.py',process.env.PROOF_HELPER],{stdio:'inherit'});",
      );
      expect(result.stderr).toContain("OK (skipped=1)");
      expect(result.stderr).toContain("test_private_thread_fd_table_cannot_hide_second_owner");
    },
    120_000,
  );

  dockerIt(
    `admits a real ${arch} native Pi TUI for tools and retained reports`,
    async () => {
      await mkdir(output, { recursive: true });
      await build({
        entryPoints: [
          join(root, "apps/clankie/test/fixtures/linux-native-fleet/journey.ts"),
          join(root, "apps/clankie/test/fixtures/linux-native-fleet/pi-extension.mjs"),
        ],
        bundle: true,
        platform: "node",
        format: "esm",
        outdir: output,
        external: ["sharp"],
        banner: {
          js: "import { createRequire as proofCreateRequire } from 'node:module'; const require = proofCreateRequire(import.meta.url);",
        },
      });
      const result = await docker(arch, "await import('/proof-owned/linux-journey/journey.js');");
      const observed = JSON.parse(result.stdout);
      expect(observed.native.mode).toBe("tui");
      expect(observed.reads).toBe(1);
      expect(observed.retainedReports).toBe(1);
      expect(observed.outsiderStatus).toBe(403);
      expect(observed.revokedStatus).toBe(403);
      expect(observed.native.session).toBeTruthy();
    },
    120_000,
  );
}

dockerIt("refuses a real non-initial PID namespace with a clear fixed reason", async () => {
  const result = await docker(
    "arm64",
    "const {spawnSync}=await import('node:child_process'); const result=spawnSync(process.env.PROOF_HELPER,['--birth',String(process.pid),'--diagnostics'],{encoding:'utf8'}); console.log(JSON.stringify(result));",
    false,
  );
  const refused = JSON.parse(result.stdout);
  expect(refused.status).toBe(1);
  expect(refused.stdout).toBe("");
  expect(refused.stderr).toContain('"reason":"unsupported_pid_namespace"');
  expect(refused.stderr).toContain("containers are unsupported");
});

dockerIt(
  "proves the real native Codex Unix listener and refuses changed recovery claims",
  async () => {
    const { stdout } = await exec(
      "docker",
      [
        "run",
        "--rm",
        "--init",
        "--pull",
        "never",
        "--pid",
        "host",
        "--network",
        "none",
        "--cpus",
        "2",
        "--memory",
        "512m",
        "--pids-limit",
        "128",
        "--user",
        "65534:65534",
        "--security-opt",
        "seccomp=unconfined",
        "--security-opt",
        "systempaths=unconfined",
        "--mount",
        `type=bind,src=${join(root, "integrations/fleet-proof")},dst=/proof-source,readonly`,
        "--entrypoint",
        "/usr/bin/python3",
        "clankie-runtime:ac45d633e5ed",
        "-I",
        "-B",
        "/proof-source/test/linux-codex-proof.py",
        "/proof-source/linux-process-proof.py",
      ],
      { timeout: 30_000, maxBuffer: 1_000_000 },
    );
    await mkdir(logs, { recursive: true });
    await writeFile(join(logs, "arm64-host-codex.log"), stdout);
    expect(JSON.parse(stdout).birthAndListener).toBe("passed");
  },
  40_000,
);
