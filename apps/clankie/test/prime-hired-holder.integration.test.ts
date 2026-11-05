import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PreparedSeatLaunch } from "@clankie/agent-hosts";
import { expect, it, vi } from "vitest";
import { RESOURCE_HOLDER_RESET_ENV } from "@clankie/fleet-resources";
import { processIdentity } from "../../../packages/fleet-resources/src/process.ts";
import { connectPrimeDaemon, type PrimeDaemonConnection } from "../src/captain/prime-daemon.ts";
import { createPrimeSeatAdapter } from "../src/captain/prime-seat-adapter.ts";
import { createPrimeNativeHost } from "../src/captain/prime-native-host.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

const executable = process.env.PRIME_RESOURCE_TEST_EXECUTABLE;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
it.skipIf(!executable || process.platform !== "darwin").each(["worker", "pane"] as const)(
  "a hired real Prime worker owns its heavy permit and refuses after losing its %s identity",
  async (lost) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "cl355-hire-")));
    let daemon: PrimeDaemonConnection | undefined;
    let herdr: Awaited<ReturnType<typeof isolatedHerdr>> | undefined;
    let prepared: PreparedSeatLaunch | undefined;
    let activeSessionId: string | undefined;
    let supervisor: Awaited<ReturnType<typeof processIdentity>>;
    try {
      const bin = join(root, "bin");
      await mkdir(bin);
      // This proof never opens the installed worker bridge or reaches a live service.
      // Any session-scoped MCP child resolves to this empty fixture, never the service.
      const mcp = join(root, "empty-mcp.mjs");
      await writeFile(
        mcp,
        `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;
const result=q.method==='initialize'?{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'isolated-holder-proof',version:'1'}}:q.method==='tools/list'?{tools:[]}:{};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});`,
      );
      await writeFile(join(bin, "clankie"), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(mcp)}\n`, {
        mode: 0o700,
      });
      const env = {
        HOME: root,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"),
        XDG_RUNTIME_DIR: join(root, "runtime"),
        PRIME_AGENT_CODING_AGENT_DIR: join(root, "agent"),
        PRIME_AGENT_DAEMON_SOCKET: join(root, "daemon.sock"),
        PATH: `${bin}:${process.env.PATH}`,
        CLANKIE_CONTROL_PLANE_URL: "http://127.0.0.1:1",
        CLANKIE_STATE: join(root, "clankie-state"),
      };
      for (const [key, value] of Object.entries({
        ...env,
        ...Object.fromEntries(Object.keys(RESOURCE_HOLDER_RESET_ENV).map((key) => [key, "service-operator"])),
      }))
        vi.stubEnv(key, value);
      const install = {
        executable: executable!,
        launcher: executable!,
        version: "0.10.0",
        socketPath: env.PRIME_AGENT_DAEMON_SOCKET,
        agentDir: env.PRIME_AGENT_CODING_AGENT_DIR,
        env,
      };
      daemon = await connectPrimeDaemon(install);
      expect(daemon.hello.appVersion).toBe("0.10.0");
      expect(daemon.hello.supervisorPid).toBeGreaterThan(1);
      supervisor = await processIdentity(daemon.hello.supervisorPid!);
      expect(supervisor?.uid).toBe(process.getuid?.());
      herdr = await isolatedHerdr(join(root, "logs"));
      const binding = { runtime: "external" as const, session: "default", socketPath: herdr.socketPath };
      const native = createPrimeNativeHost({
        binding: async () => binding,
        processHelper: resolve("integrations/opencode-plugin/process-birth.py"),
      });
      const adapter = createPrimeSeatAdapter({
        repoRoot: resolve("."),
        stateDir: join(root, "controller"),
        native,
        install: async () => install,
      });
      prepared = await adapter.prepare!({ harness: "prime", cwd: root, brief: "" });
      const pane = await native.createCommandTab({
        cwd: root,
        label: "isolated Prime holder",
        command: prepared.command,
        env: { ...prepared.env, ...RESOURCE_HOLDER_RESET_ENV },
      });
      const result = await prepared.start({
        paneId: pane,
        run: async () => {
          throw Error("No terminal typing");
        },
      });
      expect(result, JSON.stringify(result)).toMatchObject({ outcome: "started" });
      if (result.outcome !== "started") throw Error("Native Prime seat did not start");
      const state = (await daemon.request({
        type: "get_state",
        activeSessionId: result.control.ref.sessionId,
      })) as { activeSessionId: string; workerPid: number };
      activeSessionId = state.activeSessionId;
      const faultCopies = [];
      for (const fault of ["absent", "unreadable"] as const) {
        const directory = join(root, fault);
        const source = resolve("packages/fleet-resources/src");
        await cp(source, join(directory, "src"), { recursive: true });
        await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
        await mkdir(join(directory, "node_modules"));
        await cp(
          await realpath(resolve("packages/fleet-resources/node_modules/zod")),
          join(directory, "node_modules/zod"),
          { recursive: true },
        );
        const helper = join(directory, "src/native.py");
        const original = await readFile(helper, "utf8");
        const marker = "def identity(pid, census=False):\n";
        expect(original.split(marker)).toHaveLength(2);
        // Only this private observer's read of the executing worker-side command
        // is denied. All other observations use the unchanged native observer.
        const denial =
          fault === "absent" ? "return None" : "raise RuntimeError('fixture identity unreadable')";
        await writeFile(
          helper,
          original.replace(
            marker,
            marker + `    if str(pid) == os.environ.get("PRIME_TEST_UNAVAILABLE_PID"): ${denial}\n`,
          ),
        );
        faultCopies.push({ fault, module: join(directory, "src/index.ts") });
      }
      const capture = join(root, "capture.mts");
      await writeFile(
        capture,
        `
import {readFile,writeFile} from 'node:fs/promises';
import {createResourceGovernor} from ${JSON.stringify(new URL("../../../packages/fleet-resources/src/index.ts", import.meta.url).href)};
import {runHeavyCommand} from ${JSON.stringify(new URL("../../tui/src/command/heavy.ts", import.meta.url).href)};
import {processIdentity} from ${JSON.stringify(new URL("../../../packages/fleet-resources/src/process.ts", import.meta.url).href)};
const governor=createResourceGovernor({directory:${JSON.stringify(join(root, "registry"))}});
const release=${JSON.stringify(join(root, "release"))};
try {
 const chain=[];for(let pid=process.pid;pid>1;){const row=await processIdentity(pid);if(!row)break;chain.push(row.pid);pid=row.ppid;}
 const inherited=Object.fromEntries(${JSON.stringify(Object.keys(RESOURCE_HOLDER_RESET_ENV))}.map(k=>[k,process.env[k]]));
 const job=runHeavyCommand(['--',process.execPath,'-e',"const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(process.argv[1]))clearInterval(timer)},20)",release],{governor});
 let leases=[];
 for(const deadline=Date.now()+10000;Date.now()<deadline;){leases=(await governor.snapshot()).leases;if(leases.some(l=>l.state==='running'))break;await new Promise(r=>setTimeout(r,20));}
 const registry=JSON.parse(await readFile(${JSON.stringify(join(root, "registry", "state.json"))},'utf8'));
 await writeFile(release,'done');
 const exit=await job;
 const refusals=[];
 process.env.PRIME_TEST_UNAVAILABLE_PID=String(process.pid);
 // Even copied labels cannot replace an unavailable native claimant identity.
 for(const [key,value] of Object.entries(${JSON.stringify(Object.fromEntries(Object.keys(RESOURCE_HOLDER_RESET_ENV).map((key) => [key, "copied-operator"])))}))process.env[key]=value;
 for(const copy of ${JSON.stringify(faultCopies)}){
  const {createResourceGovernor}=await import('file://'+copy.module);
  const directory=${JSON.stringify(root)}+'/refused-'+copy.fault;
  const denied=createResourceGovernor({directory});
  const marker=directory+'/command-ran';let error;
  try{await runHeavyCommand(['--',process.execPath,'-e',"require('node:fs').writeFileSync(process.argv[1],'ran')",marker],{governor:denied});}
  catch(e){error=e.message;}finally{await denied.close();}
  const state=await readFile(directory+'/state.json','utf8').then(JSON.parse, e=>{if(e.code==='ENOENT')return null;throw e;});
  const commandRan=await readFile(marker,'utf8').then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});
  refusals.push({fault:copy.fault,error,state,commandRan});
 }
 console.log(JSON.stringify({chain,pid:process.pid,inherited,exit,registry,leases,refusals}));
}finally{await governor.close();}
`,
      );
      const output = (await daemon.request({
        type: "execute_bash_and_wait",
        activeSessionId,
        command: `${quote(process.execPath)} --import ${quote(fileURLToPath(import.meta.resolve("tsx")))} ${quote(capture)}`,
      })) as { output: string; exitCode: number };
      expect(output.exitCode, output.output).toBe(0);
      const proof = JSON.parse(output.output.trim());
      expect(proof.inherited).toEqual(RESOURCE_HOLDER_RESET_ENV);
      expect(proof.chain).toContain(state.workerPid);
      expect(proof.exit).toBe(0);
      expect(proof.leases).toHaveLength(1);
      expect(proof.leases[0].holderId).toBeUndefined();
      expect(proof.registry.leases[0].claimOwner.pid).toBe(proof.pid);
      expect(proof.pid).not.toBe(daemon.hello.supervisorPid);
      expect(proof.refusals).toHaveLength(2);
      for (const refusal of proof.refusals) {
        expect(refusal.error).toBe(
          refusal.fault === "absent"
            ? "Fleet resource process identity unavailable"
            : "Fleet resource native observation failed",
        );
        expect(refusal.commandRan).toBe(false);
        for (const key of ["leases", "queue", "lightLeases", "lightQueue", "serverLeases", "serverQueue"])
          expect(refusal.state?.[key] ?? []).toEqual([]);
      }
      expect(await native.allows(proof.chain, pane, binding)).toBe(true);
      expect(await native.allows([daemon.hello.supervisorPid!], pane, binding)).toBe(false);
      if (lost === "pane") {
        await herdr.cli("pane", "close", pane);
        expect(
          ((await daemon.request({ type: "get_state", activeSessionId })) as { workerPid: number }).workerPid,
        ).toBe(state.workerPid);
      } else {
        await daemon.request({ type: "kill", activeSessionId });
        activeSessionId = undefined;
      }
      expect(await native.allows(proof.chain, pane, binding)).toBe(false);
      if (process.env.PRIME_HIRED_TEST_EVIDENCE)
        await writeFile(
          `${process.env.PRIME_HIRED_TEST_EVIDENCE}-${lost}.json`,
          JSON.stringify({ supervisorPid: daemon.hello.supervisorPid, worker: state, proof }, null, 2),
        );
    } finally {
      await prepared?.dispose();
      if (activeSessionId) await daemon?.request({ type: "kill", activeSessionId }).catch(() => {});
      daemon?.close();
      try {
        // Signal only this test's private supervisor, still at its recorded birth.
        if (supervisor && (await processIdentity(supervisor.pid))?.startTime === supervisor.startTime) {
          process.kill(supervisor.pid, "SIGTERM");
          await vi.waitFor(async () => expect(await processIdentity(supervisor!.pid)).toBeUndefined(), {
            timeout: 5_000,
          });
        }
      } finally {
        await herdr?.close();
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  90_000,
);
