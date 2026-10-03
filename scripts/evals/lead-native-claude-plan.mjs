/** Controller-side preparation only. No process, credential import or image build occurs here. */
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { LeadContainer } from "./lead-containment.mjs";
import { nativeClaudeArmReadiness } from "./lead-native-claude.mjs";
const HEX = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
function directory(path) {
  if (resolve(path) !== path || realpathSync(path) !== path)
    throw Error("Canonical controller path required");
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077)
    throw Error("Private controller-owned directory required");
}
function binary(path, expected) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid() ||
      stat.size < 4 ||
      stat.size > 512 * 1024 * 1024 ||
      stat.mode & 0o022
    )
      throw Error("Bounded owned native artifact required");
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(65536);
    let offset = 0;
    while (offset < stat.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (!count) throw Error("Native artifact changed while reading");
      if (!offset && !buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])))
        throw Error("Linux native ELF artifact required");
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(fd),
      named = lstatSync(path);
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      named.dev !== stat.dev ||
      named.ino !== stat.ino ||
      named.isSymbolicLink() ||
      hash.digest("hex") !== expected
    )
      throw Error("Pinned native artifact changed");
    return { sha256: expected, bytes: stat.size };
  } finally {
    closeSync(fd);
  }
}

/** A reviewable launch specification, NOT a runtime capability or authorized launch. */
export function prepareNativeClaudePlan({
  root,
  image,
  executableSha256,
  version,
  sessionId,
  model,
  workerModel,
  workerCount,
}) {
  directory(root);
  directory(join(root, "control"));
  directory(join(root, "tasks"));
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(image) ||
    !HEX.test(executableSha256) ||
    !/^2\.1\.[0-9]+$/u.test(version) ||
    !UUID.test(sessionId) ||
    !Number.isSafeInteger(workerCount) ||
    workerCount < 1 ||
    workerCount > 6
  )
    throw Error("Exact pinned Claude image/artifact/session and bounded workers required");
  for (const value of [model, workerModel])
    if (typeof value !== "string" || !/^claude-[a-zA-Z0-9.-]{1,128}$/u.test(value))
      throw Error("Explicit Claude model selection required");
  directory(join(root, "control", "artifacts"));
  const artifact = binary(join(root, "control", "artifacts", "claude"), executableSha256);
  const indexes = new Set();
  const allocations = Array.from({ length: workerCount + 1 }, (_, i) => {
    const key = i ? `worker-${i}` : "lead",
      path = join(root, "tasks", key);
    directory(path);
    directory(join(path, ".git"));
    const index = join(path, ".git", "index"),
      stat = lstatSync(index);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid() ||
      realpathSync(index) !== index ||
      indexes.has(`${stat.dev}:${stat.ino}`)
    )
      throw Error("Independent regular native index required");
    // Linked worktrees and shared object storage must not silently masquerade as isolated clones.
    for (const file of ["commondir", "objects/info/alternates"]) {
      try {
        lstatSync(join(path, ".git", file));
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      throw Error("Shared native repository storage refused");
    }
    indexes.add(`${stat.dev}:${stat.ino}`);
    return {
      key,
      hostCwd: path,
      containerCwd: `/eval/tasks/${key}`,
      index: { device: stat.dev, inode: stat.ino },
    };
  });
  const control = join(root, "control", "claude");
  // One-shot fresh directories: never reuse a prior Claude home, plugins or transcript tree.
  mkdirSync(control, { mode: 0o700 });
  for (const name of ["home", "config", "tmp"]) mkdirSync(join(control, name), { mode: 0o700 });
  const settings = {
    disableAllHooks: true,
    enabledPlugins: {},
    permissions: { defaultMode: "default", deny: ["mcp__*", "WebFetch", "WebSearch"] },
  };
  const agents = {
    worker: {
      description: "Implement one delegated portion of the task in an isolated worktree.",
      prompt: "Work on the assigned portion and report the result to the parent session.",
      model: workerModel,
      effort: "medium",
      isolation: "worktree",
      tools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep"],
    },
  };
  const environment = {
    PATH: "/opt/claude/bin:/usr/local/bin:/usr/bin:/bin",
    HOME: "/eval/control/claude/home",
    CLAUDE_CONFIG_DIR: "/eval/control/claude/config",
    TMPDIR: "/eval/control/claude/tmp",
    HERDR_SOCKET_PATH: "/eval/control/herdr.sock",
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
  };
  const argv = [
    "/opt/claude/bin/claude",
    "--restricted",
    "--setting-sources",
    "",
    "--settings",
    "/eval/control/claude/settings.json",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--session-id",
    sessionId,
    "--model",
    model,
    "--effort",
    "medium",
    "--tools",
    "Bash,Read,Edit,Write,Glob,Grep,Agent",
    "--agents",
    JSON.stringify(agents),
  ];
  writeFileSync(join(control, "settings.json"), JSON.stringify(settings, null, 2) + "\n", {
    flag: "wx",
    mode: 0o400,
  });
  const plan = {
    schemaVersion: 1,
    image,
    artifact: { ...artifact, declaredVersion: version, versionVerified: false },
    sessionId,
    cwd: allocations[0].containerCwd,
    allocations,
    environment,
    argv,
    settings,
    interactive: true,
    launchAllowed: false,
    readiness: nativeClaudeArmReadiness(),
    limitations: [
      "CLI flags are a prepared configuration, not proof of effective native behavior or sandbox isolation.",
      "Native worktree creation is not yet bound to the preallocated independent indexes; launch remains refused.",
      "Image digest and executable hash are selected inputs, not a built/probed Claude runtime capability.",
      "Project customizations and managed settings require image/workspace sanitization and effective-config proof before launch.",
    ],
  };
  writeFileSync(join(control, "launch-plan.json"), JSON.stringify(plan, null, 2) + "\n", {
    flag: "wx",
    mode: 0o400,
  });
  return plan;
}

/** Container-wide stop, never a root-only /stop or SubagentStop acknowledgement. */
export async function stopNativeClaudeArm(container, reason) {
  if (!(container instanceof LeadContainer)) throw Error("Exact owned LeadContainer required");
  try {
    const receipt = await container.stop(reason);
    if (receipt.stopped !== true || receipt.containerId !== container.id)
      throw Error("Exact Claude container stop unconfirmed");
    return receipt;
  } catch (cause) {
    const error = new Error("Claude descendant containment stop unconfirmed", { cause });
    error.code = "native-claude-stop-unconfirmed";
    throw error;
  }
}
