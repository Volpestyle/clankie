import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({ owner: true, pipe: vi.fn(), inspect: vi.fn(), stop: vi.fn() }));
// Only test-local process/container fixtures are substituted; there is no production bypass.
vi.mock("../../../scripts/evals/lead-containment.mjs", () => ({
  LeadContainer: class {
    role = "native";
    id = "a".repeat(64);
    image = `sha256:${"b".repeat(64)}`;
    stopped = false;
    signal = new AbortController().signal;
    root: string;
    constructor(root: string) {
      this.root = root;
    }
    inspect() {
      return fake.inspect();
    }
    pipe(argv: string[]) {
      return fake.pipe(argv);
    }
    stop(reason: string) {
      this.stopped = true;
      return fake.stop(reason);
    }
  },
}));
vi.mock("../../../scripts/evals/lead-native-attachment.mjs", () => ({
  NativeOwnerAttachment: class {
    container: unknown;
    constructor(container: unknown) {
      this.container = container;
    }
    async attached() {
      return fake.owner;
    }
  },
}));
vi.mock("../../../scripts/evals/lead-native-capability.mjs", () => ({
  nativeRuntimeEvidence: () => ({ binaries: { "/opt/claude/bin/claude": "c".repeat(64) } }),
}));
// @ts-expect-error -- checkout-only ESM fixture module.
import * as collection from "../../../scripts/evals/lead-native-claude-collector.mjs";
// @ts-expect-error -- checkout-only ESM fixture module.
import { LeadContainer } from "../../../scripts/evals/lead-containment.mjs";
// @ts-expect-error -- checkout-only ESM fixture module.
import { NativeOwnerAttachment } from "../../../scripts/evals/lead-native-attachment.mjs";
const { startNativeClaudeCollector, writeNativeClaudeCollectorHooks } = collection;
const roots: string[] = [],
  collectors: Array<{ close(): Promise<unknown> }> = [];
const sessionId = "11223344-1122-1122-1122-112233445566";
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const rootBinding = {
  pid: 123,
  startTicks: "456",
  tty: 100,
  executableSha256: "c".repeat(64),
  exeDevice: "1",
  exeInode: "2",
  exeBytes: 8,
  exeCtimeNs: "123456",
};
const selection = {
  paneId: "w1:p1",
  cwd: "/eval/tasks/lead",
  sessionId,
  executableSha256: rootBinding.executableSha256,
  argv: [
    "/opt/claude/bin/claude",
    "--session-id",
    sessionId,
    "--settings",
    "/eval/control/claude/collector/settings.json",
  ],
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
beforeEach(() => {
  fake.owner = true;
  vi.clearAllMocks();
  fake.stop.mockResolvedValue({ containerId: "a".repeat(64), stopped: true });
});
afterEach(async () => {
  for (const collector of collectors.splice(0)) await collector.close().catch(() => {});
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.useRealTimers();
});
function directory() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "claude-collector-fixture-"));
  roots.push(root);
  return root;
}
function fixture() {
  const root = directory(),
    native = join(root, "native");
  mkdirSync(native, { mode: 0o700 });
  const container = new LeadContainer(native),
    ownerAttachment = new NativeOwnerAttachment(container);
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(),
  });
  let acks = 0;
  child.stdin.on("data", () => {
    acks++;
  });
  fake.inspect.mockResolvedValue({ Mounts: [{ Source: native }] });
  fake.pipe.mockImplementation(async () => {
    setImmediate(() => child.stdout.write('{"kind":"ready"}\n'));
    return child;
  });
  return {
    root,
    native,
    container,
    ownerAttachment,
    output: join(root, "evidence"),
    child,
    acks: () => acks,
  };
}
async function start(f = fixture()) {
  const collector = await startNativeClaudeCollector({ ...f, selection });
  collectors.push(collector);
  await tick();
  return { ...f, collector };
}
async function send(f: ReturnType<typeof fixture>, frame: unknown) {
  const before = f.acks();
  f.child.stdout.write(JSON.stringify(frame) + "\n");
  await vi.waitFor(() => expect(f.acks()).toBe(before + 1));
  await tick();
}
function hook(sequence: number, name: string, extra: Record<string, unknown> = {}) {
  const bytes = Buffer.from(JSON.stringify({ session_id: sessionId, hook_event_name: name, ...extra }));
  return {
    kind: "hook",
    sequence,
    root: rootBinding,
    peer: { pid: 124, startTicks: "457" },
    data: bytes.toString("base64"),
    bytes: bytes.length,
    sha256: sha(bytes),
  };
}
const end = (sequence: number, gaps: string[] = []) => ({
  kind: "batch-end",
  sequence,
  root: rootBinding,
  gaps,
});
function transcript(sequence: number, text: string, extra: Record<string, unknown> = {}) {
  const bytes = Buffer.from(text);
  return {
    kind: "snapshot",
    sequence,
    root: rootBinding,
    agentId: null,
    bytes: bytes.length,
    data: bytes.toString("base64"),
    sha256: sha(bytes),
    device: 1,
    inode: 2,
    ...extra,
  };
}
const assistant =
  JSON.stringify({
    type: "assistant",
    sessionId,
    uuid: "one",
    message: {
      id: "message-one",
      content: "fixture private transcript body",
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 2,
      },
    },
  }) + "\n";

