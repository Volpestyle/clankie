/** Explicit HTML verifier mediation build/probe. Imports have no process effects. */
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
  lstatSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { LeadContainer, dockerTransportIdentity } from "./lead-containment.mjs";
import { requireNativeBuild } from "./lead-native-image.mjs";
const builds = new WeakMap(),
  proofs = new WeakMap();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const IMAGE = /^sha256:[a-f0-9]{64}$/u;
function owned(root, path, limit = 1024 * 1024) {
  for (let current = dirname(path); ; current = dirname(current)) {
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(current) !== current)
      throw Error("Unowned mediation ancestry");
    if (current === root) break;
    if (dirname(current) === current) throw Error("Mediation output escaped root");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid() || info.size > limit)
      throw Error("Invalid owned mediation output");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}
async function imageIs(command, name, expected) {
  const rows = JSON.parse(await command(["image", "inspect", name]));
  if (rows.length !== 1 || rows[0].Id !== expected || rows[0].Os !== "linux")
    throw Error("Mediation image binding changed");
}
const manifestScript = `import hashlib,json,os,pathlib,sys
mounts=[]
for p in ['/usr','/bin','/lib','/lib64','/etc/ld.so.cache']:
 q=pathlib.Path(p)
 if q.is_symlink(): mounts.append({'path':p,'link':os.readlink(p)})
 elif q.exists(): mounts.append({'path':p})
python=str(pathlib.Path(sys.executable).resolve())
sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
pathlib.Path('/opt/lead/html-runtime.json').write_text(json.dumps({'python':python,'pythonSha256':sha(python),'bwrapSha256':sha('/opt/lead/bwrap'),'mounts':mounts}))
`;

/** The caller separately binds baseImage to its controller-built pinned grader. */
export async function buildHtmlMediation({ command, nativeBuild, baseImage, sourceCommit, output }) {
  if (!IMAGE.test(baseImage) || !/^[a-f0-9]{40}$/u.test(sourceCommit))
    throw Error("Pinned official verifier image/source required");
  const native = requireNativeBuild(nativeBuild, command);
  const endpoint = dockerTransportIdentity(command);
  const daemon = JSON.parse(await command(["info", "--format", "{{json .}}"]));
  if (daemon.OSType !== "linux" || !daemon.ID) throw Error("Exact Linux daemon unavailable");
  await imageIs(command, baseImage, baseImage);
  await imageIs(command, native.image, native.image);
  mkdirSync(output, { mode: 0o700 });
  if (realpathSync(output) !== output || lstatSync(output).mode & 0o077)
    throw Error("Private mediation context required");
  const trampoline = readFileSync(new URL("./lead-html-candidate.py", import.meta.url));
  const bootstrap = readFileSync(new URL("./lead-html-sitecustomize.py", import.meta.url));
  const nonce = randomUUID();
  const baseTag = `clankie-lead-html-base:${nonce}`,
    nativeTag = `clankie-lead-html-native:${nonce}`;
  // Dockerfile FROM/COPY use exact controller-created local refs, checked before
  // and after build. Never pull or resolve an owner-supplied mutable tag.
  await command(["tag", baseImage, baseTag]);
  await command(["tag", native.image, nativeTag]);
  const dockerfile = `FROM ${baseTag}\nCOPY --from=${nativeTag} /opt/codex/bin/bwrap /opt/lead/bwrap\nCOPY candidate-python /opt/lead/candidate-python\nCOPY sitecustomize.py /opt/lead/bootstrap/sitecustomize.py\nCOPY manifest.py /opt/lead/manifest.py\nRUN python3 -I /opt/lead/manifest.py && chmod -R a-w /opt/lead && chmod 555 /opt/lead/candidate-python /opt/lead/bwrap\n`;
  for (const [name, bytes] of [
    ["Dockerfile", dockerfile],
    ["candidate-python", trampoline],
    ["sitecustomize.py", bootstrap],
    ["manifest.py", manifestScript],
  ])
    writeFileSync(join(output, name), bytes, { flag: "wx", mode: 0o400 });
  await imageIs(command, baseTag, baseImage);
  await imageIs(command, nativeTag, native.image);
  const iid = join(output, "image-id");
  await command(["build", "--pull=false", "--iidfile", iid, "--file", join(output, "Dockerfile"), output], {
    timeout: 1_800_000,
  });
  await imageIs(command, baseTag, baseImage);
  await imageIs(command, nativeTag, native.image);
  const image = owned(output, iid, 256).toString().trim();
  if (!IMAGE.test(image)) throw Error("Mediation build lacks immutable image ID");
  const record = {
    image,
    baseImage,
    sourceCommit,
    native,
    endpoint,
    daemonId: daemon.ID,
    harness: {
      trampoline: hash(trampoline),
      bootstrap: hash(bootstrap),
      manifest: hash(manifestScript),
      dockerfile: hash(dockerfile),
    },
    tags: { baseTag, nativeTag },
  };
  const result = Object.freeze(structuredClone(record));
  builds.set(result, { ...record, command });
  return result;
}

