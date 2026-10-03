/** Controller-origin, credential-free Linux sandbox proof. Imports never probe. */
import { nativePermissionConfig } from "./lead-native-policy.mjs";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LeadContainer, dockerTransportIdentity } from "./lead-containment.mjs";
import { requireNativeBuild } from "./lead-native-image.mjs";
const proofs = new WeakMap();
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ENV = [
  "/usr/bin/env",
  "-i",
  "PATH=/opt/codex/bin:/usr/local/bin:/usr/bin:/bin",
  "HOME=/eval/control/home",
  "CODEX_HOME=/eval/control/auth",
];

/** Explicit future probe only. No auth, provider requests, agent turns, or owner fleet. */
export async function probeNativeRuntime({ build, command, root }) {
  const built = requireNativeBuild(build, command);
  mkdirSync(root, { mode: 0o700 });
  for (const path of [
    "control",
    "control/home",
    "control/auth",
    "tasks",
    "tasks/probe",
    "tasks/probe/.git",
    "tasks/probe/.codex",
  ])
    mkdirSync(join(root, path), { mode: 0o700 });
  writeFileSync(join(root, "tasks/probe/.git/config"), "[core]\n", { flag: "wx", mode: 0o600 });
  const nonce = randomUUID();
  writeFileSync(join(root, "control", "canary"), nonce, { mode: 0o600, flag: "wx" });
  writeFileSync(
    join(root, "control", "auth", "auth.json"),
    JSON.stringify({ harmlessCapabilityCanary: nonce }),
    { mode: 0o600, flag: "wx" },
  );
  const daemon = JSON.parse(await command(["info", "--format", "{{json .}}"]));
  if (typeof daemon.ID !== "string" || !daemon.ID || daemon.OSType !== "linux")
    throw Error("Exact Linux daemon identity unavailable");
  const container = new LeadContainer({ image: built.image, root, role: "probe", command });
  const supervisor = `const fs=require('node:fs'),net=require('node:net');const server=net.createServer(s=>s.end('probe'));server.listen('/eval/control/probe.sock',()=>fs.writeFileSync('/eval/control/supervisor.json',JSON.stringify({pid:process.pid,namespace:fs.readlinkSync('/proc/self/ns/pid'),network:fs.readlinkSync('/proc/self/ns/net')})));`;
  await container.create([...ENV, "/usr/local/bin/node", "-e", supervisor]);
  let evidence;
  try {
    await container.start();
    const binaries = JSON.parse(
      await container.exec([
        ...ENV,
        "/usr/local/bin/node",
        "-e",
        `const fs=require('node:fs'),c=require('node:crypto');process.stdout.write(JSON.stringify(Object.fromEntries(['/opt/codex/bin/codex','/opt/codex/bin/bwrap','/usr/local/bin/herdr','/usr/local/bin/node'].map(p=>[p,c.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]))));`,
      ]),
    );
    if (
      Object.keys(binaries).length !== 4 ||
      Object.values(binaries).some((value) => !/^[a-f0-9]{64}$/u.test(value))
    )
      throw Error("Native binary identity unavailable");
    const outside = JSON.parse(
      await container.exec([
        ...ENV,
        "/usr/local/bin/node",
        "-e",
        `const fs=require('node:fs');const until=Date.now()+5000;const poll=()=>{try{process.stdout.write(fs.readFileSync('/eval/control/supervisor.json','utf8'));return}catch{}if(Date.now()>until)process.exit(1);setTimeout(poll,20)};poll();`,
      ]),
    );
    const config = nativePermissionConfig("/eval/tasks/probe");
    // The native sandbox subcommand runs a harmless local command, not an agent/model harness.
    const check = `const fs=require('node:fs');const deny=p=>{try{fs.readFileSync(p);return false}catch{return true}};const writeDenied=p=>{try{fs.writeFileSync(p,'forbidden');return false}catch{return true}};const out={gitConfigDenied:writeDenied('/eval/tasks/probe/.git/config'),projectConfigDenied:writeDenied('/eval/tasks/probe/.codex/config.toml'),cwdConfigDenied:writeDenied('/eval/tasks/probe/config.toml'),nonce:${JSON.stringify(nonce)},controlDenied:deny('/eval/control/canary'),authDenied:deny('/eval/control/auth/auth.json'),parentProcDenied:deny('/proc/${outside.pid}/environ'),namespace:fs.readlinkSync('/proc/self/ns/pid'),network:fs.readlinkSync('/proc/self/ns/net')};fs.writeFileSync('/eval/tasks/probe/write-canary','ok');out.allocatedWrite=fs.readFileSync('/eval/tasks/probe/write-canary','utf8')==='ok';const net=require('node:net');const socket=net.createConnection('/eval/control/probe.sock');socket.setTimeout(1000);socket.once('connect',()=>{socket.destroy();process.exit(1)});socket.once('timeout',()=>process.exit(1));socket.once('error',()=>{out.privateSocketDenied=true;process.stdout.write(JSON.stringify(out));});`;
    const result = JSON.parse(
      await container.exec([
        ...ENV,
        "/opt/codex/bin/codex",
        ...config.flatMap((value) => ["-c", value]),
        "sandbox",
        "linux",
        "--permission-profile",
        "lead_eval",
        "--cd",
        "/eval/tasks/probe",
        "--",
        "/usr/local/bin/node",
        "-e",
        check,
      ]),
    );
    if (
      result.nonce !== nonce ||
      !result.gitConfigDenied ||
      !result.projectConfigDenied ||
      !result.cwdConfigDenied ||
      !result.controlDenied ||
      !result.authDenied ||
      !result.parentProcDenied ||
      !result.privateSocketDenied ||
      !result.allocatedWrite ||
      typeof result.namespace !== "string" ||
      result.namespace === outside.namespace ||
      typeof result.network !== "string" ||
      result.network === outside.network
    )
      throw Error("Native sandbox did not establish the required isolation");
    evidence = {
      source: built,
      daemonId: daemon.ID,
      endpoint: dockerTransportIdentity(command),
      binaries,
      probeContainerId: container.id,
      probe: result,
      createdAt: Date.now(),
    };
  } finally {
    await container.stop("credential-free native capability probe settled");
  }
  // JSON copies are evidence only. Authority exists only in this controller's WeakMap.
  const result = Object.freeze({
    schemaVersion: 1,
    image: built.image,
    evidence: structuredClone(evidence),
    sha256: hash(evidence),
  });
  proofs.set(result, {
    image: built.image,
    evidence: structuredClone(evidence),
    command,
    daemonId: daemon.ID,
    endpoint: dockerTransportIdentity(command),
  });
  return result;
}

export async function assertNativeRuntimeCapability(proof, { image, command }) {
  const record = proofs.get(proof);
  if (
    !record ||
    record.image !== image ||
    record.command !== command ||
    JSON.stringify(record.endpoint) !== JSON.stringify(dockerTransportIdentity(command))
  )
    throw Error("Native lifecycle refused: no controller-origin image/binary/sandbox capability proof");
  const daemon = JSON.parse(await command(["info", "--format", "{{json .}}"]));
  if (daemon.ID !== record.daemonId || daemon.OSType !== "linux")
    throw Error("Native capability daemon identity changed");
}

export function nativeRuntimeEvidence(proof) {
  const record = proofs.get(proof);
  if (!record) throw Error("No controller-origin native capability evidence");
  return structuredClone(record.evidence);
}
