import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "node:util";
import { afterEach, expect, it } from "vitest";
import { CaptainChannelTurnResultSchema, type DiscordPresenceChannelTurnRequest } from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";

// ADR 0284's prototype lane, the regression base for rolling it out (#368): the
// real service process, Pi, journal, file memory and shell, killed mid-tool and
// started again with no new input. Only the model is a scripted loopback
// OpenAI-compatible endpoint, so this proves the restart contract, not model
// behaviour. Discord is not involved; its delivery hop stays unproven here.
const repo = resolve(import.meta.dirname, "../../..");
const OWNER = "99999000001";
const DM = "99999000002";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: { function: { name: string } }[];
}

/** Scripted model: memory write, then a shell call that blocks, then a final answer naming what it saw. */
async function scriptedModel(requestId: string, script: string) {
  const seen: ChatMessage[][] = [];
  const server: Server = createServer(async (incoming, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: ChatMessage[] };
    seen.push(body.messages);
    const tools = body.messages.filter((message) => message.role === "tool");
    const last = tools.at(-1);
    const sse = (delta: object, finish: string | null) =>
      `data: ${JSON.stringify({
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "scripted",
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(finish === null ? {} : { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      })}\n\n`;
    const call = (name: string, args: object) =>
      sse(
        {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call_${name}_${tools.length}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        null,
      ) + sse({}, "tool_calls");
    response.writeHead(200, { "content-type": "text/event-stream" });
    const text =
      tools.length === 0
        ? call("memory", { action: "write", text: requestId })
        : tools.length === 1
          ? call("bash", { command: `exec node '${script}'` })
          : sse(
              {
                role: "assistant",
                content: `${requestId} recovered: ${JSON.stringify(last?.content ?? "").includes("possibly ran") ? "possibly ran" : "completed"}`,
              },
              null,
            ) + sse({}, "stop");
    response.end(`${text}data: [DONE]\n\n`);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing loopback address");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  return { url: `http://127.0.0.1:${address.port}/v1`, seen };
}

async function privateService() {
  const root = await mkdtemp(join(tmpdir(), "durable-pi-restart-"));
  const requestId = `durable-${randomUUID()}`;
  const effect = join(root, "effect.txt");
  const toolPid = join(root, "tool.pid");
  const script = join(root, "effect.mjs");
  await writeFile(
    script,
    `import {appendFileSync,writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(toolPid)}, String(process.pid));
appendFileSync(${JSON.stringify(effect)}, ${JSON.stringify(`${requestId}\n`)});
setTimeout(() => {}, 300000);
`,
  );
  const model = await scriptedModel(requestId, script);
  execFileSync(process.execPath, [join(repo, "scripts/scratch-stack.mjs"), root], { cwd: repo });
  const preset = parseEnv(await readFile(join(root, "stack.env"), "utf8"));
  const settings = new SettingsStore(preset.CLANKIE_SETTINGS_FILE!);
  await settings.update((current) => ({
    ...current,
    discord: { ...current.discord, ownerUserId: OWNER },
    machineAccess: { ...current.machineAccess, local: "shell" },
  }));
  await mkdir(join(root, "config/clankie"), { recursive: true });
  await writeFile(
    join(root, "config/clankie/clankie.json"),
    JSON.stringify({
      model: "fixture/scripted",
      provider: {
        fixture: {
          name: "fixture",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: model.url },
          models: { scripted: { name: "scripted", limit: { context: 100000, output: 512 } } },
        },
      },
    }),
  );
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG,
    ...preset,
    NODE_ENV: "test",
    VITEST: "true",
    CLANKIE_TEST_FLEET_RESOURCES_DIRECTORY: join(root, "fleet-resources"),
    CLANKIE_CAPTAIN_STEER_SOURCE_LANE: "discord_text",
    CLANKIE_DURABLE_PI_ROOM: `dm:${DM}`,
  };
  const url = preset.CLANKIE_CAPTAIN_URL!;
  const authorization = `Bearer ${preset.CLANKIE_CAPTAIN_TOKEN}`;
  let child: ChildProcess | undefined;
  let generation = 0;
  const until = async <T>(read: () => Promise<T | undefined>, timeout = 90_000): Promise<T> => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = await read();
      if (value !== undefined) return value;
      if (child?.exitCode !== null && child?.exitCode !== undefined)
        throw new Error(`Private service exited ${child.exitCode}; see ${root}/service-${generation}.log`);
      await delay(100);
    }
    throw new Error(`Timed out; see ${root}`);
  };
  const start = async () => {
    generation++;
    const log = join(root, `service-${generation}.log`);
    child = spawn(
      process.execPath,
      ["--import", join(repo, "scripts/dependency-types.mjs"), join(repo, "apps/clankie/src/index.ts")],
      { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout?.on("data", (data: Buffer) => appendFileSync(log, data));
    child.stderr?.on("data", (data: Buffer) => appendFileSync(log, data));
    await until(async () => {
      try {
        return (await fetch(`${url}/health`)).ok ? true : undefined;
      } catch {
        return undefined;
      }
    });
  };
  const stop = async (signal: NodeJS.Signals) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill(signal);
    await exited;
  };
  /** Stops the shell tool only after confirming the recorded PID still runs our script. */
  const stopTool = async () => {
    const pid = Number(await readFile(toolPid, "utf8").catch(() => "0"));
    if (!Number.isSafeInteger(pid) || pid <= 1) return;
    try {
      const command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
      if (command.includes(script)) process.kill(pid, "SIGKILL");
    } catch {
      // Already exited.
    }
  };
  cleanups.push(async () => {
    await stop("SIGKILL");
    await stopTool();
    await rm(root, { recursive: true, force: true });
  });
  const request: DiscordPresenceChannelTurnRequest = {
    schemaVersion: 1,
    deliveryId: requestId,
    identity: {
      presenceSessionId: "restart-presence",
      correlationId: requestId,
      profileHash: "private-restart",
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
    },
    trigger: {
      kind: "dm",
      id: requestId,
      channelId: DM,
      actorId: OWNER,
      attachments: [],
      body: "Write the marker to memory, then run the effect script.",
    },
    contextMessages: [],
  };
  const post = (value: DiscordPresenceChannelTurnRequest = request) =>
    fetch(`${url}/v1/captain/channel-turns`, {
      method: "POST",
      headers: { authorization, "content-type": "application/json", prefer: "respond-async" },
      body: JSON.stringify(value),
    });
  const settled = () =>
    until(async () => {
      const response = await fetch(`${url}/v1/captain/channel-turns/${requestId}`, {
        headers: { authorization },
      });
      if (response.status === 202) return undefined;
      expect(response.status).toBe(200);
      return CaptainChannelTurnResultSchema.parse(await response.json());
    });
  const journal = async () =>
    JSON.parse(
      await readFile(
        join(
          root,
          "state/captain/durable-pi-room",
          createHash("sha256").update(JSON.stringify(requestId)).digest("hex"),
          "turn.json",
        ),
        "utf8",
      ),
    ) as { steps: { kind: string; replay?: string; input: { name?: string }; output?: unknown }[] };
  const effects = async () => (await readFile(effect, "utf8").catch(() => "")).split("\n").filter(Boolean);
  const memories = async () => {
    const directory = join(root, "state/memory/captain-episodes");
    const files = await readdir(directory).catch(() => [] as string[]);
    return (await Promise.all(files.map((file) => readFile(join(directory, file), "utf8"))))
      .flatMap((text) => text.trim().split("\n"))
      .filter(Boolean)
      .filter((line) => (JSON.parse(line) as { summary?: string }).summary === requestId);
  };
  /** Admits the turn, waits until the shell effect is in flight, then SIGKILLs the service and its tool. */
  const killMidShell = async () => {
    await start();
    expect((await post()).status).toBe(202);
    await until(async () => ((await effects()).length === 1 ? true : undefined));
    const before = await journal();
    expect(before.steps.find((step) => step.input.name === "memory")?.output).toBeDefined();
    expect(before.steps.find((step) => step.input.name === "bash")).toMatchObject({ replay: "never" });
    expect(before.steps.find((step) => step.input.name === "bash")?.output).toBeUndefined();
    await stop("SIGKILL");
    await stopTool();
  };
  return {
    requestId,
    request,
    settings,
    model,
    start,
    stop,
    post,
    settled,
    journal,
    effects,
    memories,
    killMidShell,
  };
}

