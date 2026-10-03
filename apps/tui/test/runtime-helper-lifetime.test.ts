import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expect, it } from "vitest";

it("the actual scheduled detached process survives its fixture service process group exiting", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "clankie-detached-update-")));
  const pin = join(home, ".clankie/pinned"),
    common = join(home, "source/.git");
  mkdirSync(pin, { recursive: true });
  mkdirSync(common, { recursive: true });
  writeFileSync(join(pin, ".git"), "fixture");
  const ready = join(home, "ready.json"),
    completed = join(home, "completed.json");
  const helper = join(home, "fake-helper.mjs"),
    service = join(home, "fake-service.mjs");
  writeFileSync(
    helper,
    `import { writeFileSync } from 'node:fs';\nconst parent=Number(process.argv[2]);\nconst timer=setInterval(()=>{try{process.kill(parent,0);}catch{writeFileSync(${JSON.stringify(completed)},JSON.stringify({survived:true,pid:process.pid}));clearInterval(timer);}},20);\nsetTimeout(()=>process.exit(2),4000).unref();\n`,
  );
  writeFileSync(
    service,
    `import { spawn } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nimport { createRuntimeUpdater } from ${JSON.stringify(resolve(import.meta.dirname, "../bin/runtime-updater.ts"))};\nconst updater=createRuntimeUpdater({repoRoot:${JSON.stringify(pin)},env:{HOME:${JSON.stringify(home)}},run:(_command,args)=>args.includes('--git-common-dir')?${JSON.stringify(common)}:args.includes('--verify')?'a'.repeat(40):'',spawnHelper:(_command,_args,options)=>{const child=spawn(process.execPath,[${JSON.stringify(helper)},String(process.pid)],options);writeFileSync(${JSON.stringify(ready)},JSON.stringify({helper:child.pid,service:process.pid,detached:options.detached}));return child;}});\nawait updater.request('main',{guard:async()=>{},current:()=>true});\nsetInterval(()=>{},1000);\n`,
  );
  const child = spawn(process.execPath, [service], {
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  try {
    for (let count = 0; count < 100 && !existsSync(ready); count++) await sleep(20);
    expect(existsSync(ready), stderr).toBe(true);
    const proof = JSON.parse(readFileSync(ready, "utf8"));
    expect(proof.detached).toBe(true);
    expect(proof.service).toBe(child.pid);
    process.kill(-child.pid!, "SIGTERM");
    await exited;
    for (let count = 0; count < 100 && !existsSync(completed); count++) await sleep(20);
    expect(existsSync(completed), stderr).toBe(true);
    expect(JSON.parse(readFileSync(completed, "utf8"))).toEqual({ survived: true, pid: proof.helper });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      process.kill(-child.pid!, "SIGTERM");
      await exited;
    }
    // The isolated fake helper has an independent four-second ceiling even on assertion failure.
    rmSync(home, { recursive: true, force: true });
  }
});
