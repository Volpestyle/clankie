/** Manual real-dependency E2E. Run through clankie heavy --server; never targets a live service. */
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createDefaultCredentialStore, FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { CaptainChannelTurnResultSchema, type DiscordPresenceChannelTurnRequest } from "@clankie/protocol";

const repo = resolve(import.meta.dirname, "../../..");
const root = resolve(process.argv[2] ?? join(repo, ".local/vuh-2574", `proof-${Date.now()}`));
const model = process.argv[3] ?? "openai/gpt-5.4-mini";
const provider = model.slice(0, model.indexOf("/"));
const killSignal = process.argv[4] ?? "SIGKILL";
assert(killSignal === "SIGKILL" || killSignal === "SIGTERM");
const sourcePaths = [
  "apps/clankie/src/captain/pi-turn-journal.ts",
  "apps/clankie/src/captain/captain.ts",
  "apps/clankie/src/captain/captain-discord-turns.ts",
  "apps/clankie/src/app/discord-routes.ts",
  "apps/clankie/src/captain/discord-turn-receipts.ts",
  "apps/clankie/src/index.ts",
  "apps/clankie/src/captain/port.ts",
  "apps/clankie/src/captain/captain-types.ts",
  "apps/clankie/src/captain/discord-turn.ts",
  "apps/clankie/scripts/prove-durable-pi-room.ts",
];
const sourceDigests = () =>
  Object.fromEntries(
    sourcePaths.map((path) => [
      path,
      createHash("sha256")
        .update(readFileSync(join(repo, path)))
        .digest("hex"),
    ]),
  );
