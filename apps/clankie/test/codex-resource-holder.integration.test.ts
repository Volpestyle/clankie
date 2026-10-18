import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { RESOURCE_HOLDER_RESET_ENV } from "@clankie/fleet-resources";
import { expect, it, vi } from "vitest";
import { startCodexAppServerSeat } from "../src/captain/codex-app-server.ts";
import { remoteCodexServer } from "../src/captain/remote-codex-app-server.ts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

it("shared Codex startup reaches the remote executable with host holder identities cleared", async () => {
  const root = await mkdtemp(join(tmpdir(), "cl2447-"));
  const bin = join(root, "bin");
  const receipt = join(root, "remote-environment.json");
  const exec = promisify(execFile);
  try {
    await mkdir(bin);
    const program = join(root, "capture.cjs");
    await writeFile(
      program,
      `require('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(process.env));`,
    );
    await writeFile(
      join(bin, "codex"),
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(program)} "$@"\n`,
      { mode: 0o700 },
    );
    const inherited = Object.fromEntries(
      Object.keys(RESOURCE_HOLDER_RESET_ENV).map((key) => [key, "host-operator"]),
    );
    const server = remoteCodexServer({
      fleet: { id: "fixture", session: "default", ssh: { host: "fixture.invalid", shell: "posix" } },
      // Execute the generated remote launch script against a real owned executable.
      // Stop after capture, before forwarding/RPC: the real PC hire is a deploy check.
      shell: async (command) => {
        await exec("/bin/sh", ["-c", command], {
          env: { ...process.env, ...inherited, HOME: root, PATH: `${bin}:${process.env.PATH}` },
        });
        for (let attempt = 0; attempt < 200; attempt++) {
          try {
            await readFile(receipt, "utf8");
            throw new Error("Remote environment captured before forwarding");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("Remote executable did not write its environment");
      },
    });
    await expect(
      startCodexAppServerSeat({
        cwd: root,
        server,
        startView: async () => {
          throw new Error("No native view in this process-boundary proof");
        },
      }),
    ).rejects.toThrow("Remote environment captured before forwarding");
    const environment = JSON.parse(await readFile(receipt, "utf8"));
    for (const [key, value] of Object.entries(RESOURCE_HOLDER_RESET_ENV))
      expect(environment[key]).toBe(value);
    // The host's ordinary environment still supplies the executable and home.
    expect(environment.HOME).toBe(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("a hired Codex server clears the service and requested operator holders before its worker acquires", async () => {
  const root = await mkdtemp(join(tmpdir(), "cl2336-"));
  const bin = join(root, "bin");
  const program = join(root, "codex-fixture.mjs");
  const receipt = join(root, "holder-proof.json");
  const release = join(root, "heavy-release");
  const threadId = "hired-server-thread";
  let seat: Awaited<ReturnType<typeof startCodexAppServerSeat>> | undefined;
  try {
    await mkdir(bin);
    await writeFile(
      program,
      `
      import { writeFile } from "node:fs/promises";
      import { createResourceGovernor } from ${JSON.stringify(new URL("../../../packages/fleet-resources/src/index.ts", import.meta.url).href)};
      import { runHeavyCommand } from ${JSON.stringify(new URL("../../tui/src/command/heavy.ts", import.meta.url).href)};
      import { codex0160Protocol } from ${JSON.stringify(new URL("./fixtures/codex-0160-protocol.ts", import.meta.url).href)};
      const inherited = Object.fromEntries(["CLANKIE_RESOURCE_HOLDER", "CODEX_THREAD_ID", "CLAUDE_SESSION_ID", "CLAUDE_AGENT_ID"].map(k => [k, process.env[k]]));
      // The owned executable supplies native invocation metadata, not a model.
      process.env.CODEX_THREAD_ID = ${JSON.stringify(threadId)};
      const governor = createResourceGovernor({directory: ${JSON.stringify(join(root, "registry"))}, probe: async () => ({loadRatio: 0, availableMemoryMb: 1000000})});
      let protocol;
      process.once("SIGTERM", () => void (async () => { await governor.close(); await protocol?.close(); process.exit(0); })());
      const job = runHeavyCommand(["--", process.execPath, "-e", ${JSON.stringify("const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(process.argv[1]))clearInterval(timer)},20)")}, ${JSON.stringify(release)}], {governor});
      let leases = [];
      while (!leases.some(lease => lease.state === "running")) {
        leases = (await governor.snapshot()).leases;
        if (!leases.some(lease => lease.state === "running")) await new Promise(r => setTimeout(r,20));
      }
      await writeFile(${JSON.stringify(receipt)}, JSON.stringify({pid:process.pid, inherited, leases}));
      await writeFile(${JSON.stringify(release)}, "done");
      if (await job !== 0) throw new Error("Owned heavy child failed");
      await governor.close();
      const endpoint = process.argv[process.argv.indexOf("--listen") + 1];
      protocol = await codex0160Protocol(${JSON.stringify(root)}, {socketPath:endpoint.slice(7), threadId:${JSON.stringify(threadId)}});
      protocol.turns.push({id:"owned-completed-turn",status:"completed",items:[]});
      protocol.startView();
    `,
    );
    await writeFile(
      join(bin, "codex"),
      `#!/bin/sh\nexec ${quote(process.execPath)} --import ${quote(fileURLToPath(import.meta.resolve("tsx")))} ${quote(program)} "$@"\n`,
      { mode: 0o700 },
    );
    vi.stubEnv("CLANKIE_RESOURCE_HOLDER", "claude:service-operator");
    vi.stubEnv("CODEX_THREAD_ID", "service-thread");
    seat = await startCodexAppServerSeat({
      cwd: root,
      resumeThreadId: threadId,
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: root,
        CODEX_HOME: join(root, "codex-home"),
        CLANKIE_STATE: join(root, "state"),
        CLANKIE_RESOURCE_HOLDER: "claude:requested-operator",
        CODEX_THREAD_ID: "requested-thread",
        CLAUDE_SESSION_ID: "requested-operator",
        CLAUDE_AGENT_ID: "requested-agent",
      },
      startView: async () => {},
    });
    expect(seat.threadId).toBe(threadId);
    const proof = JSON.parse(await readFile(receipt, "utf8"));
    expect(proof.inherited).toEqual({
      CLANKIE_RESOURCE_HOLDER: "",
      CODEX_THREAD_ID: "",
      CLAUDE_SESSION_ID: "",
      CLAUDE_AGENT_ID: "",
    });
    expect(proof.leases).toHaveLength(1);
    expect(proof.leases[0]).toMatchObject({
      holderId: `codex:${threadId}`,
      state: "running",
      pid: expect.any(Number),
    });
    if (process.env.VUH2336_EVIDENCE)
      await writeFile(
        join(process.env.VUH2336_EVIDENCE, "codex-server-holder-lease.json"),
        JSON.stringify(proof, null, 2),
      );
  } finally {
    await seat?.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