/** Fixed canary source, never candidate/user-provided code or a benchmark grader. */
const canary = `import json,os,pathlib,sys
p=pathlib.Path(sys.argv[1]); payload=json.loads(p.read_text()); p.write_text('canary-output')
child=os.fork()
if child==0:
 import time; time.sleep(2); p.write_text('unsettled-descendant'); os._exit(0)
def denied(path):
 try: pathlib.Path(path).read_bytes(); return False
 except OSError: return True
print(json.dumps({'original':payload['sentinel'],'argv':sys.argv[1],'testsDenied':denied('/tests/test_outputs.py'),'logsDenied':denied('/logs/verifier/lead-canary'),'parentDenied':denied('/proc/'+str(payload['parentPid'])+'/environ'),'pidNamespaceChanged':os.readlink('/proc/self/ns/pid')!=payload['namespace'],'networkNamespaceChanged':os.readlink('/proc/self/ns/net')!=payload['network'],'noControl':not pathlib.Path('/eval/control').exists(),'environmentClean':'LEAD_PARENT_PID' not in os.environ}))
`;
const parentProbe = `import json,os,pathlib,subprocess,sys,tempfile
assert sys.executable == '/opt/lead/candidate-python'
assert pathlib.Path('/tests/test_outputs.py').is_file()
assert pathlib.Path('/logs/verifier/lead-canary').is_file()
with tempfile.NamedTemporaryFile(mode='w',suffix='.html',delete=False) as f: json.dump({'sentinel':'canary-input','parentPid':os.getpid(),'namespace':os.readlink('/proc/self/ns/pid'),'network':os.readlink('/proc/self/ns/net')},f); path=f.name
os.environ['LEAD_PARENT_PID']=str(os.getpid())
result=subprocess.run([sys.executable,'/app/filter.py',path],capture_output=True,text=True,timeout=10)
assert result.returncode == 0, result.stderr
proof=json.loads(result.stdout); proof['rewritten']=pathlib.Path(path).read_text()=='canary-output'; proof['trampoline']=sys.executable
pathlib.Path('/logs/verifier/mediation-proof.json').write_text(json.dumps(proof))
`;

export async function probeHtmlMediation({ build, command, root }) {
  const record = builds.get(build);
  if (
    !record ||
    record.command !== command ||
    JSON.stringify(record.endpoint) !== JSON.stringify(dockerTransportIdentity(command))
  )
    throw Error("Controller-origin HTML mediation build required");
  const daemon = JSON.parse(await command(["info", "--format", "{{json .}}"]));
  if (daemon.ID !== record.daemonId || daemon.OSType !== "linux") throw Error("HTML probe daemon changed");
  mkdirSync(root, { mode: 0o700 });
  const app = join(root, "app"),
    logs = join(root, "logs");
  mkdirSync(app, { mode: 0o700 });
  mkdirSync(logs, { mode: 0o700 });
  writeFileSync(join(app, "filter.py"), canary, { flag: "wx", mode: 0o400 });
  writeFileSync(join(logs, "lead-canary"), "private verifier marker", { flag: "wx", mode: 0o400 });
  const container = new LeadContainer({
    image: record.image,
    root: app,
    verifierLogs: logs,
    role: "verifier",
    command,
  });
  // The immutable image supplies /tests; canary probes an existing pinned grader,
  // not a nonexistent path whose absence could masquerade as isolation.
  await container.create([
    "/usr/bin/env",
    "-i",
    "PATH=/usr/local/bin:/usr/bin:/bin",
    "HOME=/tmp",
    "PYTHONPATH=/opt/lead/bootstrap",
    "PYTHONDONTWRITEBYTECODE=1",
    "python3",
    "-c",
    parentProbe,
  ]);
  let proof;
  try {
    await container.start();
    const code = await command(["wait", container.id], { timeout: 30_000 });
    await container.inspect();
    if (code.trim() !== "0") throw Error("HTML candidate boundary probe failed");
    proof = JSON.parse(owned(logs, join(logs, "mediation-proof.json")));
    if (
      proof.original !== "canary-input" ||
      !proof.rewritten ||
      !proof.testsDenied ||
      !proof.logsDenied ||
      !proof.parentDenied ||
      !proof.pidNamespaceChanged ||
      !proof.networkNamespaceChanged ||
      !proof.noControl ||
      !proof.environmentClean ||
      proof.trampoline !== "/opt/lead/candidate-python" ||
      !/^\/tmp\/[^/]+\.html$/u.test(proof.argv)
    )
      throw Error("Incomplete HTML isolation probe");
  } finally {
    await container.stop("HTML mediation probe settled");
  }
  const result = Object.freeze({
    image: record.image,
    baseImage: record.baseImage,
    sourceCommit: record.sourceCommit,
    harness: record.harness,
    probeSha256: hash(JSON.stringify(proof)),
    probeContainerId: container.id,
  });
  proofs.set(result, { ...record, command });
  return result;
}

export async function assertHtmlMediation(proof, { command, image, baseImage, sourceCommit }) {
  const record = proofs.get(proof);
  if (
    !record ||
    record.command !== command ||
    record.image !== image ||
    record.baseImage !== baseImage ||
    record.sourceCommit !== sourceCommit ||
    JSON.stringify(record.endpoint) !== JSON.stringify(dockerTransportIdentity(command))
  )
    throw Error("HTML verification refused: exact controller-probed mediation required");
  const daemon = JSON.parse(await command(["info", "--format", "{{json .}}"]));
  if (daemon.ID !== record.daemonId || daemon.OSType !== "linux")
    throw Error("HTML capability daemon changed");
  return { harness: structuredClone(record.harness), sourceCommit };
}
