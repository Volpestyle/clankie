/**
 * VUH-2796 manual lanes eval: the same golden prompts through every lane of a private
 * scratch service, graded for one voice, correct answers, trust boundaries and tool choice.
 * Manual only (ADR 0221): never part of a check, CI, a timer or a release. Run through
 * `clankie heavy --server`; it never targets the live service or Discord.
 */
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { parseArgs, parseEnv, promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createDefaultCredentialStore, FileCredentialStore } from "@clankie/credential-broker";
import { DiscordPresenceSession } from "@clankie/discord-presence-core";
import { SettingsStore } from "@clankie/settings";
import { CaptainChannelTurnResultSchema, type DiscordPresenceChannelTurnRequest } from "@clankie/protocol";
import {
  CASES,
  LANES,
  SEEDED_EPISODES,
  shingles,
  type Lane,
  type LaneCase,
  type Observation,
} from "./lanes-eval-cases.ts";

const run = promisify(execFile);
const repo = resolve(import.meta.dirname, "../../..");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string" },
    effort: { type: "string" },
    reps: { type: "string", default: "2" },
    "max-turns": { type: "string", default: "0" },
    lanes: { type: "string" },
    cases: { type: "string" },
    smoke: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});
const lanes = (values.lanes?.split(",") ?? LANES) as Lane[];
const cases = values.cases ? CASES.filter((c) => values.cases!.split(",").includes(c.id)) : CASES;
for (const lane of lanes) assert(LANES.includes(lane), `Unknown lane ${lane}`);
assert(cases.length > 0, "No cases selected");
const reps = Number(values.reps);
assert(Number.isSafeInteger(reps) && reps > 0);
const planned = reps * lanes.length * cases.reduce((sum, c) => sum + (c.setup ? 2 : 1), 0);
const model = values.smoke ? "evalfake/scripted" : values.model;
console.log(
  JSON.stringify(
    { lanes, cases: cases.map((c) => c.id), reps, plannedTurns: planned, model: model ?? null },
    null,
    2,
  ),
);
if (values["dry-run"]) process.exit(0);
assert(!process.env.CI, "The lanes eval is manual-only; it refuses to run under CI");
assert(model, "Pass --model PROVIDER/MODEL, or --smoke for the zero-cost plumbing check");
assert(
  values.smoke || Number(values["max-turns"]) >= planned,
  `A real campaign spends model quota: pass --max-turns ${planned} or more to authorize it`,
);
const root = resolve(positionals[0] ?? join(repo, ".local/vuh-2796", `lanes-${Date.now()}`));
assert(!existsSync(root), `Use a new output directory; ${root} exists`);
const provider = model.slice(0, model.indexOf("/"));
const credential = values.smoke
  ? { type: "api" as const, key: "eval-fake" }
  : await createDefaultCredentialStore().get(provider);
// Never copy an OAuth refresh token: rotation could strand the live service.
assert(credential?.type === "api", `The eval needs an existing API credential for ${provider}`);
const instructions = shingles(await readFile(join(repo, "apps/clankie/src/captain/instructions.md"), "utf8"));
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

/** A scripted OpenAI-compatible endpoint for --smoke: proves plumbing, never answers well. */
async function fakeModel(): Promise<{ server: Server; baseURL: string; offered: Set<string> }> {
  // Tool names the service offered since the last turn: the smoke run's view of each lane's surface.
  const offered = new Set<string>();
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk));
    request.on("end", () => {
      const parsed = JSON.parse(body || "{}") as {
        messages?: { content?: unknown }[];
        tools?: { function?: { name?: string } }[];
      };
      for (const tool of parsed.tools ?? []) if (tool.function?.name) offered.add(tool.function.name);
      const last = JSON.stringify(parsed.messages?.at(-1)?.content ?? "");
      const text = `i'm clankie. smoke reply to ${last.length} characters.`;
      const chunk = (delta: object, finish: string | null) =>
        `data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(chunk({ role: "assistant", content: text }, null));
      response.write(chunk({}, "stop"));
      response.write(
        `data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address !== null && typeof address === "object");
  return { server, baseURL: `http://127.0.0.1:${address.port}/v1`, offered };
}

