import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createLocalAgentHost, createSshAgentHost, type AgentTurnInput } from "../src/index.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const sessionId = "10000000-0000-4000-8000-000000000001";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "agent-turn-test-"));
  roots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  const file = join(root, "harness.mjs");
  await writeFile(
    file,
    `import {readFileSync} from 'node:fs';
const [harness,...args]=process.argv.slice(2);
let input='';for await(const part of process.stdin)input+=part;
if(harness==='grok')input=readFileSync(args[args.indexOf('--prompt-file')+1],'utf8');
if(input==='wait'){console.log('READY');setInterval(()=>{},1000);}
else if(input==='large'){process.stdout.write('x'.repeat(2*1024*1024)+'FINAL_OUTPUT');}
else console.log(JSON.stringify({harness,args,input,cwd:process.cwd()}));`,
  );
  for (const harness of ["claude", "codex", "grok", "pi"])
    await writeFile(
      join(bin, harness),
      `#!/bin/sh\nexec '${process.execPath}' '${file}' '${harness}' "$@"\n`,
      { mode: 0o700 },
    );
  const input: AgentTurnInput = {
    harness: "claude",
    sessionId,
    cwd: root,
    message: '--unsafe "quotes" $(touch escaped) `backticks`\nUnicode 😀',
  };
  return { root, bin, file, input };
}

test("local resumes each harness with exact argv and literal stdin/file message", async () => {
  const f = await fixture();
  const launch = ((command: string, args: string[], options: Parameters<typeof spawn>[2]) =>
    spawn(process.execPath, [f.file, command, ...args], options)) as typeof spawn;
  const host = createLocalAgentHost({ spawn: launch });
  for (const harness of ["claude", "codex", "grok", "pi"] as const) {
    const result = await host.runAgentTurn({ ...f.input, harness });
    expect(result.exitCode).toBe(0);
    expect(result.termination).toBeUndefined();
    const output = JSON.parse(result.stdout);
    expect(output.input).toBe(f.input.message);
    expect(output.cwd).toBe(await realpath(f.root));
    expect(output.args).toContain(sessionId);
    expect(output.args).not.toContain(f.input.message);
    expect(output.args.join(" ")).not.toMatch(/bypass|skip-permissions|approve/);
  }
});

test("local timeout and cancellation terminate owned processes and output is bounded", async () => {
  const f = await fixture();
  const launch = ((command: string, args: string[], options: Parameters<typeof spawn>[2]) =>
    spawn(process.execPath, [f.file, command, ...args], options)) as typeof spawn;
  const host = createLocalAgentHost({ spawn: launch, timeoutMs: 100 });
  expect((await host.runAgentTurn({ ...f.input, message: "wait" })).termination).toBe("timeout");
  const abort = new AbortController();
  abort.abort();
  expect((await host.runAgentTurn(f.input, abort.signal)).termination).toBe("aborted");
  const normal = createLocalAgentHost({ spawn: launch });
  const large = await normal.runAgentTurn({ ...f.input, message: "large" });
  expect(large.stdout.length).toBeLessThan(1024 * 1024 + 100);
  expect(large.stdout).toContain("truncated");
  expect(large.stdout).toContain("FINAL_OUTPUT");
});

test("POSIX SSH runner passes literal messages and acknowledges remote cancellation", async () => {
  const f = await fixture();
  let cancel: AbortController | undefined;
  const launch = ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    expect(command).toBe("ssh");
    const child = spawn("sh", ["-c", args.at(-1)!], {
      ...options,
      env: { ...options?.env, PATH: `${f.bin}:${process.env.PATH}`, TMPDIR: f.root },
    });
    child.stdout?.on("data", (chunk) => {
      if (String(chunk).includes("READY")) cancel?.abort();
    });
    return child;
  }) as typeof spawn;
  const host = createSshAgentHost({ id: "linux", ssh: "test", shell: "posix" }, { spawn: launch });
  const result = await host.runAgentTurn(f.input);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).input).toBe(f.input.message);
  cancel = new AbortController();
  expect((await host.runAgentTurn({ ...f.input, message: "wait" }, cancel.signal)).termination).toBe(
    "aborted",
  );
});

test("PowerShell runner encodes only the script, streams the prompt, and requires a receipt", async () => {
  const f = await fixture();
  let sawScript = false;
  const launch = ((_command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    const command = args.at(-1)!;
    const script = Buffer.from(command.split(" ").at(-1)!, "base64").toString("utf16le");
    sawScript = true;
    expect(script).not.toContain(f.input.message);
    expect(script).toContain("taskkill.exe");
    expect(script).toContain("ReadToEnd()");
    const token = /CLANKIE_RUN_([a-f0-9-]+):/.exec(script)![1];
    return spawn(
      process.execPath,
      [
        "-e",
        `let input='';process.stdin.on('data',x=>input+=x);process.stdin.on('end',()=>{console.error('\\nCLANKIE_RUN_${token}:91:completed');console.log(JSON.stringify(input));console.error('\\nCLANKIE_RUN_${token}:0:completed');console.error('<Objs>trailing PowerShell progress</Objs>')})`,
      ],
      options,
    );
  }) as typeof spawn;
  const host = createSshAgentHost({ id: "pc", ssh: "test", shell: "powershell" }, { spawn: launch });
  const result = await host.runAgentTurn({ ...f.input, cwd: "C:\\repo" });
  expect(sawScript).toBe(true);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toBe(f.input.message);
  const lost = createSshAgentHost(
    { id: "pc", ssh: "test", shell: "powershell" },
    {
      spawn: ((_cmd: string, _args: string[], opts: Parameters<typeof spawn>[2]) =>
        spawn(process.execPath, ["-e", "process.exit(255)"], opts)) as typeof spawn,
    },
  );
  expect((await lost.runAgentTurn({ ...f.input, cwd: "C:\\repo" })).termination).toBe("unknown");
});

test("resume rejects ambiguous IDs and invalid messages before launching", async () => {
  const f = await fixture();
  const host = createLocalAgentHost();
  await expect(host.runAgentTurn({ ...f.input, sessionId: "--last" })).rejects.toThrow("exact session UUID");
  await expect(host.runAgentTurn({ ...f.input, cwd: "relative" })).rejects.toThrow("absolute");
  await expect(host.runAgentTurn({ ...f.input, message: "x".repeat(32769) })).rejects.toThrow("32768");
});