it("resumes a turn killed mid-shell with no new input: the shell surfaces as possibly ran and nothing repeats", async () => {
  const f = await privateService();
  await f.killMidShell();
  const asked = f.model.seen.length;
  await f.start();
  const result = await f.settled();
  expect(result).toMatchObject({ state: "settled", response: `${f.requestId} recovered: possibly ran` });
  // Completed model steps came from the journal: after the restart the model was asked once, for the answer.
  expect(f.model.seen.length).toBe(asked + 1);
  expect(await f.effects()).toHaveLength(1);
  expect(await f.memories()).toHaveLength(1);
  const journal = await f.journal();
  expect(journal.steps.filter((step) => step.input.name === "bash")).toHaveLength(1);
  expect(JSON.stringify(journal.steps.find((step) => step.input.name === "bash")?.output)).toContain(
    "possibly ran",
  );
  // The same delivery replays its saved result; a changed request under its id is refused.
  for (let i = 0; i < 2; i++) {
    const again = await f.post();
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(result);
  }
  expect((await f.post({ ...f.request, trigger: { ...f.request.trigger, body: "different" } })).status).toBe(
    409,
  );
  // And a clean restart after settlement replays it without another model call.
  await f.stop("SIGTERM");
  await f.start();
  const replayed = await f.post();
  expect(await replayed.json()).toEqual(result);
  expect(f.model.seen.length).toBe(asked + 1);
}, 240_000);

it("a grant changed while the service was down fails the resumed turn closed, with no tool or model step", async () => {
  const f = await privateService();
  await f.killMidShell();
  const asked = f.model.seen.length;
  const steps = (await f.journal()).steps.length;
  // The sender is no longer the owner: the saved request is evidence of admission, never authority.
  await f.settings.update((current) => ({
    ...current,
    discord: { ...current.discord, ownerUserId: "99999000077" },
  }));
  await f.start();
  const result = await f.settled();
  // The first test is the control: the same kill and restart with unchanged settings settles.
  expect(result).toMatchObject({ state: "failed", code: "captain_turn_failed" });
  expect(f.model.seen.length).toBe(asked);
  expect(await f.effects()).toHaveLength(1);
  expect(await f.memories()).toHaveLength(1);
  expect((await f.journal()).steps.length).toBe(steps);
}, 240_000);
