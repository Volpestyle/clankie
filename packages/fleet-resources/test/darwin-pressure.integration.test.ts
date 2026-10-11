// Real Darwin sysctl/native helper → pressure sampler → governor admission.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, copyFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { resourceNativeHelperPath } from "../src/process.ts";

const execute = promisify(execFile);
const darwinIt = it.skipIf(process.platform !== "darwin");
const pressureUrl = pathToFileURL(join(import.meta.dirname, "../src/pressure.ts")).href;
const governorUrl = pathToFileURL(join(import.meta.dirname, "../src/governor.ts")).href;
const evidenceDirectory = resolve(".local/fleet-memory-pressure");

async function driver(source: string) {
  const directory = await mkdtemp(join(tmpdir(), "clankie-memory-pressure-"));
  try {
    const path = join(directory, "driver.mjs");
    await writeFile(path, source);
    const { stdout } = await execute(process.execPath, [path], { timeout: 10_000 });
    return JSON.parse(stdout);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

darwinIt(
  "bounds memory_pressure by free and file-backed pages and reuses one native read across repeated samplers",
  async () => {
    const observation = await driver(`
import {execFile} from 'node:child_process';
import {Socket} from 'node:net';
import {totalmem} from 'node:os';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {ResourcePressureSampler} from ${JSON.stringify(pressureUrl)};
const execute=promisify(execFile);
// Native reads are requests to the long-lived observer (VUH-2082).
let nativeMemoryReads=0;
const original=Socket.prototype.write;
Socket.prototype.write=function(chunk,...rest){
  if(typeof chunk==='string'&&chunk.includes('"op":"memory"')) nativeMemoryReads++;
  return Reflect.apply(original,this,[chunk,...rest]);
};
const query=async()=>{
  const {stdout}=await execute('/usr/bin/memory_pressure',['-Q']);
  const percent=Number(/System-wide memory free percentage:\\s*(\\d+)%/.exec(stdout)?.[1]);
  if(!Number.isInteger(percent)) throw new Error('Missing real memory_pressure percentage');
  const {stdout:vm}=await execute('/usr/bin/vm_stat',[]);
  const pageSize=Number(/page size of (\\d+) bytes/.exec(vm)?.[1]);
  const free=Number(/Pages free:\\s*(\\d+)/.exec(vm)?.[1]);
  const fileBacked=Number(/File-backed pages:\\s*(\\d+)/.exec(vm)?.[1]);
  if(![pageSize,free,fileBacked].every(Number.isFinite)) throw Error('Missing kernel page census');
  return {at:new Date().toISOString(),percent,stdout,vm,availableMemoryMb:Math.min(totalmem()*percent/100,(free+fileBacked)*pageSize)/1024**2};
};
const policy={heavySlots:1,simulatorSlots:1,simulatorIdleMs:600000,maxLoadRatio:16,minAvailableMemoryMb:0};
const before=await query();
const first=await new ResourcePressureSampler().sample(policy);
const after=await query();
const repeated=await Promise.all(Array.from({length:12},()=>new ResourcePressureSampler().sample(policy)));
const readsBeforeExpiry=nativeMemoryReads;
await delay(1100);
const refreshed=await new ResourcePressureSampler().sample(policy);
Socket.prototype.write=original;
console.log(JSON.stringify({before,after,first,refreshed,totalMemoryBytes:totalmem(),
  repeated:repeated.map(row=>row.availableMemoryMb),readsBeforeExpiry,nativeMemoryReads}));
`);
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(join(evidenceDirectory, "live.json"), JSON.stringify(observation, null, 2) + "\n");
    expect(observation.first.healthy).toBe(true);
    expect(observation.refreshed.healthy).toBe(true);
    expect(
      Math.min(
        Math.abs(observation.first.availableMemoryMb - observation.before.availableMemoryMb),
        Math.abs(observation.first.availableMemoryMb - observation.after.availableMemoryMb),
      ),
    ).toBeLessThanOrEqual((observation.totalMemoryBytes / 1024 ** 2) * 0.03);
    expect(observation.first.availableMemoryMb).toBeLessThanOrEqual(observation.totalMemoryBytes / 1024 ** 2);
    expect(observation.repeated).toEqual(Array(12).fill(observation.first.availableMemoryMb));
    expect(observation.readsBeforeExpiry).toBe(1);
    expect(observation.nativeMemoryReads).toBe(2);
  },
);

darwinIt("admits or refuses at the configured memory minimum using the real Darwin source", async () => {
  const observation = await driver(`
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir,totalmem} from 'node:os';
import {join} from 'node:path';
import {createResourceGovernor} from ${JSON.stringify(governorUrl)};
const directory=await mkdtemp(join(tmpdir(),'clankie-memory-admission-'));
const governor=createResourceGovernor({directory});
try{
  const minimum=Math.floor(totalmem()/1024**2)+1;
  const policy={heavySlots:1,simulatorSlots:1,simulatorIdleMs:600000,maxLoadRatio:16,minAvailableMemoryMb:0};
  await governor.configure(policy);
  const admitted=await governor.admitBuilder();
  await governor.configure({...policy,minAvailableMemoryMb:minimum});
  const admission=await governor.admitBuilder();
  console.log(JSON.stringify({minimum,admitted,admission}));
}finally{await governor.close();await rm(directory,{recursive:true,force:true});}
`);
  expect(observation.admitted.allowed).toBe(true);
  expect(observation.admission.allowed).toBe(false);
  expect(observation.admission.reason).toBe("pressure");
  expect(observation.admission.pressure.reason).toBe("memory");
  expect(observation.admission.pressure.availableMemoryMb).toBeGreaterThanOrEqual(0);
  expect(observation.admission.pressure.availableMemoryMb).toBeLessThan(observation.minimum);
});

darwinIt("does not reuse an expired healthy value when the native reply becomes invalid", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clankie-memory-reply-"));
  try {
    for (const file of ["process.ts", "pressure.ts", "parallelism.ts"])
      await copyFile(join(import.meta.dirname, "../src", file), join(directory, file));
    const fault = join(directory, "corrupt-reply");
    // Corrupt only the actual native reply. All valid values and availability
    // observations still come from the production helper and real kernel.
    await writeFile(
      join(directory, "native.py"),
      `import json, os, pathlib, runpy, sys
scope = runpy.run_path(${JSON.stringify(resourceNativeHelperPath())})
# The long-lived observer's protocol (VUH-2082), answering what the sampler asks.
while True:
    line = sys.stdin.readline()
    if not line:
        break
    request = json.loads(line)
    if request["op"] == "memory":
        reply = scope["darwin_memory"]()
        if pathlib.Path(${JSON.stringify(fault)}).exists():
            reply["availablePercent"] = 101
        answer = {"id": request["id"], "result": reply}
    elif request["op"] == "available":
        answer = {"id": request["id"], "result": scope["identity"](os.getpid()) is not None}
    else:
        answer = {"id": request["id"], "error": "RuntimeError"}
    print(json.dumps(answer), flush=True)
`,
    );
    const path = join(directory, "driver.mjs");
    await writeFile(
      path,
      `
import {writeFile,rm} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {ResourcePressureSampler} from ${JSON.stringify(pathToFileURL(join(directory, "pressure.ts")).href)};
const sampler=new ResourcePressureSampler();
const policy={heavySlots:1,simulatorSlots:1,simulatorIdleMs:600000,maxLoadRatio:16,minAvailableMemoryMb:0};
const before=await sampler.sample(policy);
await writeFile(${JSON.stringify(fault)},'corrupt only the native receipt');
await delay(1100);
const refused=await sampler.sample(policy);
await rm(${JSON.stringify(fault)});
const recovered=await sampler.sample(policy);
console.log(JSON.stringify({before,refused,recovered}));
`,
    );
    const { stdout } = await execute(process.execPath, [path], { timeout: 10_000 });
    const observation = JSON.parse(stdout);
    expect(observation.before.healthy).toBe(true);
    expect(observation.refused).toMatchObject({
      healthy: false,
      reason: "probe-unavailable",
      availableMemoryMb: 0,
    });
    expect(observation.recovered.healthy).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
