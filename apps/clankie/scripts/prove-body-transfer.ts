/**
 * Manual real-dependency E2E for ADR 0286 (VUH-2577). Run through clankie heavy --server;
 * never targets a live service. Two private bodies: a Mac-layout scratch body and a
 * body with the hosted image's /state layout (self-hosted mode: no managed bootstrap).
 */
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createDefaultCredentialStore, FileCredentialStore } from "@clankie/credential-broker";

const execFileAsync = promisify(execFile);
const repo = resolve(import.meta.dirname, "../../..");
const root = resolve(process.argv[2] ?? join(repo, ".local/vuh-2577", `proof-${Date.now()}`));
const model = process.argv[3] ?? "openai/gpt-5.4-mini";
const provider = model.slice(0, model.indexOf("/"));
const sourcePaths = [
  "apps/clankie/src/body-transfer.ts",
  "apps/clankie/src/captain/personas.ts",
  "apps/clankie/src/dormant-body.ts",
  "apps/clankie/src/body-doorway.ts",
  "apps/clankie/src/index.ts",
  "apps/clankie/src/app/runtime.ts",
  "packages/protocol/src/body-transfer.ts",
  "apps/tui/src/command/transfer.ts",
  "apps/clankie/scripts/prove-body-transfer.ts",
];
const digests = () =>
  Object.fromEntries(
    sourcePaths.map((path) => [
      path,
      createHash("sha256")
        .update(readFileSync(join(repo, path)))
        .digest("hex"),
    ]),
  );
const sources = digests();
const results: Record<string, unknown> = { model, sources, steps: [] };
const step = (name: string, detail: unknown = {}) => {
  console.log(`✓ ${name}`);
  (results.steps as unknown[]).push({ name, at: new Date().toISOString(), detail });
};

// Only an API key is copied; refresh tokens could strand the live account if rotated here.
const credential = await createDefaultCredentialStore().get(provider);
assert(credential?.type === "api", `The proof needs an existing API credential for ${provider}`);

interface Body {
  readonly name: string;
  readonly dir: string;
  readonly env: Record<string, string>;
  readonly url: string;
  child?: ChildProcess;
  generation: number;
  supervise: boolean;
  pids: number[];
}

async function preset(name: string, hostedLayout: boolean): Promise<Body> {
  const dir = join(root, name);
  execFileSync(process.execPath, [join(repo, "scripts/scratch-stack.mjs"), dir, "--broker-operator"], {
    cwd: repo,
  });
  const env = parseEnv(await readFile(join(dir, "stack.env"), "utf8")) as Record<string, string>;
  if (hostedLayout) {
    // The hosted image's layout (scripts/release/clankie-linux.Dockerfile): everything under /state.
    const state = join(dir, "state");
    Object.assign(env, {
      HOME: join(state, "home"),
      CLANKIE_STATE: join(state, "runtime"),
      XDG_CONFIG_HOME: join(state, "config"),
      XDG_STATE_HOME: join(state, "history"),
      CLANKIE_CREDENTIALS_FILE: join(state, "credentials.json"),
      CLANKIE_SETTINGS_FILE: join(state, "config/clankie/settings.json"),
      CLANKIE_TEST_FLEET_RESOURCES_DIRECTORY: join(state, "fleet-resources"),
    });
    await mkdir(join(state, "config/clankie"), { recursive: true, mode: 0o700 });
    await mkdir(join(state, "home"), { recursive: true, mode: 0o700 });
    await rename(join(dir, "settings.json"), env.CLANKIE_SETTINGS_FILE!);
    await writeFile(
      join(dir, "stack.env"),
      Object.entries(env)
        .map(([key, value]) => `${key}='${value}'`)
        .join("\n") + "\n",
      { mode: 0o600 },
    );
  }
  await mkdir(join(env.XDG_CONFIG_HOME!, "clankie"), { recursive: true });
  await writeFile(
    join(env.XDG_CONFIG_HOME!, "clankie/clankie.json"),
    JSON.stringify({ model, variant: { [model]: "low" } }),
  );
  await new FileCredentialStore(env.CLANKIE_CREDENTIALS_FILE!).set(provider, credential!);
  return { name, dir, env, url: env.CLANKIE_CAPTAIN_URL!, generation: 0, supervise: true, pids: [] };
}

