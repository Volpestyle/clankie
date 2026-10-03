/** Protected retention for native observations; never a launch/account/budget authority. */
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { LeadContainer } from "./lead-containment.mjs";
import { NativeOwnerAttachment } from "./lead-native-attachment.mjs";
import { nativeRuntimeEvidence } from "./lead-native-capability.mjs";
import { NativeClaudeObservation } from "./lead-native-claude-observation.mjs";
import { stopNativeClaudeArm } from "./lead-native-claude-plan.mjs";

const SOURCE = readFileSync(new URL("./lead-native-claude-capture.py", import.meta.url), "utf8");
const SOCKET = "/eval/control/claude/collector/hooks.sock";
const CONTROL = "/eval/control/claude/collector";
const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "StopFailure",
  "SessionEnd",
];
const MAX_FRAME = 24 * 1024 * 1024,
  MAX_RETAINED = 64 * 1024 * 1024;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ID = /^[A-Za-z0-9_-]{1,128}$/u,
  HEX = /^[a-f0-9]{64}$/u;
const HOOK = `import socket,sys\nraw=sys.stdin.buffer.read(65537)\nif len(raw)>65536:sys.exit(2)\ns=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)\ns.settimeout(15)\ns.connect(${JSON.stringify(SOCKET)})\ns.sendall(raw)\ns.shutdown(socket.SHUT_WR)\nif s.recv(3)!=b"ok\\n":sys.exit(2)\ns.close()\n`;

function privateDirectory(path) {
  if (resolve(path) !== path || realpathSync(path) !== path)
    throw Error("Canonical collector directory required");
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077)
    throw Error("Private controller directory required");
  return { device: stat.dev, inode: stat.ino };
}
function overlap(a, b) {
  const inside = (parent, child) => {
    const path = relative(parent, child);
    return path === "" || (path !== ".." && !path.startsWith("../") && !path.startsWith("/"));
  };
  return inside(a, b) || inside(b, a);
}
function exactKeys(value, names) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((name) => !names.includes(name))
  )
    throw Error("Unexpected capture frame");
}
function decoded(frame, limit) {
  if (
    !Number.isSafeInteger(frame.bytes) ||
    frame.bytes < 0 ||
    frame.bytes > limit ||
    typeof frame.data !== "string" ||
    frame.data.length > Math.ceil(limit / 3) * 4 ||
    !HEX.test(frame.sha256)
  )
    throw Error("Unbounded capture bytes");
  const bytes = Buffer.from(frame.data, "base64");
  if (bytes.length !== frame.bytes || bytes.toString("base64") !== frame.data || hash(bytes) !== frame.sha256)
    throw Error("Capture bytes/hash mismatch");
  return bytes;
}

/** Writes only collector hook configuration. A future verified runtime must select it explicitly. */
export function writeNativeClaudeCollectorHooks(root) {
  privateDirectory(root);
  privateDirectory(join(root, "control"));
  privateDirectory(join(root, "control/claude"));
  const directory = join(root, "control/claude/collector");
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, "hook.py"), HOOK, { flag: "wx", mode: 0o500 });
  const settings = {
    disableAllHooks: false,
    enabledPlugins: {},
    permissions: { defaultMode: "default", deny: ["mcp__*", "WebFetch", "WebSearch"] },
    hooks: Object.fromEntries(
      EVENTS.map((event) => [
        event,
        [{ hooks: [{ type: "command", command: `/usr/bin/python3 -I ${CONTROL}/hook.py`, timeout: 20 }] }],
      ]),
    ),
  };
  writeFileSync(join(directory, "settings.json"), JSON.stringify(settings, null, 2) + "\n", {
    flag: "wx",
    mode: 0o400,
  });
  return { settingsPath: `${CONTROL}/settings.json`, settings, hookSha256: hash(HOOK), launchAllowed: false };
}

