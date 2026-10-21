/**
 * Manual real-dependency proof for VUH-2607 (ADR 0244, VUH-1792): a machine joins
 * Clankie through a real gateway at `workers`, Clankie hires a Claude worker there
 * that reports back, and his own shell there is refused.
 *
 * Stack: the clankie-ops gateway as a local process (CLANKIE_OPS_ROOT), a
 * self-hosted scratch home behind it, and a scratch "laptop" (its own Clankie
 * state, broker and a named Herdr session) running the real `clankie join`. The
 * worker uses this Mac's native-default Claude sign-in. Run through
 * `clankie heavy --`; it never touches the live service, the owner's Herdr
 * sessions or production, and it removes its session on exit.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createDefaultCredentialStore, FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";

const repo = resolve(import.meta.dirname, "../../..");
const root = resolve(process.argv[2] ?? join(repo, ".local/vuh-2607", `proof-${Date.now()}`));
const model = process.argv[3] ?? "openai/gpt-5.4-mini";
const provider = model.slice(0, model.indexOf("/"));
const opsRoot = resolve(process.env.CLANKIE_OPS_ROOT ?? "");
assert(
  existsSync(join(opsRoot, "apps/gateway/src/index.ts")),
  "Set CLANKIE_OPS_ROOT to a clankie-ops checkout",
);
// The native default sign-in launches with CLAUDE_CONFIG_DIR unset (its keychain entry is keyed by it).
assert(!process.env.CLAUDE_CONFIG_DIR, "Unset CLAUDE_CONFIG_DIR: the worker uses the native default sign-in");
const results: { steps: { name: string; detail: unknown }[]; outcome?: string; error?: string } = {
  steps: [],
};
const step = (name: string, detail: unknown = {}) => {
  console.log(`✓ ${name}`);
  results.steps.push({ name, detail });
};
const children: ChildProcess[] = [];
const launch = (
  name: string,
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
  redact: (text: string) => string = (text) => text,
) => {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
  const log = join(root, `${name}.log`);
  child.stdout?.on("data", (data: Buffer) => appendFileSync(log, redact(data.toString())));
  child.stderr?.on("data", (data: Buffer) => appendFileSync(log, redact(data.toString())));
  children.push(child);
  return child;
};
async function until<T>(
  read: () => Promise<T | undefined> | T | undefined,
  what: string,
  timeout = 120_000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await Promise.resolve()
      .then(read)
      // allow-swallowed-rejection -- a process still starting refuses; the deadline reports the timeout
      .catch(() => undefined);
    if (value !== undefined) return value;
    await delay(500);
  }
  throw new Error(`Timed out: ${what}; inspect ${root}`);
}
const freePort = () =>
  new Promise<number>((done) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });

// Home: a self-hosted scratch body with an API model, bound to the local gateway.
const credential = await createDefaultCredentialStore().get(provider);
assert(credential?.type === "api", `The proof needs an existing API credential for ${provider}`);
await mkdir(root, { recursive: true });
execFileSync(
  process.execPath,
  [join(repo, "scripts/scratch-stack.mjs"), join(root, "home"), "--broker-operator"],
  {
    cwd: repo,
  },
);
const home = parseEnv(await readFile(join(root, "home/stack.env"), "utf8")) as Record<string, string>;
const gatewayPort = await freePort();
const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
const hostId = `proofhost${randomBytes(8).toString("hex")}`;
const hostToken = randomBytes(36).toString("base64url");
const homeCredentials = new FileCredentialStore(home.CLANKIE_CREDENTIALS_FILE!);
await homeCredentials.set(provider, credential);
await homeCredentials.set("clankie-public-gateway", { type: "api", key: hostToken });
await new SettingsStore(home.CLANKIE_SETTINGS_FILE!).update((current) => ({
  ...current,
  publicGateway: { ...current.publicGateway, url: gatewayUrl, hostId },
}));
await mkdir(join(home.XDG_CONFIG_HOME!, "clankie"), { recursive: true });
await writeFile(
  join(home.XDG_CONFIG_HOME!, "clankie/clankie.json"),
  JSON.stringify({ model, variant: { [model]: "low" } }),
);
const homeCli = (...args: string[]) =>
  execFileSync(
    process.execPath,
    [join(repo, "scripts/scratch-stack.mjs"), "run", join(root, "home"), "cli", ...args],
    {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    },
  );
const journal = () => {
  const path = [join(home.CLANKIE_STATE!, "captain"), home.CLANKIE_STATE!]
    .map((state) => join(state, "conversations/global-default/events.jsonl"))
    .find(existsSync);
  return path ? readFileSync(path, "utf8").trim().split("\n") : [];
};
const toolResult = (name: string, after = 0) =>
  journal()
    .slice(after)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map(
      (entry) => (entry.event ?? entry) as { type?: string; name?: string; phase?: string; detail?: unknown },
    )
    .find((event) => event.type === "tool" && event.name === name && event.phase !== "started");

// Laptop: its own Clankie state, broker and Herdr session; `clankie` is this checkout.
const laptop = join(root, "laptop");
const workspace = join(laptop, "workspace");
const bin = join(laptop, "bin");
await mkdir(workspace, { recursive: true });
await mkdir(bin, { recursive: true });
await writeFile(
  join(bin, "clankie"),
  `#!/bin/sh\nexec "${process.execPath}" "${join(repo, "apps/tui/bin/clankie.ts")}" "$@"\n`,
);
await chmod(join(bin, "clankie"), 0o755);
// Every Herdr call the laptop makes, and its answer, with launch tokens redacted.
const herdr = execFileSync("sh", ["-c", "command -v herdr"], { encoding: "utf8" }).trim();
await writeFile(
  join(bin, "herdr"),
  [
    "#!/bin/sh",
    `log="${join(root, "herdr-calls.log")}"`,
    `out=$("${herdr}" "$@" 2>&1); status=$?`,
    `printf '%s\\n' "$* => $status $out" | sed -E 's/(TOKEN=)[^ ]+/\\1[redacted]/g' | cut -c1-2000 >> "$log"`,
    `printf '%s\\n' "$out"`,
    "exit $status",
  ].join("\n") + "\n",
);
await chmod(join(bin, "herdr"), 0o755);
// PROOF_CLAUDE=stand-in replaces Claude with a recorder that reports itself to Herdr as
// Claude does, and the runner then drives the installed worker plugin's MCP server
// itself, as Claude would: the whole chain except the model turn.
const standIn = process.env.PROOF_CLAUDE === "stand-in";
const claudeLaunch = join(root, "claude-launch.json");
if (standIn) {
  await writeFile(
    join(bin, "claude"),
    `#!${process.execPath}
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
writeFileSync(${JSON.stringify(claudeLaunch)}, JSON.stringify({ argv, env: process.env }));
execFileSync("herdr", ["pane", "report-agent", process.env.HERDR_PANE_ID, "--source", "herdr:claude", "--agent", "claude",
  "--state", "idle", "--agent-session-id", argv[argv.indexOf("--session-id") + 1]]);
setInterval(() => {}, 1 << 30);
`,
  );
  await chmod(join(bin, "claude"), 0o755);
}
// The owner's shell profile would put the installed `clankie` first in the
// worker's pane; this machine's panes run this checkout's.
await mkdir(join(laptop, "zsh"), { recursive: true });
await writeFile(join(laptop, "zsh/.zshrc"), "");
const herdrSession = "vuh2607-proof";
const herdrSocket = join(homedir(), ".config/herdr/sessions", herdrSession, "herdr.sock");
assert(
  !existsSync(join(homedir(), ".config/herdr/sessions", herdrSession)),
  `Herdr session ${herdrSession} already exists`,
);
const laptopEnv: NodeJS.ProcessEnv = {
  PATH: `${bin}:${process.env.PATH}`,
  LANG: process.env.LANG,
  HOME: homedir(),
  USER: process.env.USER,
  TERM: "xterm-256color",
  CLANKIE_STATE: join(laptop, "state"),
  CLANKIE_CREDENTIALS_FILE: join(laptop, "credentials.json"),
  CLANKIE_SETTINGS_FILE: join(laptop, "settings.json"),
  // The laptop runs no Clankie service, and this Mac's must never answer for it.
  CLANKIE_CONTROL_PLANE_URL: "http://127.0.0.1:9",
  CLANKIE_CAPTAIN_URL: "http://127.0.0.1:9",
  HERDR_SOCKET_PATH: herdrSocket,
  ZDOTDIR: join(laptop, "zsh"),
};
const marker = `joined-hire-${randomBytes(4).toString("hex")}`;
let code = "";
let machineId = "";
let joinOutput = "";
try {
  launch("gateway", join(opsRoot, "apps/gateway/node_modules/.bin/tsx"), ["src/index.ts"], {
    cwd: join(opsRoot, "apps/gateway"),
    env: {
      PATH: process.env.PATH,
      PORT: String(gatewayPort),
      CLANKIE_GATEWAY_HOST: "127.0.0.1",
      CLANKIE_GATEWAY_HOST_TOKENS_JSON: JSON.stringify({ [hostId]: hostToken }),
    },
  });
  await until(async () => ((await fetch(gatewayUrl)).status > 0 ? true : undefined), "gateway");
  launch(
    "home",
    process.execPath,
    ["--import", join(repo, "scripts/dependency-types.mjs"), join(repo, "apps/clankie/src/index.ts")],
    { cwd: repo, env: { PATH: process.env.PATH, LANG: process.env.LANG, ...home } },
  );
  const health = await until(async () => {
    const body = (await (await fetch(`${home.CLANKIE_CAPTAIN_URL}/health`)).json()) as {
      doorway?: { state?: string };
    };
    return body.doorway?.state === "connected" ? body : undefined;
  }, "home doorway connected");
  homeCli("auto", "off");
  step("home is connected to the local gateway", { doorway: health.doorway, hostId });

  // A named scratch Herdr session for the laptop's panes, never the owner's sessions.
  launch("herdr", herdr, ["--session", herdrSession, "server"], { cwd: laptop, env: laptopEnv });
  await until(() => (existsSync(herdrSocket) ? true : undefined), "scratch herdr session");

  // The laptop joins through the gateway; the owner approves it at workers for one folder.
  const joining = launch(
    "join",
    join(bin, "clankie"),
    [
      "join",
      "--gateway",
      gatewayUrl,
      "--host",
      hostId,
      "--name",
      "proof-laptop",
      "--directory",
      workspace,
      "--json",
    ],
    { cwd: workspace, env: laptopEnv },
    // The approval code stays out of logs and evidence.
    (text) => (code ? text.replaceAll(code, "[code]") : text.replace(/"code":"[^"]+"/gu, '"code":"[code]"')),
  );
  joining.stdout?.on("data", (data: Buffer) => (joinOutput += data.toString()));
  code = await until(() => /"code":"([^"]+)"/u.exec(joinOutput)?.[1], "join approval code");
  const approved = JSON.parse(
    homeCli("join", "approve", code, "--access", "workers", "--directory", workspace),
  );
  machineId = approved.machineId;
  const listed = await until(() => {
    const list = JSON.parse(homeCli("machines", "--json")) as { machines: { id: string }[] };
    const entry = list.machines.find((machine) => machine.id === machineId);
    return entry && JSON.stringify(entry).includes('"available"') ? entry : undefined;
  }, "joined machine available");
  assert.equal(approved.accessLevel, "workers");
  step("the laptop joined through the gateway at workers", { approved, listed });

  // A real owner turn: Clankie hires a Claude worker on the laptop.
  homeCli(
    "send",
    "--conversation",
    "global-default",
    `Authorized private proof. Call hire_agent exactly once with: title "Pip", role "worker", fleet "${machineId}", workingDirectory "${workspace}", harness "claude", effort "low", effortReason "one small file", brief "Create the file proof.txt in your working folder containing exactly ${marker}. Then call message_clankie with text exactly ${marker}-done and a new UUID deliveryId. Then stop." Do nothing else, then reply with the hire result.`,
  );
  const hired = await until(() => toolResult("hire_agent"), "hire_agent result", 300_000);
  step("Clankie's hire_agent on the laptop returned", hired);
  assert.equal(hired.phase, "completed");
  assert.equal(JSON.parse(String(hired.detail)).outcome, "started");
  if (standIn) {
    // Claude would start its plugin's MCP server with the pane's environment.
    const launched = JSON.parse(readFileSync(claudeLaunch, "utf8")) as { env: Record<string, string> };
    const installed = JSON.parse(
      readFileSync(join(homedir(), ".claude/plugins/installed_plugins.json"), "utf8"),
    ).plugins["clankie-worker@clankie"][0].installPath as string;
    const client = new Client({ name: "stand-in-claude", version: "1" }, { capabilities: {} });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(installed, "bin/swarm-mcp.mjs")],
        env: launched.env,
        cwd: workspace,
        stderr: "inherit",
      }),
    );
    const sent = await client.callTool({
      name: "message_clankie",
      arguments: { text: `${marker}-done`, deliveryId: randomUUID() },
    });
    step("the stand-in called message_clankie through the installed worker plugin", { installed, sent });
    await client.close();
    await writeFile(join(workspace, "proof.txt"), marker);
  }
  const proof = await until(
    () =>
      existsSync(join(workspace, "proof.txt"))
        ? readFileSync(join(workspace, "proof.txt"), "utf8")
        : undefined,
    "the worker's proof.txt",
    300_000,
  );
  assert.equal(proof.trim(), marker);
  // Reports are durable for Clankie to read when he chooses; the fleet room records each one.
  const room = join(home.CLANKIE_STATE!, "captain/fleet-room/entries.jsonl");
  const report = await until(
    () =>
      existsSync(room)
        ? readFileSync(room, "utf8")
            .trim()
            .split("\n")
            .find((line) => line.includes(`${marker}-done`))
        : undefined,
    "the worker's report for the hiring conversation",
    300_000,
  );
  const entry = JSON.parse(report) as {
    kind: string;
    from: { label: string };
    to: { conversationId: string };
  };
  assert.equal(entry.kind, "worker_report");
  assert(entry.from.label.startsWith(`${machineId}/`));
  assert.equal(entry.to.conversationId, "global-default");
  const panes = JSON.parse(execFileSync(herdr, ["api", "snapshot"], { env: laptopEnv, encoding: "utf8" }));
  step("the worker wrote its file on the laptop and reported back", {
    proof: proof.trim(),
    report: entry,
    agents: panes.result.snapshot.agents,
  });

  // Clankie's own shell on a machine at workers is refused. Queued, so it runs in its
  // own owner turn rather than steering the autonomous turn the worker's report woke.
  const before = journal().length;
  homeCli(
    "send",
    "--conversation",
    "global-default",
    "--delivery",
    "queue",
    `Call joined_machine_shell exactly once on machine ${machineId} in ${workspace} to run: cat proof.txt. Report what happened.`,
  );
  const shell = await until(
    () => toolResult("joined_machine_shell", before),
    "joined_machine_shell result",
    300_000,
  );
  assert.match(JSON.stringify(shell), /workers/u);
  assert.doesNotMatch(JSON.stringify(shell), new RegExp(marker, "u"));
  const audit = homeCli("machines", "shell-audit");
  step("Clankie's shell on the laptop is refused at workers", { tool: shell, audit });
  results.outcome = "passed";
} catch (error) {
  results.outcome = "failed";
  results.error = String((error as Error).stack ?? error);
  process.exitCode = 1;
} finally {
  // The worker's pane and the named Herdr session are this proof's own.
  try {
    const snapshot = JSON.parse(
      execFileSync(herdr, ["api", "snapshot"], { env: laptopEnv, encoding: "utf8" }),
    );
    for (const pane of snapshot.result.snapshot.panes as { pane_id: string }[])
      results.steps.push({
        name: `pane ${pane.pane_id} at teardown`,
        detail: execFileSync(herdr, ["pane", "read", pane.pane_id], { env: laptopEnv, encoding: "utf8" })
          .trim()
          .split("\n")
          .slice(-30),
      });
  } catch {
    // allow-swallowed-rejection -- diagnostics only; a session that never started has no panes
  }
  try {
    execFileSync(herdr, ["--session", herdrSession, "server", "stop"], { env: laptopEnv, timeout: 30_000 });
  } catch {
    // allow-swallowed-rejection -- the server may already be down; the session is deleted next
  }
  for (const child of children.reverse()) child.kill("SIGTERM");
  await delay(2000);
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  try {
    execFileSync(herdr, ["session", "delete", herdrSession], { env: laptopEnv, timeout: 30_000 });
  } catch {
    // allow-swallowed-rejection -- a session that never started has nothing to delete
  }
  await homeCredentials.delete(provider);
  await writeFile(join(root, "result.json"), JSON.stringify(results, null, 2));
  console.log(`result: ${join(root, "result.json")} (${results.outcome})`);
  if (results.error) console.error(results.error);
}