it("writes an explicit seven-hook bridge but supplies no launch authority or ambient settings", () => {
  const root = directory();
  mkdirSync(join(root, "control"), { mode: 0o700 });
  mkdirSync(join(root, "control/claude"), { mode: 0o700 });
  const result = writeNativeClaudeCollectorHooks(root);
  expect(Object.keys(result.settings.hooks)).toEqual([
    "SessionStart",
    "UserPromptSubmit",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "StopFailure",
    "SessionEnd",
  ]);
  expect(result.launchAllowed).toBe(false);
  expect(result.settings.enabledPlugins).toEqual({});
  expect(() => writeNativeClaudeCollectorHooks(root)).toThrow();
});
it("refuses imported container identities and outputs inside any inspected mount", async () => {
  const f = fixture();
  await expect(
    startNativeClaudeCollector({ ...f, selection, container: { ...f.container } }),
  ).rejects.toThrow(/Exact/);
  const extra = join(f.root, "extra");
  mkdirSync(extra, { mode: 0o700 });
  fake.inspect.mockResolvedValue({ Mounts: [{ Source: f.native }, { Source: extra }] });
  await expect(
    startNativeClaudeCollector({ ...f, selection, output: join(extra, "evidence") }),
  ).rejects.toThrow(/every inspected/);
  expect(fake.pipe).not.toHaveBeenCalled();
});
it("captures bounded raw snapshots privately, exports sanitized evidence and awaits exact stop", async () => {
  const f = await start();
  await send(
    f,
    hook(1, "SessionStart", {
      source: "startup",
      prompt: "fixture-secret",
      transcript_path: "/owner/never-open",
    }),
  );
  await send(f, end(1, ["root-transcript-not-yet-present"]));
  await send(f, hook(2, "UserPromptSubmit"));
  await send(f, transcript(2, assistant));
  await send(f, end(2));
  await send(f, hook(3, "Stop"));
  await send(f, transcript(3, assistant));
  await send(f, end(3));
  const report = await f.collector.close();
  expect(report).toMatchObject({
    observedTokens: 20,
    complete: false,
    authoritative: false,
    launchAllowed: false,
    containmentStopConfirmed: true,
    status: "stopped",
  });
  expect(fake.stop).toHaveBeenCalledOnce();
  const log = readFileSync(join(f.output, "observations.jsonl"), "utf8");
  expect(log).not.toContain("fixture-secret");
  expect(log).not.toContain("/owner/never-open");
  expect(log).not.toContain("fixture private transcript body");
  const files = readdirSync(f.output).filter((name) => name.startsWith("transcript-"));
  expect(files).toHaveLength(1);
  expect(readFileSync(join(f.output, files[0]!), "utf8")).toBe(assistant);
  const rows = log
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(rows[1].previous).toBe(rows[0].sha256);
  f.child.stdout.write(JSON.stringify(hook(4, "UserPromptSubmit")) + "\n");
  await tick();
  expect(readFileSync(join(f.output, "observations.jsonl"), "utf8")).toBe(log);
});
it("rejects changed process lifetime before persisting the offending observation", async () => {
  const f = await start();
  await send(f, hook(1, "SessionStart", { source: "startup" }));
  await send(f, end(1));
  f.child.stdout.write(
    JSON.stringify({ ...hook(2, "UserPromptSubmit"), root: { ...rootBinding, startTicks: "999" } }) + "\n",
  );
  await vi.waitFor(() => expect(fake.stop).toHaveBeenCalledOnce());
  const report = await f.collector.close();
  expect(report).toMatchObject({ observedTokens: null, status: "failed", containmentStopConfirmed: true });
  expect(readFileSync(join(f.output, "observations.jsonl"), "utf8")).not.toContain('"startTicks":"999"');
});
it("rejects transcript inode changes and rewritten prefixes before retention", async () => {
  for (const changed of [
    transcript(2, assistant, { inode: 9 }),
    transcript(2, assistant.replace("private", "changed")),
  ]) {
    const f = await start();
    await send(f, hook(1, "SessionStart", { source: "startup" }));
    await send(f, transcript(1, assistant));
    await send(f, end(1));
    await send(f, hook(2, "UserPromptSubmit"));
    f.child.stdout.write(JSON.stringify(changed) + "\n");
    await vi.waitFor(() => expect(f.container.stopped).toBe(true));
    expect((await f.collector.close()).observedTokens).toBeNull();
    expect(readdirSync(f.output).filter((name) => name.startsWith("transcript-"))).toHaveLength(1);
  }
});
it("owner loss, lost helper and unsolicited queued frames stop before another capture", async () => {
  for (const kind of ["owner", "helper", "queue"]) {
    fake.owner = true;
    const f = await start();
    if (kind === "owner") {
      fake.owner = false;
      f.child.stdout.write(JSON.stringify(hook(1, "SessionStart", { source: "startup" })) + "\n");
    } else if (kind === "helper") f.child.emit("exit", 1);
    else f.child.stdout.write("{}\n{}\n");
    await vi.waitFor(() => expect(f.container.stopped).toBe(true));
    expect((await f.collector.close()).status).toBe("failed");
    expect(readdirSync(f.output)).toEqual(["observations.jsonl"]);
  }
});
it("preserves failed containment stop instead of treating collection closure as success", async () => {
  const f = await start();
  fake.stop.mockRejectedValueOnce(Error("fixture uncertain stop"));
  f.child.emit("exit", 1);
  await vi.waitFor(() => expect(fake.stop).toHaveBeenCalledOnce());
  await expect(f.collector.close()).rejects.toMatchObject({ code: "native-claude-stop-unconfirmed" });
  expect(readFileSync(join(f.output, "observations.jsonl"), "utf8")).toContain(
    '"containmentStopConfirmed":false',
  );
});
it("retains a gap when a capture ends before its batch acknowledgement", async () => {
  const f = await start();
  await send(f, hook(1, "SessionStart", { source: "startup" }));
  const report = await f.collector.close();
  expect(report.collectionIssues).toContain("capture-ended-with-partial-batch");
  expect(report.observedTokens).toBeNull();
});
it("detects append-log replacement before persisting a hook", async () => {
  const f = await start();
  const log = join(f.output, "observations.jsonl");
  rmSync(log);
  writeFileSync(log, "replaced", { mode: 0o600 });
  f.child.stdout.write(JSON.stringify(hook(1, "SessionStart", { source: "startup" })) + "\n");
  await vi.waitFor(() => expect(fake.stop).toHaveBeenCalledOnce());
  await expect(f.collector.close()).rejects.toThrow(/append log/);
  expect(readFileSync(log, "utf8")).toBe("replaced");
});

