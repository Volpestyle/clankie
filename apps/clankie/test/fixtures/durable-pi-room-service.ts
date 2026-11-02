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
import { expect } from "vitest";
import { CaptainChannelTurnResultSchema, type DiscordPresenceChannelTurnRequest } from "@clankie/protocol";
import { DiscordPresenceSession } from "@clankie/discord-presence-core";
import type { DiscordPresenceSessionRecord } from "@clankie/interactive-environment";
import { SettingsStore } from "@clankie/settings";

// ADR 0284's prototype lane as a child process (#368): the real service, Pi,
// journal, file memory and shell, killed mid-tool and started again. Only the
// model is a scripted loopback OpenAI-compatible endpoint, so a test built on
// this proves the restart contract, not model behaviour.
const repo = resolve(import.meta.dirname, "../../../..");
export const OWNER = "99999000001";
export const DM = "99999000002";
/** Teardown for everything started here; a test drains it in afterEach. */
export const cleanups: (() => Promise<void>)[] = [];

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

/**
 * `env` adds to the child's environment, e.g. a Discord presence runtime
 * module. `requestId` is the delivery ID; a bridge uses the Discord message ID.
 */
export async function privateService(options: { env?: NodeJS.ProcessEnv; requestId?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "durable-pi-restart-"));
  const requestId = options.requestId ?? `durable-${randomUUID()}`;
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
    ...options.env,
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
  /** A live bot body, as the bridge opens on each start; room guards need it to reply. */
  const presence = async () => {
    const session = new DiscordPresenceSession({
      sessionId: `discord:bot:fixture:${randomUUID()}`,
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
      emit: async (event) => {
        const response = await fetch(`${url}/v1/discord/presence-session-events`, {
          method: "POST",
          headers: { authorization, "content-type": "application/json" },
          body: JSON.stringify(event),
        });
        if (!response.ok) throw new Error(`presence ${response.status}: ${await response.text()}`);
        return ((await response.json()) as { session: DiscordPresenceSessionRecord }).session;
      },
    });
    await session.start();
    await session.gatewayReady();
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
    ) as {
      result?: unknown;
      steps: { kind: string; replay?: string; input: { name?: string }; output?: unknown }[];
    };
  const effects = async () => (await readFile(effect, "utf8").catch(() => "")).split("\n").filter(Boolean);
  const memories = async () => {
    const directory = join(root, "state/memory/captain-episodes");
    const files = await readdir(directory).catch(() => [] as string[]);
    return (await Promise.all(files.map((file) => readFile(join(directory, file), "utf8"))))
      .flatMap((text) => text.trim().split("\n"))
      .filter(Boolean)
      .filter((line) => (JSON.parse(line) as { summary?: string }).summary === requestId);
  };
  /** The room handoff records the service keeps for this delivery, as the room's handoff view reads them. */
  const handoffs = async () => {
    const directory = join(root, "state/captain/conversations");
    const entries = (await readdir(directory).catch(() => [] as string[])).filter((name) =>
      name.startsWith("handoff-"),
    );
    return (
      await Promise.all(
        entries.map(
          async (name) =>
            JSON.parse(await readFile(join(directory, name, "meta.json"), "utf8")) as {
              roomHandoff: { deliveryId: string; state: string; host?: string; result?: string };
            },
        ),
      )
    )
      .map((meta) => meta.roomHandoff)
      .filter((handoff) => handoff.deliveryId === requestId);
  };
  /** Admits the turn, waits until the shell effect is in flight, then SIGKILLs the service and its tool. */
  const killMidShell = async (signal: NodeJS.Signals = "SIGKILL") => {
    await start();
    await presence();
    expect((await post()).status).toBe(202);
    await until(async () => ((await effects()).length === 1 ? true : undefined));
    const before = await journal();
    expect(before.steps.find((step) => step.input.name === "memory")?.output).toBeDefined();
    expect(before.steps.find((step) => step.input.name === "bash")).toMatchObject({ replay: "never" });
    expect(before.steps.find((step) => step.input.name === "bash")?.output).toBeUndefined();
    expect(await handoffs()).toMatchObject([{ state: "running", host: "pi" }]);
    await stop(signal);
    await stopTool();
  };
  return {
    root,
    url,
    authorization,
    requestId,
    request,
    settings,
    model,
    until,
    start,
    presence,
    stop,
    stopTool,
    post,
    settled,
    journal,
    effects,
    memories,
    handoffs,
    killMidShell,
  };
}
