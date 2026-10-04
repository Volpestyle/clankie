/** Controller-created Claude launch lifetime. Never imported evidence or campaign admission. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { LeadContainer } from "./lead-containment.mjs";
import { NativeOwnerAttachment } from "./lead-native-attachment.mjs";
import { nativeRuntimeEvidence } from "./lead-native-capability.mjs";
import { requireNativeClaudePlan, stopNativeClaudeArm } from "./lead-native-claude-plan.mjs";
import {
  claudeEnvironment,
  claudeSandboxArgs,
  CLAUDE,
  CLAUDE_LAUNCHER,
} from "./lead-native-claude-sandbox.mjs";
import {
  startNativeClaudeCollector,
  writeNativeClaudeCollectorHooks,
} from "./lead-native-claude-collector.mjs";
import { createHerdrWatchRunner } from "../../apps/clankie/src/captain/herdr-watch.ts";
const selections = new WeakMap();
const SOCKET = "/eval/control/herdr.sock";
const clean = (environment, argv) => [
  "/usr/bin/env",
  "-i",
  ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
  ...argv,
];

/** Pure check over controller-read kernel/API rows, never a production proof issuer. */
function claudeForegroundBinding({
  pane,
  shell,
  process,
  namespaces,
  expectedShell,
  expectedProcess,
  outerNamespaces,
}) {
  if (
    !pane ||
    pane.shell_pid !== shell.pid ||
    !isDeepStrictEqual(shell, expectedShell) ||
    process.pid !== expectedProcess.pid ||
    process.startTicks !== expectedProcess.startTicks ||
    !Number.isSafeInteger(process.pid) ||
    process.pid < 1 ||
    !/^[1-9][0-9]*$/u.test(process.startTicks) ||
    process.tty === 0 ||
    process.tty !== shell.tty ||
    process.group !== process.foreground ||
    pane.foreground_process_group_id !== process.group ||
    !pane.foreground_processes?.some((row) => row.pid === process.pid) ||
    ["pid", "mnt", "net"].some(
      (key) => typeof namespaces?.[key] !== "string" || namespaces[key] === outerNamespaces[key],
    )
  )
    throw Error("Original Claude foreground/pane/namespace binding unavailable");
  return { pid: process.pid, startTicks: process.startTicks, paneId: pane.pane_id };
}

// Pending reservations can only start a passive collector listener. Every data frame
// additionally requires the native exec/foreground check below; no pending authority.
export function nativeClaudeCollectorSelection(token, container) {
  const record = selections.get(token);
  if (!record || record.container !== container || record.stopped())
    throw Error("Controller-owned Claude launch selection required");
  return structuredClone(record.selection);
}
export async function assertNativeClaudeSelection(token, container) {
  const record = selections.get(token);
  if (!record || record.container !== container || record.stopped())
    throw Error("Controller-owned Claude launch selection required");
  await record.active;
  await record.verify();
  if (record.stopped()) throw Error("Claude launch selection expired");
}

function channel(child, fail) {
  let pending = "",
    failed,
    waiting;
  const frames = [];
  const lose = (error) => {
    failed ??= error;
    waiting?.reject(failed);
    waiting = undefined;
    void fail(error).catch(() => {});
  };
  child.stdout.on("data", (bytes) => {
    pending += bytes.toString("utf8");
    if (Buffer.byteLength(pending) > 65536) return lose(Error("Claude launch frame exceeded bound"));
    for (;;) {
      const index = pending.indexOf("\n");
      if (index < 0) break;
      const text = pending.slice(0, index);
      pending = pending.slice(index + 1);
      try {
        const value = JSON.parse(text);
        if (value.kind === "failed")
          return lose(Error("Native Claude termination unconfirmed; exact containment stop required"));
        if (waiting) {
          const next = waiting;
          waiting = undefined;
          next.resolve(value);
        } else if (frames.length < 2) frames.push(value);
        else return lose(Error("Unsolicited Claude launch frames"));
      } catch {
        return lose(Error("Malformed Claude launch frame"));
      }
    }
  });
  child.once("error", lose);
  child.once("exit", () => lose(Error("Claude launch controller lost")));
  child.stdin.on("error", lose);
  child.stdout.on("error", lose);
  child.stderr.on("data", () => {});
  return {
    async read() {
      if (failed) throw failed;
      if (frames.length) return frames.shift();
      if (waiting) throw Error("Concurrent Claude launch reads refused");
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          waiting = { resolve, reject };
          timer = setTimeout(() => lose(Error("Claude launch handshake timed out")), 5000);
        });
      } finally {
        clearTimeout(timer);
      }
    },
    send(value) {
      if (failed || child.exitCode !== null || child.signalCode !== null)
        throw Error("Claude launch pipe unavailable");
      const line = JSON.stringify(value) + "\n";
      if (Buffer.byteLength(line) > 65536) throw Error("Claude launch request exceeds bound");
      child.stdin.write(line);
    },
  };
}

