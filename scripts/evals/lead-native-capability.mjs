/** Controller-origin, credential-free Linux sandbox proof. Imports never probe. */
import { claudeSandboxArgs, claudeEnvironment, CLAUDE } from "./lead-native-claude-sandbox.mjs";
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
  if (built.runtime === "claude") return probeClaudeControl({ built, command, root });
  mkdirSync(root, { mode: 0o700 });
  for (const path of [
    "control",
    "control/home",
    "control/auth",
    "control/coding-helper",
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
        `const fs=require('node:fs'),c=require('node:crypto');process.stdout.write(JSON.stringify(Object.fromEntries(['/opt/codex/bin/codex','/opt/codex/bin/bwrap','/usr/local/bin/herdr','/usr/local/bin/node','/usr/local/lib/lead-coding-helper.mjs','/usr/local/lib/lead-coding-supervisor.mjs','/usr/local/lib/lead-native-policy.mjs'].map(p=>[p,c.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]))));`,
      ]),
    );
    if (
      Object.keys(binaries).length !== 7 ||
      binaries["/usr/local/lib/lead-coding-supervisor.mjs"] !== built.codingSupervisor ||
      binaries["/usr/local/lib/lead-native-policy.mjs"] !== built.codingPolicy ||
      binaries["/usr/local/lib/lead-coding-helper.mjs"] !== built.codingHelper ||
      Object.values(binaries).some((value) => !/^[a-f0-9]{64}$/u.test(value))
    )
      throw Error("Native binary identity unavailable");
    let taskEnvironment;
    if (built.taskEnvironment) {
      const expected = {
        "html-js-filter": {
          python: "3.12",
          imports: ["bs4", "lxml.etree"],
          packages: { beautifulsoup4: "4.13.4", lxml: "6.1.1" },
        },
        "photonic-waveguide-routing": {
          python: "3.13",
          imports: ["numpy", "scipy", "shapely", "rtree"],
          packages: { numpy: "2.4.4", scipy: "1.17.1", shapely: "2.1.2", rtree: "1.4.1" },
        },
      }[built.taskEnvironment.taskId];
      if (!expected) throw Error("Unsupported official task environment");
      const inputs = built.taskEnvironment.files.filter(
        (file) => file.path.includes("/environment/") && !file.path.endsWith("/Dockerfile"),
      );
      const observed = JSON.parse(
        await container.exec([
          ...ENV,
          "/usr/local/bin/python3",
          "-I",
          "-c",
          `import sys,json,hashlib,pathlib,importlib.metadata as m
[__import__(name) for name in ${JSON.stringify(expected.imports)}]
p=${JSON.stringify(Object.keys(expected.packages))}
files=${JSON.stringify(inputs.map((file) => "/app/" + file.path.split("/environment/")[1]))}
print(json.dumps({"python":".".join(map(str,sys.version_info[:2])),"packages":{k:m.version(k) for k in p},"executableSha256":hashlib.sha256(pathlib.Path(sys.executable).read_bytes()).hexdigest(),"inputs":{p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest() for p in files}}))`,
        ]),
      );
      if (
        observed.python !== expected.python ||
        JSON.stringify(observed.packages) !== JSON.stringify(expected.packages) ||
        !/^[a-f0-9]{64}$/u.test(observed.executableSha256) ||
        inputs.some(
          (file) => observed.inputs?.["/app/" + file.path.split("/environment/")[1]] !== file.sha256,
        )
      )
        throw Error("Official native task environment preflight mismatch");
      taskEnvironment = {
        ...observed,
        taskId: built.taskEnvironment.taskId,
        sourceCommit: built.taskEnvironment.sourceCommit,
        baseImage: built.taskEnvironment.image,
      };
    }
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
    // A worker model-tool probe cannot authorize the Pi coding-tool helper path.
    // Run the same isolation checks through the actual immutable helper and shell.
    const helper = JSON.parse(
      await container.exec(
        [...ENV, "/usr/local/bin/node", "/usr/local/lib/lead-coding-supervisor.mjs", "/eval/tasks/probe"],
        {
          input: JSON.stringify({
            op: "bash",
            command: "/usr/local/bin/node -e " + "'" + check.replaceAll("'", "'\"'\"'") + "'",
          }),
        },
      ),
    );
    const helperIsolation = JSON.parse(helper.result.output);
    if (
      helper.result.exitCode !== 0 ||
      helper.settlement?.complete !== true ||
      helperIsolation.nonce !== nonce ||
      [
        "gitConfigDenied",
        "projectConfigDenied",
        "cwdConfigDenied",
        "controlDenied",
        "authDenied",
        "parentProcDenied",
        "privateSocketDenied",
        "allocatedWrite",
      ].some((key) => helperIsolation[key] !== true) ||
      typeof helperIsolation.namespace !== "string" ||
      helperIsolation.namespace === outside.namespace ||
      typeof helperIsolation.network !== "string" ||
      helperIsolation.network === outside.network
    )
      throw Error("Coding helper did not establish its actual execution boundary");
    const descendants = JSON.parse(
      await container.exec(
        [...ENV, "/usr/local/bin/node", "/usr/local/lib/lead-coding-supervisor.mjs", "/eval/tasks/probe"],
        {
          input: JSON.stringify({
            op: "bash",
            command: `/usr/local/bin/node -e 'const c=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify('setTimeout(()=>require("node:fs").writeFileSync("/eval/tasks/probe/late-descendant", "survived"),2000)')}],{detached:true,stdio:"ignore"});c.unref();'`,
          }),
        },
      ),
    );
    if (
      descendants.result.exitCode !== 0 ||
      descendants.settlement?.complete !== true ||
      !/^pid:\[[0-9]+\]$/u.test(descendants.settlement.namespace)
    )
      throw Error("Coding helper descendant canary did not complete");
    const descendantSettlement = JSON.parse(
      await container.exec(
        [
          ...ENV,
          "/usr/local/bin/node",
          "-e",
          `const f=require('node:fs');setTimeout(()=>{let live=false;for(const p of f.readdirSync('/proc')){if(!/^[0-9]+$/.test(p))continue;try{if(f.readlinkSync('/proc/'+p+'/ns/pid')===process.argv[1])live=true}catch(e){if(e.code!=='ENOENT'&&e.code!=='ESRCH')throw e}}process.stdout.write(JSON.stringify({namespaceGone:!live,noLateWrite:!f.existsSync('/eval/tasks/probe/late-descendant')}))},3000)`,
          descendants.settlement.namespace,
        ],
        { timeoutMs: 5000 },
      ),
    );
    if (descendantSettlement.namespaceGone !== true || descendantSettlement.noLateWrite !== true)
      throw Error("Coding helper descendants outlived execution");
    evidence = {
      source: built,
      ...(taskEnvironment ? { taskEnvironment } : {}),
      daemonId: daemon.ID,
      endpoint: dockerTransportIdentity(command),
      binaries,
      probeContainerId: container.id,
      probe: result,
      codingHelper: {
        sha256: built.codingHelper,
        supervisorSha256: built.codingSupervisor,
        isolation: helperIsolation,
        descendantSettlement,
      },
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

/** Earned independently of Codex's model-tool sandbox; the entire process is contained. */
async function probeClaudeControl({ built, command, root }) {
  mkdirSync(root, { mode: 0o700 });
  for (const directory of [
    "control",
    "control/claude",
    "control/claude/home",
    "control/claude/config",
    "tasks",
    "tasks/lead",
    "tasks/other",
  ])
    mkdirSync(join(root, directory), { mode: 0o700 });
  const { writeNativeClaudeCollectorHooks } = await import("./lead-native-claude-collector.mjs");
  writeNativeClaudeCollectorHooks(root);
  const nonce = randomUUID();
  writeFileSync(join(root, "control/canary"), nonce, { mode: 0o600, flag: "wx" });
  writeFileSync(join(root, "control/claude/settings.json"), "{}", { mode: 0o400, flag: "wx" });
  writeFileSync(join(root, "tasks/other/canary"), nonce, { mode: 0o600, flag: "wx" });
  const daemon = JSON.parse(await command(["info", "--format", "{{json .}}"]));
  if (!daemon.ID || daemon.OSType !== "linux") throw Error("Exact Claude Linux daemon unavailable");
  const container = new LeadContainer({ image: built.image, root, role: "probe", command });
  const env = claudeEnvironment();
  const clean = ["/usr/bin/env", "-i", ...Object.entries(env).map(([key, value]) => `${key}=${value}`)];
  await container.create([
    "/usr/local/bin/node",
    "-e",
    `const f=require('node:fs'),n=require('node:net');n.createServer(s=>s.end('canary')).listen('/eval/control/private.sock',()=>f.writeFileSync('/eval/control/supervisor.json',JSON.stringify({pid:process.pid,namespaces:Object.fromEntries(['pid','mnt','net'].map(k=>[k,f.readlinkSync('/proc/self/ns/'+k)]))})));`,
  ]);
  let evidence;
  try {
    await container.start();
    const paths = [
      CLAUDE,
      "/opt/codex/bin/bwrap",
      "/usr/local/bin/herdr",
      "/usr/local/bin/node",
      "/usr/bin/python3",
      ...Object.keys(built.modules),
    ];
    const binaries = JSON.parse(
      await container.exec([
        "/usr/local/bin/node",
        "-e",
        `const f=require('node:fs'),c=require('node:crypto');process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(paths)}.map(p=>[p,c.createHash('sha256').update(f.readFileSync(p)).digest('hex')]))));`,
      ]),
    );
    if (
      Object.keys(binaries).length !== paths.length ||
      paths.some((path) => !/^[a-f0-9]{64}$/u.test(binaries[path])) ||
      binaries[CLAUDE] !== built.artifact.sha256 ||
      Object.entries(built.modules).some(([path, hash]) => binaries[path] !== hash)
    )
      throw Error("Claude native image/module identity unavailable");
    const outside = JSON.parse(
      await container.exec([
        "/usr/local/bin/node",
        "-e",
        `const f=require('node:fs');const deadline=Date.now()+5000;const read=()=>{try{process.stdout.write(f.readFileSync('/eval/control/supervisor.json'));}catch{if(Date.now()>deadline)process.exit(1);setTimeout(read,20)}};read();`,
      ]),
    );
    const args = claudeSandboxArgs({ hooks: true });
    const result = JSON.parse(
      await container.exec(
        [
          ...clean,
          "/opt/codex/bin/bwrap",
          ...args,
          "--",
          "/usr/local/bin/node",
          "-e",
          `const f=require('node:fs');const denied=p=>{try{f.readFileSync(p);return false}catch{return true}};const out={nonce:${JSON.stringify(nonce)},controlDenied:denied('/eval/control/canary'),otherWorkspaceDenied:denied('/eval/tasks/other/canary'),parentProcDenied:denied('/proc/${outside.pid}/root/eval/control/canary'),namespaces:Object.fromEntries(['pid','mnt','net'].map(k=>[k,f.readlinkSync('/proc/self/ns/'+k)]))};f.writeFileSync('/eval/tasks/lead/canary','ok');out.allocatedWrite=f.readFileSync('/eval/tasks/lead/canary','utf8')==='ok';try{f.writeFileSync('/eval/control/claude/settings.json','bad');out.settingsWriteDenied=false}catch{out.settingsWriteDenied=true}const socket=require('node:net').createConnection('/eval/control/private.sock');socket.setTimeout(1000);socket.once('connect',()=>process.exit(1));socket.once('timeout',()=>process.exit(1));socket.once('error',()=>{out.privateSocketDenied=true;process.stdout.write(JSON.stringify(out));});`,
        ],
        { timeoutMs: 10000 },
      ),
    );
    if (
      result.nonce !== nonce ||
      [
        "controlDenied",
        "privateSocketDenied",
        "otherWorkspaceDenied",
        "parentProcDenied",
        "allocatedWrite",
        "settingsWriteDenied",
      ].some((key) => result[key] !== true) ||
      ["pid", "mnt", "net"].some(
        (key) =>
          typeof result.namespaces?.[key] !== "string" || result.namespaces[key] === outside.namespaces[key],
      )
    )
      throw Error("Claude whole-process control isolation unavailable");
    const version = (
      await container.exec([...clean, "/opt/codex/bin/bwrap", ...args, "--", CLAUDE, "--version"], {
        timeoutMs: 10000,
      })
    ).trim();
    if (version !== `${built.artifact.version} (Claude Code)`)
      throw Error("Selected Claude native version mismatch");
    evidence = {
      runtime: "claude",
      source: built,
      binaries,
      version,
      daemonId: daemon.ID,
      endpoint: dockerTransportIdentity(command),
      probeContainerId: container.id,
      policy: args,
      isolation: result,
      providerNetwork: "denied",
      providerAdmission: false,
      childRouting: false,
      nativeTuiObserved: false,
      vendorProvenance: false,
      createdAt: Date.now(),
    };
  } finally {
    await container.stop("credential-free Claude control probe settled");
  }
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
