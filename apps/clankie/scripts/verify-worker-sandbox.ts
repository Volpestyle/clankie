// ON HOLD (2026-10-26): do not run without the lead's approval of an isolation plan.
// Its panes kept the owner's HOME while inheriting a scratch XDG_DATA_HOME, and Claude
// Code's updater then repointed the owner's ~/.local/bin/claude at the scratch root.
//
// Native proof for VUH-2592 (manual; not part of any check). In a scratch Herdr it opens
// hire panes through the real hire layout with the environment a local hire gets,
// starts the real Claude Code and Codex there with `herdr agent start`, and starts a
// Codex app-server through the real launcher. Then it checks, from outside, which
// files the kernel lets each of those processes read.
//
// Stores are scratch: a protected keychain and its password keychain under /private/tmp
// and a file broker holding a freshly minted token. The owner's Keychain items, live
// service and ~/.clankie are untouched; the harnesses sign in with their own accounts.
//
//   clankie heavy -- pnpm --filter @clankie/clankie exec tsx scripts/verify-worker-sandbox.ts [--dry-run] [OUT_DIR]
//
// The scratch Herdr server gets its own HOME and XDG roots. A server that finds the
// owner's session restores it and resumes their agents (2026-10-26), so the script
// refuses unless the session path it resolves is scratch, and stops if the server
// restored anything. --dry-run checks that and exits before any server starts.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  mintOperatorToken,
  protectOperatorCredential,
  resolveOperatorCredential,
} from "@clankie/credential-broker";
import { MAXIMUM_TRUST_CODEX_CONFIG } from "@clankie/protocol";
import { localCodexServer } from "../src/captain/codex-app-server.ts";
import { createHireLayout } from "../src/captain/hire-layout.ts";
import { createWorkerSandbox, WORKER_PANE_ENV } from "../src/worker-sandbox.ts";

const exec = promisify(execFile);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const checkout = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/u, "");
const dryRun = process.argv.includes("--dry-run");
const out =
  process.argv.slice(2).find((arg) => arg !== "--dry-run") ?? join(checkout, ".local/vuh-2592-proof");
const helper = join(checkout, "packages/credential-broker/src/protected-keychain.py");
const root = await mkdtemp("/private/tmp/clankie-ws-e2e-");
const cleanup: (() => Promise<unknown>)[] = [];
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), checkout };
// The owner's Herdr session must be untouched by this run.
const ownerSession = join(userInfo().homedir, ".config/herdr/session.json");
const ownerSessionBefore = await stat(ownerSession).then(
  (entry) => entry.mtimeMs,
  () => undefined,
);

async function shell(command: string, args: readonly string[], env?: NodeJS.ProcessEnv) {
  try {
    return (await exec(command, args, { env, timeout: 20_000, maxBuffer: 4_000_000 })).stdout;
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string };
    throw new Error(
      `${command} ${args.join(" ")}: ${failed.message} ${failed.stdout ?? ""} ${failed.stderr ?? ""}`,
    );
  }
}