const helper = fileURLToPath(
  new URL("../../../scripts/evals/lead-native-claude-capture.py", import.meta.url),
);
function pythonFixture(source: string) {
  const root = directory();
  return execFileSync(
    "python3",
    [
      "-I",
      "-c",
      `import sys,os,json,pathlib,hashlib,unittest.mock as mock\nm={"__name__":"fixture"}\nexec(compile(pathlib.Path(sys.argv[1]).read_text(),sys.argv[1],"exec"),m)\nroot=pathlib.Path(sys.argv[2])\n${source}`,
      helper,
      root,
    ],
    { encoding: "utf8", timeout: 5000 },
  ).trim();
}
it("reads exact file handles and rejects symlinks/hardlinks/oversize source transcripts (Python filesystem fixture)", () => {
  expect(
    pythonFixture(`
p=root/'source';p.mkdir();(p/'one.jsonl').write_bytes(b'one\\n');fd=m['open_directory'](str(p))
assert m['read_snapshot'](fd,'one.jsonl')['bytes']==4
os.symlink(p/'one.jsonl',p/'link.jsonl');os.link(p/'one.jsonl',p/'hard.jsonl')
for name in ['link.jsonl','hard.jsonl']:
 try:m['read_snapshot'](fd,name)
 except (OSError,ValueError):pass
 else:raise AssertionError('untrusted file accepted')
m['MAX_FILE']=2
try:m['read_snapshot'](fd,'one.jsonl')
except ValueError:pass
else:raise AssertionError('oversize accepted')
os.close(fd);print('ok')`),
  ).toBe("ok");
});
it("detects a path replacement while the original descriptor is being read", () => {
  expect(
    pythonFixture(`
p=root/'source';p.mkdir();(p/'one.jsonl').write_bytes(b'one\\n');fd=m['open_directory'](str(p));read=os.read;changed=False
def racing_read(handle,count):
 global changed
 data=read(handle,count)
 if not changed:
  changed=True;(p/'one.jsonl').rename(p/'old.jsonl');(p/'one.jsonl').write_bytes(b'new\\n')
 return data
with mock.patch.object(os,'read',racing_read):
 try:m['read_snapshot'](fd,'one.jsonl')
 except ValueError:pass
 else:raise AssertionError('replaced path accepted')
os.close(fd);print('ok')`),
  ).toBe("ok");
});
it("binds native process argv/executable/TTY and rejects PID reuse using a fake proc tree", () => {
  expect(
    pythonFixture(`
proc=root/'proc';p=proc/'123';p.mkdir(parents=True);exe=root/'claude';exe.write_bytes(b'fake-ELF');cwd=root/'work';cwd.mkdir()
m['EXECUTABLE']=str(exe)
args=[str(exe),'--session-id','fixture'];config={'paneId':'w1:p1','cwd':str(cwd),'argv':args,'executableSha256':hashlib.sha256(exe.read_bytes()).hexdigest()}
(p/'exe').symlink_to(exe);(p/'cwd').symlink_to(cwd);(p/'environ').write_bytes(b'HERDR_PANE_ID=w1:p1\\0CLAUDE_CONFIG_DIR=/eval/control/claude/config\\0');(p/'cmdline').write_bytes(('\\0'.join(args)+'\\0').encode())
fields=['0']*20;fields[1]='1';fields[4]='7';fields[19]='99';(p/'stat').write_text('123 (fixture) '+' '.join(fields))
binding=m['verify_process'](config,proc=str(proc));assert binding['startTicks']=='99'
assert m['verify_process'](config,binding,proc=str(proc))==binding
fields[19]='100';(p/'stat').write_text('123 (fixture) '+' '.join(fields))
try:m['verify_process'](config,binding,proc=str(proc))
except ValueError:pass
else:raise AssertionError('reused PID accepted')
fields[19]='99';fields[4]='0';(p/'stat').write_text('123 (fixture) '+' '.join(fields))
try:m['verify_process'](config,proc=str(proc))
except ValueError:pass
else:raise AssertionError('headless process accepted')
print('ok')`),
  ).toBe("ok");
});
it("rejects an intermediate hook ancestor whose PID lifetime changes during peer proof", () => {
  expect(
    pythonFixture(`
class Connection:
 def getsockopt(self,*args):return m['struct'].pack('3i',124,os.getuid(),os.getgid())
reads={}
def row(pid,proc='/proc'):
 reads[pid]=reads.get(pid,0)+1
 return {124:{'pid':124,'parent':125,'tty':7,'startTicks':'10'},125:{'pid':125,'parent':123,'tty':7,'startTicks':'20' if reads[pid]==1 else '21'},123:{'pid':123,'parent':1,'tty':7,'startTicks':'99'}}[pid]
m['process_row']=row
with mock.patch.object(m['socket'],'SO_PEERCRED',17,create=True):
 try:m['peer_binding'](Connection(),{'pid':123,'startTicks':'99'})
 except ValueError:pass
 else:raise AssertionError('reused intermediate ancestor accepted')
print('ok')`),
  ).toBe("ok");
});
it("accepts exact hook ancestry while rejecting a different peer uid or root", () => {
  expect(
    pythonFixture(`
class Connection:
 uid=os.getuid()
 def getsockopt(self,*args):return m['struct'].pack('3i',124,self.uid,os.getgid())
rows={124:{'pid':124,'parent':123,'tty':7,'startTicks':'10'},123:{'pid':123,'parent':1,'tty':7,'startTicks':'99'}}
m['process_row']=lambda pid,proc='/proc':rows[pid]
with mock.patch.object(m['socket'],'SO_PEERCRED',17,create=True):
 assert m['peer_binding'](Connection(),{'pid':123,'startTicks':'99'})=={'pid':124,'startTicks':'10'}
 for conn,root_identity in [(Connection(),{'pid':123,'startTicks':'100'})]:
  try:m['peer_binding'](conn,root_identity)
  except ValueError:pass
  else:raise AssertionError('wrong root lifetime accepted')
 Connection.uid=os.getuid()+1
 try:m['peer_binding'](Connection(),{'pid':123,'startTicks':'99'})
 except ValueError:pass
 else:raise AssertionError('wrong peer uid accepted')
print('ok')`),
  ).toBe("ok");
});