/** Real runtime calls require the existing private capability through native container.pipe/inspect. */
export async function startNativeClaudeCollector({ container, ownerAttachment, selection, output }) {
  if (
    !(container instanceof LeadContainer) ||
    container.role !== "native" ||
    !(ownerAttachment instanceof NativeOwnerAttachment) ||
    ownerAttachment.container !== container ||
    !HEX.test(container.id)
  )
    throw Error("Exact created native container and owner attachment required");
  exactKeys(selection, ["paneId", "cwd", "sessionId", "argv", "executableSha256"]);
  if (
    !/^w[A-Za-z0-9]+:p[A-Za-z0-9]+$/u.test(selection.paneId) ||
    selection.cwd !== "/eval/tasks/lead" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(selection.sessionId) ||
    !HEX.test(selection.executableSha256) ||
    !Array.isArray(selection.argv) ||
    selection.argv.length > 64 ||
    selection.argv.some((arg) => typeof arg !== "string" || arg.includes("\0") || arg.length > 16384) ||
    selection.argv[0] !== "/opt/claude/bin/claude" ||
    selection.argv.some((arg) =>
      /^-p|^--(?:print|bg|background|input-format|output-format|sdk-url)(?:=|$)|^--settings=/u.test(arg),
    ) ||
    Buffer.byteLength(selection.argv.join("\0")) > 65536 ||
    selection.argv.filter((arg) => arg === "--session-id").length !== 1 ||
    selection.argv[selection.argv.indexOf("--session-id") + 1] !== selection.sessionId ||
    selection.argv.filter((arg) => arg === "--settings").length !== 1 ||
    selection.argv[selection.argv.indexOf("--settings") + 1] !== `${CONTROL}/settings.json`
  )
    throw Error("Exact interactive Claude collection selection required");
  selection = structuredClone(selection);
  const capability = nativeRuntimeEvidence(container.capability);
  if (capability.binaries?.["/opt/claude/bin/claude"] !== selection.executableSha256)
    throw Error("Private runtime capability does not bind the selected Claude executable");
  privateDirectory(dirname(output));
  const inspected = await container.inspect();
  if (
    !Array.isArray(inspected.Mounts) ||
    !inspected.Mounts.length ||
    inspected.Mounts.some(
      (mount) => typeof mount.Source !== "string" || overlap(realpathSync(mount.Source), output),
    )
  )
    throw Error("Collector output must be outside every inspected runtime mount");
  if (!(await ownerAttachment.attached(container.id, "/eval/control/herdr.sock"))) {
    await stopNativeClaudeArm(container, "Claude collection owner unavailable");
    throw Error("Exact owner attachment unavailable");
  }
  mkdirSync(output, { mode: 0o700 });
  const directoryIdentity = privateDirectory(output);
  const logPath = join(output, "observations.jsonl");
  const fd = openSync(
    logPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
    0o600,
  );
  const logIdentity = fstatSync(fd);
  let logSequence = 0,
    logBytes = 0,
    handling,
    lastHash = "0".repeat(64),
    closed = false,
    failure,
    stopping,
    stopReceipt,
    child,
    timer,
    rootBinding,
    sequence = 0,
    inBatch = false,
    processing = false,
    pending = "",
    retainedBytes = 0,
    hookCount = 0,
    lastFrameAt = Date.now(),
    transportReady = false;
  const bindingDeadline = Date.now() + 10000;
  const observed = new NativeClaudeObservation({ sessionId: selection.sessionId });
  const latest = new Map(),
    seenBatch = new Set(),
    collectionIssues = new Set();
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  const assertLive = () => {
    if (closed || stopping || container.stopped || container.signal.aborted) throw Error("Collector stopped");
  };
  const append = (type, data) => {
    if (!isDeepStrictEqual(privateDirectory(output), directoryIdentity))
      throw Error("Collector directory changed");
    const current = fstatSync(fd),
      named = lstatSync(logPath);
    if (
      !current.isFile() ||
      current.nlink !== 1 ||
      current.uid !== process.getuid() ||
      current.mode & 0o077 ||
      current.size !== logBytes ||
      current.dev !== logIdentity.dev ||
      current.ino !== logIdentity.ino ||
      named.isSymbolicLink() ||
      named.dev !== current.dev ||
      named.ino !== current.ino
    )
      throw Error("Collector append log changed");
    const entry = { sequence: ++logSequence, previous: lastHash, receivedAtMs: Date.now(), type, data };
    lastHash = hash(JSON.stringify(entry));
    const line = Buffer.from(JSON.stringify({ ...entry, sha256: lastHash }) + "\n");
    if (logSequence > 20000 || logBytes + line.length > 8 * 1024 * 1024)
      throw Error("Collector journal capacity exceeded");
    if (writeSync(fd, line) !== line.length) throw Error("Collector append incomplete");
    fsyncSync(fd);
    const directoryFd = openSync(output, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const directoryStat = fstatSync(directoryFd);
      if (directoryStat.dev !== directoryIdentity.device || directoryStat.ino !== directoryIdentity.inode)
        throw Error("Collector directory changed during append");
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
    logBytes += line.length;
  };
  const stop = (reason) => {
    if (stopping) return stopping;
    clearInterval(timer);
    rejectReady(Error("Native Claude collector stopped"));
    // Latch before awaiting any boundary operation; no event can persist after revocation.
    stopping = Promise.resolve().then(async () => {
      stopReceipt = await stopNativeClaudeArm(container, reason);
      child?.kill();
      return stopReceipt;
    });
    void stopping.catch(() => {});
    return stopping;
  };
  const lost = (code) => {
    failure ??= code;
    collectionIssues.add(code);
    return stop("native Claude collection lost");
  };
  let ownerCheck;
  const checkOwner = () => {
    if (!ownerCheck)
      ownerCheck = (async () => {
        let expiry;
        try {
          const attached = await Promise.race([
            ownerAttachment.attached(container.id, "/eval/control/herdr.sock"),
            new Promise((_, reject) => {
              expiry = setTimeout(() => reject(Error("owner proof timed out")), 2000);
            }),
          ]);
          assertLive();
          if (!attached) throw Error("owner attachment lost");
        } finally {
          clearTimeout(expiry);
          ownerCheck = undefined;
        }
      })();
    return ownerCheck;
  };
  const binding = (value) => {
    exactKeys(value, [
      "pid",
      "startTicks",
      "tty",
      "executableSha256",
      "exeDevice",
      "exeInode",
      "exeBytes",
      "exeCtimeNs",
    ]);
    if (
      !Number.isSafeInteger(value.pid) ||
      value.pid < 1 ||
      typeof value.startTicks !== "string" ||
      !/^[1-9][0-9]*$/u.test(value.startTicks) ||
      !Number.isSafeInteger(value.tty) ||
      value.tty === 0 ||
      value.executableSha256 !== selection.executableSha256 ||
      !Number.isSafeInteger(value.exeBytes) ||
      value.exeBytes < 1 ||
      value.exeBytes > 512 * 1024 * 1024 ||
      [value.exeDevice, value.exeInode, value.exeCtimeNs].some(
        (field) => typeof field !== "string" || !/^[0-9]{1,24}$/u.test(field),
      )
    )
      throw Error("Invalid native process binding");
    if (rootBinding && !isDeepStrictEqual(rootBinding, value)) throw Error("Native process lifetime changed");
    rootBinding ??= structuredClone(value);
  };
  const handle = async (frame) => {
    assertLive();
    await checkOwner();
    assertLive();
    lastFrameAt = Date.now();
    if (frame.kind !== "ready" && !transportReady) throw Error("Capture frame before ready");
    if (frame.kind === "heartbeat") {
      exactKeys(frame, ["kind", "root"]);
      if (frame.root) binding(frame.root);
      else if (rootBinding) throw Error("Native process binding disappeared");
      child.stdin.write('{"ack":true}\n');
      return;
    }
    if (frame.kind === "ready") {
      exactKeys(frame, ["kind"]);
      if (rootBinding || logSequence) throw Error("Repeated capture ready");
      append("collector", {
        containerId: container.id,
        image: container.image,
        sourceSha256: hash(SOURCE),
        selectionSha256: hash(JSON.stringify(selection)),
        launchAllowed: false,
      });
      transportReady = true;
      resolveReady();
      child.stdin.write('{"ack":true}\n');
      return;
    }
    if (frame.kind === "hook") {
      exactKeys(frame, ["kind", "sequence", "root", "peer", "data", "bytes", "sha256"]);
      if (inBatch || frame.sequence !== sequence + 1 || ++hookCount > 10000)
        throw Error("Hook sequence/coverage changed");
      binding(frame.root);
      exactKeys(frame.peer, ["pid", "startTicks"]);
      if (
        !Number.isSafeInteger(frame.peer.pid) ||
        frame.peer.pid < 1 ||
        typeof frame.peer.startTicks !== "string" ||
        !/^[1-9][0-9]*$/u.test(frame.peer.startTicks)
      )
        throw Error("Invalid hook peer binding");
      const bytes = decoded(frame, 65536),
        event = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!EVENTS.includes(event?.hook_event_name) || event.session_id !== selection.sessionId)
        throw Error("Unsupported or mismatched native hook");
      const record = observed.observe(event);
      append("hook", { process: frame.root, peer: frame.peer, observation: record });
      sequence = frame.sequence;
      inBatch = true;
      seenBatch.clear();
    } else if (frame.kind === "snapshot") {
      exactKeys(frame, ["kind", "sequence", "root", "agentId", "bytes", "sha256", "device", "inode", "data"]);
      binding(frame.root);
      if (
        !inBatch ||
        frame.sequence !== sequence ||
        (frame.agentId !== null && (typeof frame.agentId !== "string" || !ID.test(frame.agentId))) ||
        seenBatch.has(frame.agentId) ||
        seenBatch.size >= 33 ||
        !Number.isSafeInteger(frame.device) ||
        frame.device < 0 ||
        !Number.isSafeInteger(frame.inode) ||
        frame.inode < 1
      )
        throw Error("Snapshot identity/sequence mismatch");
      const bytes = decoded(frame, 16 * 1024 * 1024),
        prior = latest.get(frame.agentId);
      if (
        prior &&
        (prior.device !== frame.device ||
          prior.inode !== frame.inode ||
          bytes.length < prior.bytes.length ||
          !bytes.subarray(0, prior.bytes.length).equals(prior.bytes))
      )
        throw Error("Captured transcript prefix/lifetime changed");
      seenBatch.add(frame.agentId);
      if (!prior || prior.sha256 !== frame.sha256) {
        if (retainedBytes + bytes.length > MAX_RETAINED) throw Error("Retained capture capacity exceeded");
        const name = `transcript-${logSequence + 1}-${frame.agentId ?? "root"}.jsonl`;
        if (!isDeepStrictEqual(privateDirectory(output), directoryIdentity))
          throw Error("Collector directory changed");
        const outputFile = join(output, name);
        const snapshotFd = openSync(
          outputFile,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          writeFileSync(snapshotFd, bytes);
          fsyncSync(snapshotFd);
        } finally {
          closeSync(snapshotFd);
        }
        append("transcript", {
          agentId: frame.agentId,
          bytes: bytes.length,
          sha256: frame.sha256,
          file: name,
          device: frame.device,
          inode: frame.inode,
          process: frame.root,
        });
        retainedBytes += bytes.length;
        latest.set(frame.agentId, { bytes, sha256: frame.sha256, device: frame.device, inode: frame.inode });
      }
    } else if (frame.kind === "batch-end") {
      exactKeys(frame, ["kind", "sequence", "root", "gaps"]);
      binding(frame.root);
      if (
        !inBatch ||
        frame.sequence !== sequence ||
        !Array.isArray(frame.gaps) ||
        frame.gaps.some((gap) => gap !== "root-transcript-not-yet-present") ||
        frame.gaps.length > 1
      )
        throw Error("Capture batch mismatch");
      for (const agentId of latest.keys())
        if (!seenBatch.has(agentId)) throw Error("Previously captured transcript disappeared");
      append("batch", { sequence, snapshots: seenBatch.size, gaps: frame.gaps });
      inBatch = false;
    } else throw Error("Unknown capture frame");
    assertLive();
    child.stdin.write('{"ack":true}\n');
  };
  try {
    const parentFd = openSync(
      dirname(output),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(parentFd);
    } finally {
      closeSync(parentFd);
    }
    child = await container.pipe([
      "/usr/bin/env",
      "-i",
      "/usr/bin/python3",
      "-I",
      "-u",
      "-c",
      SOURCE,
      JSON.stringify(selection),
    ]);
    child.stdout.on("data", (chunk) => {
      if (stopping) return;
      pending += chunk.toString("utf8");
      if (Buffer.byteLength(pending) > MAX_FRAME || (processing && pending.includes("\n"))) {
        void lost("capture-frame-or-queue-overflow").catch(() => {});
        return;
      }
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (pending.length || processing) {
        void lost("unsolicited-capture-frame").catch(() => {});
        return;
      }
      processing = true;
      handling = Promise.resolve()
        .then(() => handle(JSON.parse(line)))
        .catch(() => lost("capture-observation-rejected"))
        .catch(() => {})
        .finally(() => {
          processing = false;
        });
    });
    child.stdout.on("error", () => {
      if (!stopping) void lost("capture-output-lost").catch(() => {});
    });
    child.stdin.on("error", () => {
      if (!stopping) void lost("capture-input-lost").catch(() => {});
    });
    child.stderr.on("data", () => {}); // Fixed helper errors only; never publish runtime output as evidence.
    child.once("error", () => {
      if (!stopping) void lost("capture-process-error").catch(() => {});
    });
    child.once("exit", () => {
      if (!stopping) void lost("capture-process-exited").catch(() => {});
    });
    timer = setInterval(() => {
      if (!rootBinding && Date.now() > bindingDeadline) {
        void lost("native-process-binding-unavailable").catch(() => {});
        return;
      }
      if (Date.now() - lastFrameAt > 5000) {
        void lost("capture-heartbeat-stalled").catch(() => {});
        return;
      }
      void checkOwner()
        .catch(() => lost("owner-attachment-lost"))
        .catch(() => {});
    }, 1000);
    let expiry;
    try {
      await Promise.race([
        ready,
        new Promise((_, reject) => {
          expiry = setTimeout(() => reject(Error("capture startup timed out")), 5000);
        }),
      ]);
    } finally {
      clearTimeout(expiry);
    }
  } catch (error) {
    try {
      await lost("capture-startup-unavailable");
    } finally {
      closeSync(fd);
      closed = true;
    }
    throw error;
  }
  let final;
  return Object.freeze({
    /** Closes collection and the exact containment boundary; no report can claim live success. */
    async close() {
      if (final) return final;
      final = (async () => {
        let stopError;
        try {
          await stop("native Claude collector closed");
        } catch (error) {
          stopError = error;
          collectionIssues.add("containment-stop-unconfirmed");
        }
        if (handling) await handling;
        if (inBatch || pending.length) collectionIssues.add("capture-ended-with-partial-batch");
        for (const [agentId, snapshot] of latest) observed.transcript(snapshot.bytes, agentId);
        const observation = observed.seal();
        const report = {
          ...observation,
          observedTokens: collectionIssues.size ? null : observation.observedTokens,
          collectionIssues: [...collectionIssues],
          process: rootBinding ?? null,
          containerId: container.id,
          capturedBytes: retainedBytes,
          containmentStopConfirmed: stopReceipt?.stopped === true,
          launchAllowed: false,
          status: stopError ? "stop-unconfirmed" : failure ? "failed" : "stopped",
          appendLogSha256: lastHash,
        };
        try {
          append("sealed", report);
        } finally {
          closeSync(fd);
          closed = true;
        }
        if (stopError) throw stopError;
        return report;
      })();
      return final;
    },
    // No proof token, override flag or budget authority is exposed by this handle.
    evidence: () => ({
      containerId: container.id,
      process: structuredClone(rootBinding ?? null),
      failed: !!failure,
      stopped: !!stopping,
      capturedBytes: retainedBytes,
      launchAllowed: false,
      authoritative: false,
      complete: false,
    }),
  });
}