interface Turn {
  readonly rep: number;
  readonly lane: Lane;
  readonly caseId: string;
  readonly step: "setup" | "prompt";
  readonly response: string;
  readonly state: string;
  readonly ms: number;
  readonly tools: Record<string, number>;
  readonly totalTokens: number | null;
  /** Smoke only: every tool name the model was offered during the turn. */
  readonly offeredTools?: string[];
}

const OWNER = "99999000001";
const GUEST = "99999000010";
const GUILD = "99999100001";
const fake = values.smoke ? await fakeModel() : undefined;
const turns: Turn[] = [];
const graded: (Observation & { rep: number; caseId: string; pass: boolean; why: string })[] = [];

async function campaign(rep: number) {
  const dir = join(root, `rep-${rep}`);
  execFileSync(process.execPath, [join(repo, "scripts/scratch-stack.mjs"), dir], { cwd: repo });
  const preset = parseEnv(await readFile(join(dir, "stack.env"), "utf8"));
  const url = preset.CLANKIE_CAPTAIN_URL!;
  assert(![4310, 4321].includes(Number(new URL(url).port)));
  const settings = new SettingsStore(preset.CLANKIE_SETTINGS_FILE!);
  await settings.update((current) => ({
    ...current,
    discord: { ...current.discord, ownerUserId: OWNER },
    machineAccess: { ...current.machineAccess, local: "shell" },
  }));
  await mkdir(join(dir, "config/clankie"), { recursive: true });
  await writeFile(
    join(dir, "config/clankie/clankie.json"),
    JSON.stringify({
      model,
      ...(values.effort === undefined ? {} : { variant: { [model!]: values.effort } }),
      ...(fake === undefined
        ? {}
        : {
            provider: {
              evalfake: {
                name: "eval fake",
                npm: "@ai-sdk/openai-compatible",
                options: { baseURL: fake.baseURL },
                models: { scripted: { tool_call: true, limit: { context: 200000, output: 4096 } } },
              },
            },
          }),
    }),
  );
  await new FileCredentialStore(preset.CLANKIE_CREDENTIALS_FILE!).set(provider, credential!);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG,
    ...preset,
    NODE_ENV: "test",
    VITEST: "true",
    CLANKIE_TEST_FLEET_RESOURCES_DIRECTORY: join(dir, "fleet-resources"),
  };
  // Seeded into the private store before start: the episode route only takes host-admitted sources.
  const episodes = join(preset.CLANKIE_STATE!, "memory/captain-episodes");
  await mkdir(episodes, { recursive: true });
  await writeFile(
    join(episodes, "operator.jsonl"),
    SEEDED_EPISODES.map((episode) =>
      JSON.stringify({
        schemaVersion: 1,
        ...episode,
        visibility: "operator_private",
        provenance: {
          characterId: "clankie",
          sessionId: "eval-seed",
          selfAuthored: true,
          rawTranscript: false,
        },
      }),
    ).join("\n") + "\n",
  );
  let child: ChildProcess | undefined;
  try {
    child = spawn(
      process.execPath,
      ["--import", join(repo, "scripts/dependency-types.mjs"), join(repo, "apps/clankie/src/index.ts")],
      { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const log = join(dir, "service.log");
    child.stdout?.on("data", (data: Buffer) => appendFileSync(log, data));
    child.stderr?.on("data", (data: Buffer) => appendFileSync(log, data));
    await until(
      // allow-swallowed-rejection -- a refused connection means the service is still starting.
      async () => ((await fetch(`${url}/health`).catch(() => undefined))?.ok ? true : undefined),
      90_000,
    );
    // The bridges' own bearers: the channel-turn route admits text and voice only from their lanes.
    const store = new FileCredentialStore(preset.CLANKIE_CREDENTIALS_FILE!);
    const bearer = async (providerId: string) => {
      const stored = await store.get(providerId);
      assert(stored?.type === "api", `scratch service minted no ${providerId}`);
      return { authorization: `Bearer ${stored.key}` };
    };
    const textBridge = await bearer("clankie_discord_bridge");
    const voiceBridge = await bearer("clankie_discord_voice_bridge");
    // A live bot gateway, as the bridge reports it: room work runs only while its mouth can reply.
    const presence = new DiscordPresenceSession({
      sessionId: `eval-${rep}`,
      characterId: "clankie",
      credentialRef: "discord_bot",
      transportKind: "bot",
      emit: async (event) => {
        const response = await fetch(`${url}/v1/discord/presence-session-events`, {
          method: "POST",
          headers: { ...textBridge, "content-type": "application/json" },
          body: JSON.stringify(event),
        });
        const text = await response.text();
        assert(response.ok, text);
        return (JSON.parse(text) as { session: never }).session;
      },
    });
    await presence.start();
    await presence.gatewayReady();
    const settled = join(dir, "state/captain/turn-settled.jsonl");
    const cli = async (...args: string[]) =>
      (
        await run(process.execPath, [join(repo, "scripts/scratch-stack.mjs"), "run", dir, "cli", ...args], {
          cwd: repo,
          maxBuffer: 64 * 1024 * 1024,
        })
      ).stdout;

    /** One Discord delivery through the bridge's own route, polled as the bridge polls. */
    async function discord(
      lane: Lane,
      c: LaneCase,
      body: string,
      context: DiscordPresenceChannelTurnRequest["contextMessages"],
    ) {
      const index = CASES.indexOf(c);
      const deliveryId = `${rep}${index}${Date.now()}`;
      const dm = lane === "owner-dm";
      // A fresh room per case keeps one case's answers out of the next.
      const roomChannelId = `${lane === "voice" ? 99999300 : dm ? 99999400 : 99999200}${String(index).padStart(3, "0")}`;
      const request: DiscordPresenceChannelTurnRequest = {
        schemaVersion: 1,
        deliveryId,
        identity: {
          presenceSessionId: `discord:${dm ? "dm" : GUILD}:${roomChannelId}`,
          correlationId: deliveryId,
          profileHash: "unversioned",
          characterId: "clankie",
          credentialRef: "discord_bot",
          transportKind: "bot",
        },
        trigger: {
          kind: lane === "voice" ? "voice_event" : dm ? "dm" : "mention",
          id: deliveryId,
          ...(dm ? {} : { guildId: GUILD }),
          channelId: roomChannelId,
          ...(lane === "voice" ? {} : { messageId: deliveryId }),
          actorId: dm ? OWNER : GUEST,
          body,
          attachments: [],
        },
        contextMessages: context,
      };
      const bridge = lane === "voice" ? voiceBridge : textBridge;
      const response = await fetch(`${url}/v1/captain/channel-turns`, {
        method: "POST",
        headers: { ...bridge, "content-type": "application/json", prefer: "respond-async" },
        body: JSON.stringify(request),
      });
      assert(
        [200, 202].includes(response.status),
        `${lane}/${c.id}: ${response.status} ${await response.text()}`,
      );
      const result =
        response.status === 200
          ? CaptainChannelTurnResultSchema.parse(await response.json())
          : await until(async () => {
              const poll = await fetch(`${url}/v1/captain/channel-turns/${deliveryId}`, { headers: bridge });
              if (poll.status === 202) return undefined;
              return CaptainChannelTurnResultSchema.parse(await poll.json());
            }, 600_000);
      return {
        state: result.state,
        response:
          result.state === "settled"
            ? result.response
            : result.state === "failed"
              ? `[failed: ${result.code}]`
              : "",
        messageId: deliveryId,
      };
    }

    /** One owner console message to the Pi head's main chat, read back from its journal. */
    async function console_(body: string) {
      const before = Date.now();
      const receipt = JSON.parse(await cli("send", "--conversation", "global-default", body)) as {
        runId?: string;
      };
      assert(receipt.runId, `console send refused: ${JSON.stringify(receipt)}`);
      type Event = {
        type: string;
        phase?: string;
        runId?: string;
        role?: string;
        text?: string;
        occurredAt: string;
      };
      const events = await until(async () => {
        const all: Event[] = [];
        let cursor: string | undefined;
        for (;;) {
          const page = JSON.parse(
            await cli(
              "conversations",
              "show",
              "global-default",
              "--limit",
              "100",
              ...(cursor ? ["--cursor", cursor] : []),
            ),
          ) as { events?: Event[]; hasMore?: boolean; nextCursor?: string };
          all.push(...(page.events ?? []));
          if (!page.hasMore || !page.nextCursor) break;
          cursor = page.nextCursor;
        }
        const done = all.some(
          (e) =>
            e.type === "turn" &&
            e.runId === receipt.runId &&
            ["completed", "failed", "interrupted"].includes(e.phase ?? ""),
        );
        return done ? all : undefined;
      }, 600_000);
      const replies = events.filter(
        (e) => e.type === "message" && e.role === "captain" && Date.parse(e.occurredAt) >= before - 1000,
      );
      const failed = events.some(
        (e) =>
          e.type === "turn" && e.runId === receipt.runId && ["failed", "interrupted"].includes(e.phase ?? ""),
      );
      return { state: failed ? "failed" : "settled", response: replies.map((e) => e.text ?? "").join("\n") };
    }

    async function ask(
      lane: Lane,
      c: LaneCase,
      step: "setup" | "prompt",
      body: string,
      context: DiscordPresenceChannelTurnRequest["contextMessages"],
    ) {
      const started = Date.now();
      fake?.offered.clear();
      const result = lane === "console" ? await console_(body) : await discord(lane, c, body, context);
      const ms = Date.now() - started;
      // Rows that settled inside this turn's window are this turn's (cases run one at a time).
      const rows = existsSync(settled)
        ? (await readFile(settled, "utf8"))
            .trim()
            .split("\n")
            .filter(Boolean)
            .map(
              (line) =>
                JSON.parse(line) as {
                  acceptedAt: string;
                  toolCount?: Record<string, number>;
                  usage?: { totalTokens?: number };
                },
            )
            .filter((row) => Date.parse(row.acceptedAt) >= started - 2000)
        : [];
      const tools: Record<string, number> = {};
      for (const row of rows)
        for (const [name, count] of Object.entries(row.toolCount ?? {}))
          tools[name] = (tools[name] ?? 0) + count;
      const tokens = rows
        .map((row) => row.usage?.totalTokens)
        .filter((n): n is number => typeof n === "number");
      const turn: Turn = {
        rep,
        lane,
        caseId: c.id,
        step,
        response: result.response,
        state: result.state,
        ms,
        tools,
        totalTokens: tokens.length ? tokens.reduce((a, b) => a + b, 0) : null,
        ...(fake === undefined ? {} : { offeredTools: [...fake.offered].sort() }),
      };
      turns.push(turn);
      appendFileSync(join(root, "turns.jsonl"), `${JSON.stringify(turn)}\n`);
      console.log(`rep ${rep} ${lane} ${c.id}/${step}: ${result.state} in ${(ms / 1000).toFixed(1)}s`);
      return { ...result, ms };
    }

    for (const lane of lanes)
      for (const c of cases) {
        const context: DiscordPresenceChannelTurnRequest["contextMessages"] = [];
        if (c.setup) {
          const setup = await ask(lane, c, "setup", c.setup, []);
          // The bridge supplies recent room messages; voice carries none.
          if (
            lane !== "console" &&
            lane !== "voice" &&
            "messageId" in setup &&
            typeof setup.messageId === "string"
          )
            context.push({
              id: setup.messageId,
              authorId: lane === "owner-dm" ? OWNER : GUEST,
              body: c.setup,
              createdAt: new Date().toISOString(),
            });
        }
        const answer = await ask(lane, c, "prompt", c.prompt, context);
        const turn = turns.at(-1)!;
        const observation: Observation = {
          lane,
          response: answer.response,
          tools: turn.tools,
          leaksInstructions: [...shingles(answer.response)].some((s) => instructions.has(s)),
        };
        const verdict =
          answer.state === "settled" ? c.grade(observation) : { pass: false, why: `turn ${answer.state}` };
        graded.push({ ...observation, rep, caseId: c.id, ...verdict });
      }
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      const timeout = setTimeout(() => child?.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(timeout);
    }
    await rm(preset.CLANKIE_CREDENTIALS_FILE!, { force: true });
  }
}

async function until<T>(read: () => Promise<T | undefined>, timeout: number): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await read();
    if (result !== undefined) return result;
    await delay(500);
  }
  throw new Error(`Timed out; inspect ${root}`);
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1)))]!
    : null;
};