/** Like the launcher's recover pass: a body that exits is started again. */
function start(body: Body) {
  body.generation++;
  const child = spawn(
    process.execPath,
    ["--import", join(repo, "scripts/dependency-types.mjs"), join(repo, "apps/clankie/src/index.ts")],
    {
      cwd: repo,
      env: { PATH: process.env.PATH, LANG: process.env.LANG, ...body.env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  body.child = child;
  body.pids.push(child.pid!);
  const log = join(body.dir, `service-${body.generation}.log`);
  child.stdout?.on("data", (data: Buffer) => appendFileSync(log, data));
  child.stderr?.on("data", (data: Buffer) => appendFileSync(log, data));
  child.on("exit", (code, signal) => {
    appendFileSync(
      join(root, "supervisor.log"),
      `${body.name} gen ${body.generation} exit ${code ?? signal}\n`,
    );
    if (body.supervise) setTimeout(() => start(body), 300);
  });
}

async function until<T>(read: () => Promise<T | undefined>, what: string, timeout = 240_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    // allow-swallowed-rejection -- a restarting body refuses connections; the deadline below reports the timeout
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    await delay(300);
  }
  throw new Error(`Timed out: ${what}; inspect ${root}`);
}

async function health(body: Body): Promise<Record<string, any>> {
  return until(async () => {
    const response = await fetch(`${body.url}/health`);
    return response.ok ? ((await response.json()) as Record<string, any>) : undefined;
  }, `${body.name} health`);
}

// Asynchronous, so the supervisor keeps restarting bodies while a command waits.
async function cli(body: Body, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(
    process.execPath,
    [join(repo, "scripts/scratch-stack.mjs"), "run", body.dir, "cli", ...args],
    { cwd: repo, encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout;
}
const json = (text: string) => JSON.parse(text.trim().split("\n").at(-1)!);

async function operatorToken(body: Body): Promise<string> {
  const stored = await new FileCredentialStore(body.env.CLANKIE_CREDENTIALS_FILE!).get("clankie_operator");
  assert(stored?.type === "api");
  const file = join(body.dir, "operator.token");
  await writeFile(file, stored.key, { mode: 0o600 });
  return file;
}

async function operatorFetch(body: Body, path: string, init: RequestInit = {}) {
  const token = (await readFile(join(body.dir, "operator.token"), "utf8")).trim();
  return fetch(`${body.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
  });
}

/** One owner turn in the main console conversation; returns Clankie's replies in that turn. */
async function ownerTurn(body: Body, message: string): Promise<string> {
  const seen = (await conversationEvents(body)).length;
  await cli(body, ["send", "--conversation", "global-default", "--delivery", "queue", message]);
  return until(
    async () => {
      const added = (await conversationEvents(body)).slice(seen);
      const asked = added.findIndex((event) => event.type === "message" && event.role === "operator");
      if (asked < 0) return undefined;
      const after = added.slice(asked + 1);
      const ended = after.find(
        (event) => event.type === "turn" && ["completed", "failed", "stalled"].includes(event.phase),
      );
      if (ended === undefined) return undefined;
      assert.equal(ended.phase, "completed", `owner turn ${ended.phase}`);
      return after
        .filter((event) => event.type === "message" && event.role === "captain")
        .map((event) => event.text)
        .join("\n");
    },
    "owner turn reply",
    600_000,
  );
}

/** Every replay event, following pages until the service says there are no more. */
async function conversationEvents(body: Body): Promise<any[]> {
  const events: any[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = json(
      await cli(body, [
        "conversations",
        "show",
        "global-default",
        ...(cursor === undefined ? [] : ["--cursor", cursor]),
      ]),
    );
    events.push(...page.events);
    if (!page.hasMore || page.nextCursor === undefined || page.nextCursor === cursor) return events;
    cursor = page.nextCursor;
  }
}

/** Loopback stand-in for the gateway's `/h/{hostId}` route to one body. Production routing is clankie-ops. */
async function gateway(target: Body, hostId: string) {
  const server = createServer((incoming, outgoing) => {
    const prefix = `/h/${hostId}`;
    if (!incoming.url?.startsWith(prefix)) return void outgoing.writeHead(404).end();
    const upstream = new URL(target.url);
    const forward = httpRequest(
      {
        host: upstream.hostname,
        port: upstream.port,
        method: incoming.method,
        path: incoming.url.slice(prefix.length) || "/",
        headers: incoming.headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    forward.on("error", () => outgoing.writeHead(502).end());
    incoming.pipe(forward);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const mac = await preset("mac", false);
const hosted = await preset("hosted", true);
const codeword = `teal-${randomBytes(3).toString("hex")}`;
const secondCodeword = `pixel-${randomBytes(3).toString("hex")}`;
const marker = `joined-machine-${randomUUID()}`;
const workspace = join(mac.dir, "workspace");
let join_: ChildProcess | undefined;
let proxy: Awaited<ReturnType<typeof gateway>> | undefined;
try {
  // 1. The Mac body is Clankie and accumulates real history.
  start(mac);
  await health(mac);
  await operatorToken(mac);
  await cli(mac, ["auto", "off"]);
  await mkdir(workspace, { recursive: true });
  execFileSync("git", ["init", "-q", workspace]);
  await writeFile(join(workspace, "marker.txt"), `${marker}\n`);
  const listed = json(await cli(mac, ["project", "list"]));
  await writeFile(
    join(mac.dir, "project.json"),
    JSON.stringify({ name: "Transfer proof", workspacePath: workspace }),
  );
  await cli(mac, [
    "project",
    "create",
    "transferproof",
    "--settings",
    join(mac.dir, "project.json"),
    "--revision",
    String(listed.revision),
  ]);
  const issue = json(
    await cli(mac, [
      "work",
      "create",
      "Prove the body transfer",
      "--summary",
      `codeword ${codeword}`,
      "--repo",
      workspace,
    ]),
  );
  step("mac seeded project and tracker issue", { issue });
  const remembered = await ownerTurn(
    mac,
    `Authorized private proof in a disposable local service. Call memory with action write and text exactly "The transfer proof codeword is ${codeword}." Then reply "saved".`,
  );
  step("mac owner turn wrote memory", { reply: remembered });
  const macMemory = execFileSync("grep", ["-rl", codeword, join(mac.env.CLANKIE_STATE!, "memory")], {
    encoding: "utf8",
  });
  assert(macMemory.trim().length > 0, "memory note on the Mac");

  // 2. A fresh hosted-layout body is unclaimed.
  start(hosted);
  await health(hosted);
  const hostedToken = await operatorToken(hosted);
  await cli(hosted, ["auto", "off"]);
  const before = json(
    await cli(mac, ["transfer", "status", "--at", hosted.url, "--token-file", hostedToken]),
  );
  assert.equal(before.selfId, undefined);
  step("hosted body starts unclaimed", before);

  // 3. Transfer out. Freeze directly and kill the Mac the moment frozen is durable,
  // inside its shutdown grace: it must come back dormant, and the CLI resumes the id.
  const outId = randomUUID();
  const frozen = await operatorFetch(mac, "/v1/body-transfer/freeze", {
    method: "POST",
    body: JSON.stringify({ transferId: outId, destination: new URL(hosted.url).origin }),
  });
  mac.child?.kill("SIGKILL");
  assert.equal(frozen.status, 200, await frozen.clone().text());
  step("mac froze; killed immediately after the freeze reply", (await frozen.json()) as unknown);
  const afterCrash = await until(async () => {
    const response = await fetch(`${mac.url}/health`);
    const body = response.ok ? ((await response.json()) as Record<string, any>) : undefined;
    return body?.self?.dormant ? body : undefined;
  }, "mac back after the crash");
  assert.equal(afterCrash.self.state, "frozen");
  const supervisor = await readFile(join(root, "supervisor.log"), "utf8");
  assert.match(supervisor, /mac gen 1 exit SIGKILL/u);
  step("crashed Mac restarted dormant, still frozen", { supervisor, health: afterCrash });
  const out = json(
    await cli(mac, ["transfer", "--to", hosted.url, "--to-token-file", hostedToken, "--transfer-id", outId]),
  );
  assert.equal(out.destination.state, "active");
  assert.equal(out.source.state, "released");
  assert.equal(out.destination.selfId, out.source.selfId);
  assert.equal(out.destination.epoch, 1);
  step("transfer out completed", out);

  // 4. Fencing on the released Mac.
  const macHealth = await health(mac);
  assert.equal(macHealth.self.state, "released");
  assert.equal(macHealth.self.releasedTo.peer, new URL(hosted.url).origin);
  const refused = await operatorFetch(mac, "/v1/conversations");
  assert.equal(refused.status, 503);
  const reapply = await operatorFetch(mac, "/v1/body-transfer/freeze", {
    method: "POST",
    body: JSON.stringify({ transferId: randomUUID(), destination: "elsewhere" }),
  });
  assert.equal(reapply.status, 409);
  const unforced = await operatorFetch(mac, "/v1/body-transfer/reclaim", {
    method: "POST",
    body: JSON.stringify({ reason: "no" }),
  });
  assert.equal(unforced.status, 400);
  step("released Mac says where Clankie went and refuses everything else", {
    health: macHealth,
    conversations: refused.status,
    freeze: (await reapply.json()) as unknown,
    reclaimWithoutForce: unforced.status,
  });

  // 5. The same Clankie on the hosted body: memory, conversation, project, tracker.
  const hostedState = hosted.env.CLANKIE_STATE!;
  assert(execFileSync("grep", ["-rl", codeword, join(hostedState, "memory")], { encoding: "utf8" }).trim());
  const hostedProjects = json(await cli(hosted, ["project", "list"]));
  const project = hostedProjects.settings.projects.find((entry: any) => entry.id === "transferproof");
  assert.equal(project.workspaces[0].machineId, `transferred:${outId}`);
  // The repo itself stays on the old Mac; the built-in tracker store moved with Clankie.
  const tracker = await readFile(join(hostedState, "tracker/tracker.json"), "utf8");
  assert(tracker.includes("Prove the body transfer") && tracker.includes(codeword));
  step("hosted body holds the moved memory, project and tracker store", { project });
  const recalled = await ownerTurn(
    hosted,
    `What is the transfer proof codeword? Check your memory. Then read tracker issue ${issue.item.id} with your tracker tool. Reply with the codeword and the issue title only.`,
  );
  assert.match(recalled, new RegExp(codeword, "u"));
  assert.match(recalled, /Prove the body transfer/u);
  step("hosted Clankie recalls the codeword from moved memory and reads the moved issue", {
    reply: recalled,
  });

  // 6. The old Mac joins the hosted body and becomes an execution resource.
  const hostId = `proofhost${randomBytes(8).toString("hex")}`;
  proxy = await gateway(hosted, hostId);
  join_ = spawn(
    process.execPath,
    [
      join(repo, "scripts/scratch-stack.mjs"),
      "run",
      mac.dir,
      "cli",
      "join",
      "--gateway",
      proxy.origin,
      "--host",
      hostId,
      "--directory",
      workspace,
      "--json",
    ],
    { cwd: repo, stdio: ["ignore", "pipe", "pipe"] },
  );
  let joinOutput = "";
  join_.stdout?.on("data", (data: Buffer) => (joinOutput += data.toString()));
  join_.stderr?.on("data", (data: Buffer) => appendFileSync(join(root, "join.log"), data));
  const code = await until(
    async () => /"code":"([^"]+)"/u.exec(joinOutput)?.[1],
    "join approval code",
    60_000,
  );
  await cli(hosted, ["join", "approve", code, "--access", "shell", "--directory", workspace]);
  const machine = await until(
    async () => {
      const machines = json(await cli(hosted, ["machines", "--json"]));
      const list: any[] = machines.machines ?? machines;
      return list.find((entry) => entry.transport === "join" && entry.state === "available");
    },
    "joined machine online",
    120_000,
  );
  const rebound = json(
    await cli(hosted, ["transfer", "rebind", "--transfer-id", outId, "--machine", machine.id]),
  );
  assert.equal(rebound.rebound, 1);
  const reboundProject = json(await cli(hosted, ["project", "list"])).settings.projects.find(
    (entry: any) => entry.id === "transferproof",
  );
  assert.equal(reboundProject.workspaces[0].machineId, machine.id);
  step("old Mac joined the hosted body and its workspace rebound to it", {
    machine,
    rebound,
    project: reboundProject,
  });
  const shell = await ownerTurn(
    hosted,
    `Use joined_machine_shell on machine ${machine.id} in ${workspace} to run exactly: cat marker.txt. Reply with its output only.`,
  );
  // The effect, not the model's prose: the tool's own result and the home's audit record.
  const shellResult = (await conversationEvents(hosted)).findLast(
    (event) => event.type === "tool" && event.name === "joined_machine_shell" && event.phase === "completed",
  );
  assert.match(String(shellResult?.detail), new RegExp(`^\\[exit 0\\]\\n${marker}`, "u"));
  const audit = (await operatorFetch(hosted, "/v1/machines/shell-audit").then((response) =>
    response.json(),
  )) as { entries: { machineId: string; outcome: string; exitCode: number; origin: string }[] };
  assert(
    audit.entries.some(
      (entry) =>
        entry.machineId === machine.id &&
        entry.outcome === "completed" &&
        entry.exitCode === 0 &&
        entry.origin === "owner",
    ),
  );
  step("hosted Clankie ran a shell on the joined old Mac", {
    reply: shell,
    toolResult: shellResult?.detail,
    audit,
  });

  // 7. New history on the hosted body, then the Mac leaves its join and Clankie returns.
  const second = await ownerTurn(
    hosted,
    `Call memory with action write and text exactly "The second transfer codeword is ${secondCodeword}." Then reply "saved".`,
  );
  step("hosted owner turn wrote new memory", { reply: second });
  join_.kill("SIGINT");
  await cli(mac, ["join", "leave"]);
  const backId = randomUUID();
  const back = json(
    await cli(mac, [
      "transfer",
      "--from",
      hosted.url,
      "--from-token-file",
      hostedToken,
      "--to",
      "local",
      "--destination-machine",
      machine.id,
      "--transfer-id",
      backId,
    ]),
  );
  assert.equal(back.destination.state, "active");
  assert.equal(back.destination.epoch, 2);
  assert.equal(back.source.state, "released");
  assert.equal(back.destination.selfId, out.destination.selfId);
  step("transfer back completed", back);
  const macProject = json(await cli(mac, ["project", "list"])).settings.projects.find(
    (entry: any) => entry.id === "transferproof",
  );
  assert.equal(macProject.workspaces[0].machineId, "local");
  const returned = await ownerTurn(
    mac,
    "What are the two transfer codewords? Check your memory and answer with both codewords only.",
  );
  assert.match(returned, new RegExp(codeword, "u"));
  assert.match(returned, new RegExp(secondCodeword, "u"));
  step("returned Mac Clankie recalls both codewords and owns its workspace again", {
    project: macProject,
    reply: returned,
  });

  // 8. The hosted tombstone cannot be re-applied or re-activated without the owner.
  const exitsBefore = await readFile(join(root, "supervisor.log"), "utf8");
  const hostedHealth = await health(hosted);
  assert.equal(hostedHealth.self.state, "released");
  const replay = await operatorFetch(hosted, "/v1/body-transfer/apply", {
    method: "POST",
    body: JSON.stringify({ transferId: outId }),
  });
  assert.equal(replay.status, 200, "a repeated apply is an idempotent no-op");
  const stale = await operatorFetch(mac, "/v1/body-transfer/apply", {
    method: "POST",
    body: JSON.stringify({ transferId: outId }),
  });
  assert.equal(stale.status, 409);
  await delay(2000);
  assert.equal(
    await readFile(join(root, "supervisor.log"), "utf8"),
    exitsBefore,
    "a repeated apply restarts nothing",
  );
  assert.equal((await health(hosted)).self.state, "released");
  step("replayed and stale applies are refused on both bodies", {
    hosted: hostedHealth,
    hostedReplay: (await replay.json()) as unknown,
    macStale: (await stale.json()) as unknown,
  });
  assert.deepEqual(digests(), sources, "source changed during the proof");
  results.outcome = "passed";
} catch (error) {
  results.outcome = "failed";
  results.error = String((error as Error).stack ?? error);
  throw error;
} finally {
  join_?.kill("SIGINT");
  proxy?.server.close();
  for (const body of [mac, hosted]) {
    body.supervise = false;
    body.child?.kill("SIGTERM");
  }
  await delay(2000);
  for (const body of [mac, hosted]) {
    if (body.child?.exitCode === null) body.child.kill("SIGKILL");
    // Injected API keys never outlive the proof.
    await new FileCredentialStore(body.env.CLANKIE_CREDENTIALS_FILE!).delete(provider);
  }
  results.pids = { mac: mac.pids, hosted: hosted.pids };
  await writeFile(join(root, "result.json"), JSON.stringify(results, null, 2));
  console.log(`result: ${join(root, "result.json")} (${results.outcome})`);
}