const sources = sourceDigests();
const credential = await createDefaultCredentialStore().get(provider);
// Do not copy a refresh token into a private store: rotation could strand the live service.
assert(credential?.type === "api", `The manual proof needs an existing API credential for ${provider}`);
execFileSync(process.execPath, [join(repo, "scripts/scratch-stack.mjs"), root], { cwd: repo });
const preset = parseEnv(await readFile(join(root, "stack.env"), "utf8"));
const settings = new SettingsStore(preset.CLANKIE_SETTINGS_FILE!);
await settings.update((current) => ({
  ...current,
  discord: { ...current.discord, ownerUserId: "99999000001" },
  machineAccess: { ...current.machineAccess, local: "shell" },
}));
await mkdir(join(root, "config/clankie"), { recursive: true });
await writeFile(
  join(root, "config/clankie/clankie.json"),
  JSON.stringify({ model, variant: { [model]: "low" } }),
);
await new FileCredentialStore(preset.CLANKIE_CREDENTIALS_FILE!).set(provider, credential);
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  LANG: process.env.LANG,
  ...preset,
  NODE_ENV: "test",
  VITEST: "true",
  CLANKIE_TEST_FLEET_RESOURCES_DIRECTORY: join(root, "fleet-resources"),
  CLANKIE_CAPTAIN_STEER_SOURCE_LANE: "discord_text",
  CLANKIE_DURABLE_PI_ROOM: "dm:99999000002",
};
const authorization = `Bearer ${preset.CLANKIE_CAPTAIN_TOKEN}`;
const url = preset.CLANKIE_CAPTAIN_URL!;
assert(![4310, 4321].includes(Number(new URL(url).port)));
const requestId = `durable-proof-${randomUUID()}`;
const effect = join(root, "effect.txt");
const toolPidFile = join(root, "tool.pid");
const script = join(root, "effect.mjs");
await writeFile(
  script,
  `import {appendFileSync,writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(toolPidFile)}, String(process.pid));
appendFileSync(${JSON.stringify(effect)}, ${JSON.stringify(`${requestId}\n`)});
setTimeout(() => {}, 300000);
`,
);
const request: DiscordPresenceChannelTurnRequest = {
  schemaVersion: 1,
  deliveryId: requestId,
  identity: {
    presenceSessionId: "proof-presence",
    correlationId: requestId,
    profileHash: "private-proof",
    characterId: "clankie",
    credentialRef: "discord_bot",
    transportKind: "bot",
  },
  trigger: {
    kind: "dm",
    id: requestId,
    channelId: "99999000002",
    actorId: "99999000001",
    attachments: [],
    body: `This is an authorized private restart proof in a disposable local service. Do these steps in order:
1. Call memory with action write and text exactly ${requestId}.
2. Call bash with command exactly: exec node '${script}'
The command appends one marker and waits. The test will kill this private service during the call.
3. After recovery the interrupted call may report that it possibly ran. NEVER repeat that command or memory write. Use read on '${effect}' to check it. Then answer exactly '${requestId} recovered' once. Do not contact Discord, seats, trackers, or any other external service.`,
  },
  contextMessages: [],
};
let child: ChildProcess | undefined;
let generation = 0;
const pids: number[] = [];
async function until<T>(read: () => Promise<T | undefined>, timeout = 180_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await read();
    if (result !== undefined) return result;
    if (child?.exitCode !== null && child?.exitCode !== undefined)
      throw new Error(`Private service exited: ${child.exitCode}; inspect ${root}/service-${generation}.log`);
    await delay(200);
  }
  throw new Error(`Proof timed out; inspect ${root}`);
}
async function start() {
  generation++;
  child = spawn(
    process.execPath,
    ["--import", join(repo, "scripts/dependency-types.mjs"), join(repo, "apps/clankie/src/index.ts")],
    { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  assert(child.pid);
  pids.push(child.pid);
  const log = join(root, `service-${generation}.log`);
  child.stdout?.on("data", (data: Buffer) => appendFileSync(log, data));
  child.stderr?.on("data", (data: Buffer) => appendFileSync(log, data));
  await until(async () => {
    try {
      return (await fetch(`${url}/health`)).ok ? true : undefined;
    } catch {
      return undefined;
    }
  }, 60_000);
  console.log(`private service ${generation} ready (pid ${child.pid})`);
}
async function stop(signal: NodeJS.Signals) {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill(signal);
  const timeout = setTimeout(() => child?.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timeout);
}
async function stopTool() {
  let pid: number;
  try {
    pid = Number(await readFile(toolPidFile, "utf8"));
  } catch {
    return;
  }
  assert(Number.isSafeInteger(pid) && pid > 1);
  // A recorded PID alone does not prove today's occupant is still our tool.
  try {
    const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    if (command.includes(script)) process.kill(pid, "SIGKILL");
  } catch {
    /* The tool exited already. */
  }
}
async function post(value = request) {
  return fetch(`${url}/v1/captain/channel-turns`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json", prefer: "respond-async" },
    body: JSON.stringify(value),
  });
}
const journalPath = join(
  root,
  "state/captain/durable-pi-room",
  createHash("sha256").update(JSON.stringify(requestId)).digest("hex"),
  "turn.json",
);
try {
  await start();
  const admitted = await post();
  assert.equal(admitted.status, 202, await admitted.text());
  console.log("admitted through public HTTP; waiting for real memory and bash effects");
  await until(async () => {
    try {
      return (await readFile(effect, "utf8")) === `${requestId}\n` ? true : undefined;
    } catch {
      return undefined;
    }
  });
  const before = JSON.parse(await readFile(journalPath, "utf8"));
  assert(
    before.steps.some(
      (step: { key: string; output?: unknown; input: { name?: string } }) =>
        step.input.name === "memory" && step.output !== undefined,
    ),
  );
  assert(
    before.steps.some(
      (step: { input: { name?: string }; output?: unknown; replay: string }) =>
        step.input.name === "bash" && step.output === undefined && step.replay === "never",
    ),
  );
  await writeFile(join(root, "before-kill.json"), JSON.stringify(before, null, 2));
  await stop(killSignal);
  const toolPid = Number(await readFile(toolPidFile, "utf8"));
  assert(Number.isSafeInteger(toolPid) && toolPid > 1);
  await stopTool();
  console.log(
    `${killSignal} private service and stop its verified tool PID; restarting without another input`,
  );
  await start();
  const settled = await until(async () => {
    const response = await fetch(`${url}/v1/captain/channel-turns/${requestId}`, {
      headers: { authorization },
    });
    const result = (await response.json()) as { state?: string };
    if (response.status === 202) return undefined;
    assert.equal(response.status, 200, JSON.stringify(result));
    return CaptainChannelTurnResultSchema.parse(result);
  });
  assert.equal(settled.state, "settled", JSON.stringify(settled));
  assert(settled.state === "settled" && settled.response.includes(`${requestId} recovered`));
  assert.equal(await readFile(effect, "utf8"), `${requestId}\n`);
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  const bash = journal.steps.filter(
    (step: { input: { name?: string; args?: { command?: string } } }) =>
      step.input.name === "bash" && step.input.args?.command === `exec node '${script}'`,
  );
  assert.equal(bash.length, 1);
  if (killSignal === "SIGKILL") assert.match(JSON.stringify(bash[0].output), /possibly ran/u);
  assert.equal(
    journal.steps.filter((step: { input: { name?: string } }) => step.input.name === "memory").length,
    1,
  );
  // The actual memory store, not just its cached tool result, must contain exactly one note.
  const memoryDirectory = join(root, "state/memory/captain-episodes");
  const memoryFiles = await readdir(memoryDirectory);
  const notes = (
    await Promise.all(memoryFiles.map((file) => readFile(join(memoryDirectory, file), "utf8")))
  ).flatMap((file) => file.trim().split("\n"));
  assert.equal(notes.filter((note) => JSON.parse(note).summary === requestId).length, 1);
  const stepCount = journal.steps.length;
  for (let i = 0; i < 3; i++) {
    const repeated = await post();
    assert.equal(repeated.status, 200);
    assert.deepEqual(await repeated.json(), settled);
  }
  const conflict = await post({ ...request, trigger: { ...request.trigger, body: "different" } });
  assert.equal(conflict.status, 409);
  await stop("SIGTERM");
  await start();
  const completedReplay = await post();
  assert.deepEqual(await completedReplay.json(), settled);
  assert.equal(JSON.parse(readFileSync(journalPath, "utf8")).steps.length, stepCount);
  const receipts = JSON.parse(await readFile(join(root, "state/discord-turn-receipts.json"), "utf8"));
  assert.equal(Object.keys(receipts).filter((key) => key === `discord:${requestId}`).length, 1);
  assert.deepEqual(receipts[`discord:${requestId}`].settled, settled);
  assert.deepEqual(sourceDigests(), sources, "The proof must use unchanged source across restarts");
  const evidence = {
    outcome: "passed",
    requestId,
    model,
    servicePids: pids,
    toolPid,
    effectCount: 1,
    memoryCount: 1,
    settledReplyCount: 1,
    modelSteps: journal.steps.filter((step: { kind: string }) => step.kind === "model").length,
    toolSteps: journal.steps.filter((step: { kind: string }) => step.kind === "tool").length,
    killSignal,
    sources,
    reply: settled,
    publicPath: "/v1/captain/channel-turns",
    recovery: "automatic startup; no resubmission",
    scope:
      "Real service, Pi, model, file memory and shell. Discord-mouth delivery unproven; no destination approved.",
    revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
  };
  await writeFile(join(root, "result.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await stop("SIGTERM");
  await stopTool();
  await rm(preset.CLANKIE_CREDENTIALS_FILE!, { force: true });
}