/** Builds the real isolated controller path, without creating or launching anything here. */
export function createNativeClaudeRuntime({ container, ownerAttachment, plan }) {
  if (
    !(container instanceof LeadContainer) ||
    container.role !== "native" ||
    !(ownerAttachment instanceof NativeOwnerAttachment) ||
    ownerAttachment.container !== container
  )
    throw Error("Exact native Claude container and owner attachment required");
  const selected = requireNativeClaudePlan(plan, container);
  const capability = nativeRuntimeEvidence(container.capability);
  if (
    capability.runtime !== "claude" ||
    capability.binaries?.[CLAUDE] !== selected.artifact.sha256 ||
    capability.version !== `${selected.artifact.declaredVersion} (Claude Code)` ||
    ownerAttachment.herdrSha256 !== capability.binaries["/usr/local/bin/herdr"] ||
    !isDeepStrictEqual(capability.policy, claudeSandboxArgs({ hooks: true }))
  )
    throw Error("Earned Claude image/control capability required");
  const control = join(container.root, "control");
  mkdirSync(join(control, "home"), { mode: 0o700 });
  mkdirSync(join(control, "herdr-config"), { mode: 0o700 });
  mkdirSync(join(control, "herdr-config/herdr"), { mode: 0o700 });
  mkdirSync(join(control, "herdr-state"), { mode: 0o700 });
  mkdirSync(join(control, "claude/launch"), { mode: 0o700 });
  writeFileSync(
    join(control, "herdr-config/herdr/config.toml"),
    `[terminal]\ndefault_shell = "${CLAUDE_LAUNCHER}"\nshell_mode = "non_login"\n`,
    { mode: 0o400, flag: "wx" },
  );
  const hooks = writeNativeClaudeCollectorHooks(container.root);
  const environment = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: "/eval/control/home",
    XDG_CONFIG_HOME: "/eval/control/herdr-config",
    XDG_STATE_HOME: "/eval/control/herdr-state",
    HERDR_SOCKET_PATH: SOCKET,
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
  };
  const herdr = (args) =>
    container.exec(clean(environment, ["/usr/local/bin/herdr", ...args]), { timeoutMs: 5000 });
  const runner = createHerdrWatchRunner(() => !container.stopped, herdr);
  let started = false,
    launched = false,
    stopped = false,
    stopping,
    child,
    timer,
    collector;
  const stop = (reason) => {
    stopped = true;
    clearInterval(timer);
    stopping ??= stopNativeClaudeArm(container, reason).finally(() => child?.kill());
    return stopping;
  };
  const owner = async () => {
    if (stopped || container.stopped || !(await ownerAttachment.attached(container.id, SOCKET)))
      throw Error("Exact Claude owner attachment lost");
  };
  return {
    readiness: {
      launchAllowed: false,
      vendorProvenance: false,
      providerAdmission: false,
      childRouting: false,
      network: "denied",
    },
    async startHerdr() {
      if (started || stopped) throw Error("Claude Herdr controller can start once");
      started = true;
      try {
        await container.exec(clean(environment, ["/usr/local/bin/herdr", "server"]), { detached: true });
      } catch (error) {
        await stop("Claude Herdr startup failed");
        throw error;
      }
    },
    /** Explicit future native TUI startup only. No prompt, account import, provider or eval dispatch. */
    async launch({ output }) {
      if (!started || launched || stopped) throw Error("Claude root can be allocated once");
      launched = true;
      let activate, rejectActive;
      const active = new Promise((resolve, reject) => {
        activate = resolve;
        rejectActive = reject;
      });
      void active.catch(() => {});
      try {
        await owner();
        const paneId = await runner.createTab({
          cwd: selected.cwd,
          label: "Native Claude (network held)",
          env: environment,
        });
        const processInfo = async () => {
          const pane = JSON.parse(await herdr(["pane", "process-info", "--pane", paneId])).result
            ?.process_info;
          if (pane?.pane_id !== paneId) throw Error("Selected Claude pane disappeared");
          return pane;
        };
        const inspectShell = (pid) =>
          container
            .exec(["/usr/bin/env", "-i", "/usr/bin/python3", "-I", CLAUDE_LAUNCHER, "inspect", String(pid)], {
              timeoutMs: 5000,
            })
            .then(JSON.parse);
        const initialPane = await processInfo();
        child = await container.pipe([
          "/usr/bin/env",
          "-i",
          "/usr/bin/python3",
          "-I",
          "-u",
          CLAUDE_LAUNCHER,
          "client",
          paneId,
        ]);
        const port = channel(child, () => stop("Claude launch control lost"));
        const peer = await port.read(),
          hello = await port.read();
        if (
          peer.kind !== "peer" ||
          hello.kind !== "shell" ||
          peer.pid !== initialPane.shell_pid ||
          hello.shell.pid !== peer.pid ||
          !isDeepStrictEqual(await inspectShell(peer.pid), hello.shell)
        )
          throw Error("Herdr shell does not own the launch socket");
        const argv = [...selected.argv];
        argv[argv.indexOf("--settings") + 1] = hooks.settingsPath;
        const selection = {
          paneId,
          cwd: selected.cwd,
          sessionId: selected.sessionId,
          argv,
          executableSha256: selected.artifact.sha256,
        };
        port.send({
          op: "launch",
          selection,
          sandbox: claudeSandboxArgs({ hooks: true }),
          environment: claudeEnvironment({ paneId }),
        });
        const held = await port.read();
        const heldPane = await processInfo();
        if (
          held.kind !== "held" ||
          !isDeepStrictEqual(held.shell, hello.shell) ||
          heldPane.shell_pid !== peer.pid ||
          !isDeepStrictEqual(await inspectShell(peer.pid), hello.shell) ||
          held.launcher.parent !== peer.pid ||
          held.process.parent !== held.launcher.pid ||
          !/^[1-9][0-9]*$/u.test(held.process.startTicks)
        )
          throw Error("Original held Claude child unavailable");
        selection.launchPid = held.process.pid;
        selection.launchStartTicks = held.process.startTicks;
        const token = Object.freeze({ kind: "controller-created-native-claude" });
        let native, checking;
        const outerNamespaces = JSON.parse(
          await container.exec(
            [
              "/usr/bin/python3",
              "-I",
              "-c",
              "import os,json;print(json.dumps({k:os.readlink('/proc/self/ns/'+k) for k in ('pid','mnt','net')}))",
            ],
            { timeoutMs: 5000 },
          ),
        );
        const check = async (observation) => {
          await owner();
          const pane = await processInfo();
          const shell = await inspectShell(peer.pid);
          claudeForegroundBinding({
            pane,
            shell,
            process: observation.process,
            namespaces: observation.namespaces,
            expectedShell: hello.shell,
            expectedProcess: held.process,
            outerNamespaces,
          });
          if (
            observation.kind !== "running" ||
            observation.root.pid !== held.process.pid ||
            observation.root.startTicks !== held.process.startTicks ||
            observation.root.executableSha256 !== selection.executableSha256 ||
            observation.process.parent !== held.launcher.pid ||
            (native && !isDeepStrictEqual(native, observation))
          )
            throw Error("Original Claude native lifetime changed");
          const finalPane = await processInfo();
          if (!isDeepStrictEqual(pane, finalPane) || !isDeepStrictEqual(await inspectShell(peer.pid), shell))
            throw Error("Claude foreground changed during observation");
          native ??= structuredClone(observation);
        };
        const verify = () =>
          (checking ??= (async () => {
            try {
              await active;
              port.send({ op: "observe" });
              await check(await port.read());
              port.send({ op: "observe" });
              if (!isDeepStrictEqual(await port.read(), native))
                throw Error("Claude changed after foreground reads");
            } catch (error) {
              await stop("Claude native binding lost");
              throw error;
            } finally {
              checking = undefined;
            }
          })());
        selections.set(token, {
          container,
          selection: structuredClone(selection),
          active,
          verify,
          stopped: () => stopped || container.stopped,
        });
        collector = await startNativeClaudeCollector({
          container,
          ownerAttachment,
          selection: token,
          output,
        });
        await owner();
        port.send({ op: "release" });
        await check(await port.read());
        activate();
        timer = setInterval(() => {
          void verify().catch(() => {});
        }, 1000);
        return Object.freeze({
          selection: token,
          collector,
          launchAllowed: false,
          vendorProvenance: false,
          providerAdmission: false,
          childRouting: false,
          stop,
        });
      } catch (error) {
        rejectActive(error);
        try {
          await stop("Claude native startup failed");
        } catch (stopError) {
          throw new AggregateError([error, stopError], "Claude startup containment unconfirmed");
        }
        throw error;
      }
    },
    stop,
  };
}