it("the production runtime capability reader refuses imported executable proof JSON", async () => {
  const actual = await vi.importActual<{ nativeRuntimeEvidence(value: unknown): unknown }>(
    "../../../scripts/evals/lead-native-capability.mjs",
  );
  expect(() =>
    actual.nativeRuntimeEvidence({ binaries: { "/opt/claude/bin/claude": "c".repeat(64) } }),
  ).toThrow(/controller-origin/);
});
it("rejects oversized declared snapshots before allocating or writing them", async () => {
  const f = await start();
  await send(f, hook(1, "SessionStart", { source: "startup" }));
  f.child.stdout.write(JSON.stringify(transcript(1, "", { bytes: 16 * 1024 * 1024 + 1 })) + "\n");
  await vi.waitFor(() => expect(fake.stop).toHaveBeenCalledOnce());
  expect((await f.collector.close()).observedTokens).toBeNull();
  expect(readdirSync(f.output)).toEqual(["observations.jsonl"]);
});
it("discovers only selected root/child paths and detects a renamed project directory", () => {
  expect(
    pythonFixture(`
config_root=root/'config';project=config_root/'projects'/'-eval-tasks-lead';child=project/'session'/'subagents';child.mkdir(parents=True)
(project/'session.jsonl').write_bytes(b'root\\n');(child/'agent-child-one.jsonl').write_bytes(b'child\\n');(root/'outside.jsonl').write_bytes(b'never read')
m['CONFIG']=str(config_root);config={'cwd':'/eval/tasks/lead','sessionId':'session','transcript_path':str(root/'outside.jsonl')}
files,gaps=m['snapshots'](config);assert gaps==[];assert [item['agentId'] for item in files]==[None,'child-one'];assert [item['bytes'] for item in files]==[5,6]
original=m['read_snapshot'];changed=False
def racing_read(directory,name):
 global changed
 value=original(directory,name)
 if not changed:
  changed=True;project.rename(project.parent/'old');project.mkdir();(project/'session.jsonl').write_bytes(b'other\\n')
 return value
m['read_snapshot']=racing_read
try:m['snapshots'](config)
except ValueError:pass
else:raise AssertionError('renamed project directory accepted')
print('ok')`),
  ).toBe("ok");
});
it("a stalled helper heartbeat revokes capture even while the owner stays attached", async () => {
  const f = await start();
  await send(f, hook(1, "SessionStart", { source: "startup" }));
  await send(f, end(1));
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 6000);
  try {
    await vi.waitFor(() => expect(fake.stop).toHaveBeenCalledOnce(), { timeout: 2000 });
    const report = await f.collector.close();
    expect(report.collectionIssues).toContain("capture-heartbeat-stalled");
    expect(report).toMatchObject({
      status: "failed",
      authoritative: false,
      complete: false,
      observedTokens: null,
    });
  } finally {
    clock.mockRestore();
  }
});