try {
  // Scratch stores: the owner's terminal moves a minted token into the protected keychain.
  const clankieEnv = {
    CLANKIE_PROTECTED_KEYCHAIN: join(root, "clankie.keychain-db"),
    CLANKIE_PROTECTED_KEYCHAIN_PASSWORDS: join(root, "passwords.keychain-db"),
    CLANKIE_CREDENTIALS_FILE: join(root, "credentials.json"),
    // The panes' Clankie integrations find no live service in this state home.
    CLANKIE_STATE: join(root, "clankie-state"),
  };
  await mkdir(clankieEnv.CLANKIE_STATE, { recursive: true });
  const created = spawn("/usr/bin/python3", [helper], { stdio: ["pipe", "ignore", "inherit"] });
  created.stdin.end(
    JSON.stringify({
      op: "create",
      keychain: clankieEnv.CLANKIE_PROTECTED_KEYCHAIN_PASSWORDS,
      password: "scratch",
    }),
  );
  await new Promise((resolve) => created.on("close", resolve));
  const token = mintOperatorToken();
  await writeFile(
    clankieEnv.CLANKIE_CREDENTIALS_FILE,
    JSON.stringify({ clankie_operator: { type: "api", key: token } }),
    {
      mode: 0o600,
    },
  );
  const ownerEnv = { ...process.env, ...clankieEnv };
  report.protect = await protectOperatorCredential({ env: ownerEnv });
  const owner = await resolveOperatorCredential({ env: ownerEnv });
  report.ownerResolves = { source: owner?.source, matchesMinted: owner?.token === token };

  // A path checker for other processes: sandbox_check(2) is variadic, so it is C, not ctypes.
  const checker = join(root, "sandbox-check");
  await writeFile(
    `${checker}.c`,
    `#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
int sandbox_check(pid_t pid, const char *operation, int type, ...);
int main(int argc, char **argv) {
  pid_t pid = atoi(argv[1]);
  printf("{\\"sandboxed\\":%d,\\"denied\\":{", sandbox_check(pid, NULL, 0));
  for (int i = 2; i < argc; i++)
    printf("%s\\"%s\\":%d", i > 2 ? "," : "", argv[i], sandbox_check(pid, "file-read-data", 1 | 0x40000000, argv[i]));
  printf("}}\\n");
  return 0;
}
`,
  );
  await shell("/usr/bin/cc", ["-o", checker, `${checker}.c`]);
  const home = userInfo().homedir;
  const paths = {
    protectedKeychain: clankieEnv.CLANKIE_PROTECTED_KEYCHAIN,
    fileBroker: clankieEnv.CLANKIE_CREDENTIALS_FILE,
    checkoutEnvLocal: join(checkout, ".env.local"),
    pinnedEnvLocal: join(home, ".clankie/pinned/.env.local"),
    loginKeychain: join(home, "Library/Keychains/login.keychain-db"),
    ordinaryFile: join(checkout, "README.md"),
  };
  const check = async (pid: number) => {
    const result = JSON.parse(await shell(checker, [String(pid), ...Object.values(paths)])) as {
      sandboxed: number;
      denied: Record<string, number>;
    };
    return {
      sandboxed: result.sandboxed === 1,
      denied: Object.fromEntries(
        Object.entries(paths).map(([name, path]) => [name, result.denied[path] === 1]),
      ),
    };
  };
  report.controlUnsandboxedScript = await check(process.pid);

  // A scratch Herdr server: the hire layout and agent start talk to it, never the owner's.
  const herdrEnv: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(?:HERDR_|CLANKIE_|CLAUDE_CODE_|CLAUDE_SESSION_ID|CLAUDE_AGENT_ID|CODEX_THREAD_ID)/u.test(key),
    ),
  );
  await mkdir(join(root, "herdr/config"), { recursive: true });
  await writeFile(
    join(root, "herdr/config/config.toml"),
    "onboarding = false\n[update]\nversion_check = false\nmanifest_check = false\n",
  );
  // Its own HOME and every XDG root, not only the socket and config file: Herdr keeps
  // its session under XDG_CONFIG_HOME (else HOME/.config).
  Object.assign(herdrEnv, {
    HOME: join(root, "herdr/home"),
    HERDR_SOCKET_PATH: join(root, "herdr/h.sock"),
    HERDR_CONFIG_PATH: join(root, "herdr/config/config.toml"),
    XDG_CONFIG_HOME: join(root, "herdr/config"),
    XDG_STATE_HOME: join(root, "herdr/state"),
    XDG_DATA_HOME: join(root, "herdr/data"),
    XDG_CACHE_HOME: join(root, "herdr/cache"),
    XDG_RUNTIME_DIR: join(root, "herdr/runtime"),
  });
  await mkdir(herdrEnv.XDG_RUNTIME_DIR!, { recursive: true });
  await mkdir(herdrEnv.HOME!, { recursive: true });
  const sessionPath = await realpath(join(herdrEnv.XDG_CONFIG_HOME!, "herdr"))
    .catch(() => realpath(herdrEnv.XDG_CONFIG_HOME!).then((dir) => join(dir, "herdr")))
    .then((dir) => join(dir, "session.json"));
  const ownerHerdr = await realpath(join(home, ".config/herdr")).catch(() => join(home, ".config/herdr"));
  report.herdrIsolation = { sessionPath, home: herdrEnv.HOME, configHome: herdrEnv.XDG_CONFIG_HOME };
  if (sessionPath.startsWith(`${ownerHerdr}/`) || !sessionPath.startsWith(`${root}/`))
    throw new Error(`Scratch Herdr would use ${sessionPath}; refusing to start it`);
  if (dryRun) {
    report.dryRun = "isolation checked; no Herdr server started";
    throw new Error("dry run");
  }
  const server: ChildProcess = spawn("herdr", ["server"], { env: herdrEnv, stdio: "ignore" });
  cleanup.push(async () => {
    // allow-swallowed-rejection -- a server that refuses to stop is killed on the next line.
    await shell("herdr", ["server", "stop"], herdrEnv).catch(() => undefined);
    server.kill("SIGTERM");
  });
  const herdr = (args: readonly string[]) => shell("herdr", args, herdrEnv);
  for (let attempt = 0; ; attempt++) {
    try {
      const listed = JSON.parse(await herdr(["workspace", "list"])).result.workspaces as unknown[];
      // An isolated server starts empty; anything else is someone's restored session.
      if (listed.length !== 0)
        throw new Error(`Scratch Herdr restored ${listed.length} workspaces; stopping`);
      break;
    } catch (error) {
      if (String(error).includes("restored") || attempt > 100) throw error;
      await delay(50);
    }
  }

  // The environment a local hire's pane gets with the setting on (herdr-watch launchSeat).
  const sandbox = createWorkerSandbox({ env: ownerEnv, repoRoot: checkout });
  if (!sandbox) throw new Error("No worker sandbox on this machine");
  // New harness sessions this proof owns sign in with their own accounts in the owner's HOME.
  const paneEnv = { HOME: home, ...clankieEnv, ...WORKER_PANE_ENV, ...sandbox.env, ...sandbox.shellEnv };
  const createTab = createHireLayout(herdr);
  const panes: Record<string, string> = {};
  for (const label of ["probe", "claude", "codex"])
    panes[label] = await createTab({ cwd: checkout, label: `vuh-2592 ${label}`, env: paneEnv });
  const shellPid = async (pane: string) => {
    const info = JSON.parse(await herdr(["pane", "process-info", "--pane", pane])).result.process_info;
    return {
      shell: info.shell_pid as number,
      foreground: info.foreground_processes as { pid: number; name: string }[],
    };
  };
  await delay(1_500);

  // What a prompt-injected worker shell would try, run in the probe pane.
  const results = join(root, "probe-results.txt");
  const probeScript = [
    `exec > ${results} 2>&1`,
    'echo "SHELL=$SHELL CLANKIE_WORKER_PANE=$CLANKIE_WORKER_PANE CLANKIE_OPERATOR_TOKEN=[${CLANKIE_OPERATOR_TOKEN-unset}]"',
    `/usr/bin/security find-generic-password -s bot.clankie.credentials -a clankie_operator -w ${clankieEnv.CLANKIE_PROTECTED_KEYCHAIN} >/dev/null; echo "keychain-read exit=$?"`,
    `/bin/cat ${clankieEnv.CLANKIE_CREDENTIALS_FILE} >/dev/null; echo "file-broker-read exit=$?"`,
    `/bin/cp ${clankieEnv.CLANKIE_PROTECTED_KEYCHAIN} ${root}/stolen.keychain-db; echo "keychain-copy exit=$?"`,
    `cd ${checkout}/apps/clankie && node --import tsx test/fixtures/worker-credential-probe.ts`,
    `/bin/cat ${checkout}/README.md >/dev/null; echo "ordinary-read exit=$?"`,
    "echo PROBE-DONE",
  ].join("; ");
  await herdr(["pane", "run", panes.probe!, probeScript]);
  for (let attempt = 0; attempt < 120; attempt++) {
    const text = await shell("/bin/cat", [results]).catch(() => "");
    if (text.includes("PROBE-DONE")) {
      report.probeShell = text.trim().split("\n");
      break;
    }
    await delay(250);
  }
  report.probePaneShell = await check((await shellPid(panes.probe!)).shell);

  // The real harnesses, started the way a hire starts them.
  for (const harness of ["claude", "codex"] as const) {
    try {
      await herdr([
        "agent",
        "start",
        `vuh-2592-${harness}`,
        "--kind",
        harness,
        "--pane",
        panes[harness]!,
        "--timeout",
        "90000",
        // A proof run should not stop at Codex's update offer.
        ...(harness === "codex" ? ["--", "-c", "check_for_update_on_startup=false"] : []),
      ]);
    } catch (error) {
      report[`${harness}StartError`] = String(error).slice(0, 2_000);
    }
    await delay(3_000);
    const processes = await shellPid(panes[harness]!);
    // The harness is the pane shell's direct child; foreground can be one of its hooks.
    const children = (await shell("/bin/ps", ["-A", "-o", "pid=,ppid=,comm="]))
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/u))
      .filter(([, ppid]) => Number(ppid) === processes.shell)
      .map(([pid, , ...comm]) => ({ pid: Number(pid), name: comm.join(" ") }));
    const native =
      children.find((entry) => entry.name.split("/").pop() === harness) ??
      processes.foreground.find((entry) => entry.name.includes(harness)) ??
      processes.foreground[0]!;
    report[harness] = {
      process: native.name,
      kernel: await check(native.pid),
      // Signed in and ready, not a login screen: its own login keychain or files still work.
      screen: (await herdr(["pane", "read", panes[harness]!, "--source", "visible"]).catch(String))
        .split("\n")
        .filter((line) => line.trim())
        .slice(0, 40),
    };
  }

  // Codex tools run in its app-server; a hire's server takes the pane's profile at full access.
  const appServer = await localCodexServer({
    cwd: checkout,
    configArgs: MAXIMUM_TRUST_CODEX_CONFIG.flatMap((value) => ["-c", value]),
    env: { ...clankieEnv, ...WORKER_PANE_ENV, ...sandbox.env },
    onExit: () => {},
  });
  cleanup.push(() => appServer.close());
  await delay(1_500);
  report.codexAppServer = appServer.pid === undefined ? "no pid" : await check(appServer.pid);
} catch (error) {
  if (!(dryRun && error instanceof Error && error.message === "dry run")) throw error;
} finally {
  const cleanupErrors: string[] = [];
  for (const step of cleanup.reverse())
    await step().catch((error: unknown) => cleanupErrors.push(String(error)));
  if (cleanupErrors.length > 0) report.cleanupErrors = cleanupErrors;
  report.finishedAt = new Date().toISOString();
  report.ownerHerdrSessionUntouched =
    ownerSessionBefore ===
    (await stat(ownerSession).then(
      (entry) => entry.mtimeMs,
      () => undefined,
    ));
  await mkdir(out, { recursive: true });
  await writeFile(join(out, "worker-sandbox-proof.json"), `${JSON.stringify(report, null, 2)}\n`);
  await rm(root, { recursive: true, force: true });
  console.log(JSON.stringify(report, null, 2));
}
