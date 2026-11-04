import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { RESOURCE_HOLDER_RESET_ENV } from "@clankie/fleet-resources";
import { connectPrimeDaemon, type PrimeDaemonConnection } from "../src/captain/prime-daemon.ts";

// Optional native dependency: run explicitly with the verified Prime 0.10.x binary.
// The real supervisor/worker and execute_bash path run without a model or sign-in.
const executable = process.env.PRIME_RESOURCE_TEST_EXECUTABLE;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
it.skipIf(!executable)(
  "a newly started real Prime daemon and its worker clear inherited service holder identities",
  async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cl355-")));
    let daemon: PrimeDaemonConnection | undefined;
    let activeSessionId: string | undefined;
    try {
      const agentDir = join(root, "agent");
      const socketPath = join(root, "daemon.sock");
      await mkdir(agentDir);
      const script = join(root, "script.json");
      await writeFile(script, JSON.stringify({ responses: ["No model used"] }));
      for (const [key, value] of Object.entries({
        HOME: root,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"),
        ...Object.fromEntries(Object.keys(RESOURCE_HOLDER_RESET_ENV).map((key) => [key, "service-operator"])),
      }))
        vi.stubEnv(key, value);
      daemon = await connectPrimeDaemon({
        executable: executable!,
        launcher: executable!,
        version: "0.10.0",
        socketPath,
        agentDir,
        env: {
          PRIME_AGENT_CODING_AGENT_DIR: agentDir,
          PRIME_AGENT_DAEMON_SOCKET: socketPath,
          CODEX_THREAD_ID: "install-operator",
          CLANKIE_RESOURCE_HOLDER: "install-operator",
        },
      });
      const session = (await daemon.request({ type: "create", config: { cwd: root, script } })) as {
        activeSessionId: string;
      };
      activeSessionId = session.activeSessionId;
      const capture = join(root, "capture.mts");
      const keys = Object.keys(RESOURCE_HOLDER_RESET_ENV);
      await writeFile(
        capture,
        `
        import { readFile, writeFile } from "node:fs/promises";
        import { createResourceGovernor } from ${JSON.stringify(new URL("../../../packages/fleet-resources/src/index.ts", import.meta.url).href)};
        import { runHeavyCommand } from ${JSON.stringify(new URL("../../tui/src/command/heavy.ts", import.meta.url).href)};
        const governor = createResourceGovernor({directory:${JSON.stringify(join(root, "registry"))}});
        const release=${JSON.stringify(join(root, "release"))};
        const inherited=Object.fromEntries(${JSON.stringify(keys)}.map(key=>[key,process.env[key]]));
        try {
          const job=runHeavyCommand(["--",process.execPath,"-e","const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(process.argv[1]))clearInterval(timer)},20)",release],{governor});
          let leases=[];
          for(const deadline=Date.now()+10000; Date.now()<deadline;) {
            leases=(await governor.snapshot()).leases;
            if(leases.some(lease=>lease.state==="running"))break;
            await new Promise(resolve=>setTimeout(resolve,20));
          }
          const record=JSON.parse(await readFile(${JSON.stringify(join(root, "registry", "state.json"))},"utf8"));
          const ownerPid=record.leases[0]?.claimOwner.pid;
          await writeFile(release,"done");
          const exit=await job;
          console.log(JSON.stringify({inherited,leases,ownerPid,pid:process.pid,exit}));
        } finally { await governor.close(); }
      `,
      );
      const result = (await daemon.request({
        type: "execute_bash_and_wait",
        activeSessionId,
        command: `${quote(process.execPath)} --import ${quote(fileURLToPath(import.meta.resolve("tsx")))} ${quote(capture)}`,
      })) as { output: string; exitCode: number };
      expect(result.exitCode).toBe(0);
      const proof = JSON.parse(result.output.trim());
      expect(proof.inherited).toEqual(RESOURCE_HOLDER_RESET_ENV);
      expect(proof.exit).toBe(0);
      expect(proof.leases).toHaveLength(1);
      expect(proof.leases[0].holderId).toBeUndefined();
      expect(proof.ownerPid).toBe(proof.pid);
      // Reconnecting to this same sanitized daemon preserves the boundary.
      const reconnected = await connectPrimeDaemon({
        executable: executable!,
        launcher: executable!,
        version: "0.10.0",
        socketPath,
        agentDir,
        env: {},
      });
      try {
        expect(reconnected.hello.supervisorPid).toBe(daemon.hello.supervisorPid);
      } finally {
        reconnected.close();
      }
    } finally {
      try {
        if (activeSessionId) await daemon?.request({ type: "kill", activeSessionId });
      } finally {
        const pid = daemon?.hello.supervisorPid;
        daemon?.close();
        // Only the supervisor started on this test's private socket is ours.
        if (pid) process.kill(pid, "SIGTERM");
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);