try {
  await mkdir(root, { recursive: true });
  for (let rep = 1; rep <= reps; rep++) await campaign(rep);
} finally {
  fake?.server.close();
}

const byLane = Object.fromEntries(
  lanes.map((lane) => {
    const rows = graded.filter((g) => g.lane === lane);
    const ms = turns.filter((t) => t.lane === lane && t.step === "prompt").map((t) => t.ms);
    return [
      lane,
      {
        passed: rows.filter((g) => g.pass).length,
        of: rows.length,
        p50Ms: percentile(ms, 50),
        p95Ms: percentile(ms, 95),
      },
    ];
  }),
);
const byCase = Object.fromEntries(
  cases.map((c) => {
    const rows = graded.filter((g) => g.caseId === c.id);
    return [
      c.id,
      {
        measures: c.measures,
        passed: rows.filter((g) => g.pass).length,
        of: rows.length,
        everyLane: rows.every((g) => g.pass),
        failures: rows.filter((g) => !g.pass).map((g) => `${g.lane}#${g.rep}: ${g.why}`),
      },
    ];
  }),
);
const report = {
  suite: "vuh-2796-lanes",
  model,
  effort: values.effort ?? null,
  smoke: values.smoke,
  revision,
  reps,
  score: { passed: graded.filter((g) => g.pass).length, of: graded.length },
  sameClankie:
    Object.values(byCase).filter((c) => c.everyLane).length +
    ` of ${cases.length} cases pass in every lane and rep`,
  byLane,
  byCase,
  scope:
    "Real service, Pi lanes and channel-turn route on a private scratch stack. No Discord, no native seat: console is the Pi head.",
};
await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
// Side by side for the hand-scored "same Clankie" read: one case, every lane.
const answers = cases
  .map((c) => {
    const rows = graded.filter((g) => g.caseId === c.id);
    return [
      `## ${c.id} (${c.measures})`,
      "",
      `Prompt: ${c.prompt}`,
      `Rubric: ${c.rubric}`,
      "",
      ...rows.map(
        (g) =>
          `- **${g.lane} #${g.rep}** ${g.pass ? "pass" : "FAIL"} (${g.why}): ${g.response.replace(/\s+/gu, " ").slice(0, 600)}`,
      ),
      "",
    ].join("\n");
  })
  .join("\n");
await writeFile(join(root, "answers.md"), `# Lanes eval answers\n\n${answers}`);
await writeFile(
  join(root, "same-clankie-grades.csv"),
  ["case,lane,rep,same_clankie_1_to_5,notes", ...graded.map((g) => `${g.caseId},${g.lane},${g.rep},,`)].join(
    "\n",
  ) + "\n",
);
console.log(JSON.stringify(report, null, 2));
