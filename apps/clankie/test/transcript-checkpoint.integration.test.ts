import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { parseHerdrSeatTranscript } from "../src/captain/herdr-transcript.ts";

const children = new Set<ChildProcess>();
const roots: string[] = [];
let compiled: string;
let entry: string;
beforeAll(async () => {
  compiled = await mkdtemp(join(tmpdir(), "checkpoint-service-build-"));
  entry = join(compiled, "service.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("./fixtures/transcript-checkpoint-service.ts", import.meta.url))],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "esm",
    banner: {
      js: "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);",
    },
  });
});
async function stop(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
  }
  children.delete(child);
}
afterEach(async () => {
  for (const child of children) await stop(child);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  await rm(compiled, { recursive: true, force: true });
});
async function runtime(root: string) {
  const child = spawn(process.execPath, [entry, root], {
    env: {
      PATH: process.env.PATH,
      HOME: root,
      USERPROFILE: root,
      NODE_ENV: "test",
      VITEST: "true",
      XDG_CONFIG_HOME: join(root, ".config"),
      XDG_STATE_HOME: join(root, "state"),
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  children.add(child);
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const replies: { id?: number; ready?: boolean; port?: number; result?: unknown; error?: string }[] = [];
  child.on("message", (raw) => replies.push(raw as (typeof replies)[number]));
  await expect
    .poll(
      () => {
        if (child.exitCode !== null) throw new Error(`Fixture exited: ${stderr}`);
        return replies.find((reply) => reply.ready);
      },
      { timeout: 10_000 },
    )
    .toBeTruthy();
  const port = replies.find((reply) => reply.ready)!.port!;
  let sequence = 0;
  const request = async (action: string, extra = {}) => {
    const id = ++sequence;
    child.send({ id, action, ...extra });
    await expect.poll(() => replies.find((reply) => reply.id === id), { timeout: 30_000 }).toBeTruthy();
    return replies.find((reply) => reply.id === id)!;
  };
  const call = async (action: string, extra = {}) => {
    const reply = await request(action, extra);
    if (reply.error) throw new Error(reply.error);
    return reply.result;
  };
  return { child, call, request, replay: async () => (await fetch(`http://127.0.0.1:${port}`)).json() };
}
// Real Codex JSONL records through the production incremental parser. Content is
// generated and public; this never reads a live owner's transcript or calls a model.
function records(start: number, count: number) {
  return (
    Array.from({ length: count }, (_, offset) =>
      JSON.stringify({
        timestamp: "2026-11-04T00:00:00Z",
        type: "response_item",
        payload: {
          id: randomUUID(),
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: `Long conversation answer ${start + offset}.` }],
        },
      }),
    ).join("\n") + "\n"
  );
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "transcript-checkpoint-"));
  roots.push(root);
  const directory = join(root, "conversations", "global-default");
  const journal = () => readFile(join(directory, "events.jsonl"), "utf8");
  return { root, directory, journal };
}
it("bounds the long head's metadata and restores exact dedup across process restart, resume and hooks", async () => {
  const f = await fixture();
  let service = await runtime(f.root);
  const measurements = [];
  for (let end = 1000; end <= 36000; end += 1000) {
    await appendFile(join(f.root, "rollout.jsonl"), records(end - 999, 1000));
    const result = (await service.call("sync")) as {
      tailEntries: number;
      checkpointBytes: number;
      metaBytes: number;
    };
    if ([9000, 18000, 36000].includes(end)) measurements.push({ records: end, ...result });
    expect(result.checkpointBytes).toBeLessThan(512);
    expect(result.metaBytes).toBeLessThan(2048);
  }
  console.log("long head checkpoint", JSON.stringify(measurements));
  const before = await f.journal();
  const replay = await service.replay();
  expect(replay.result.events.at(-1)).toMatchObject({
    type: "message",
    text: "Long conversation answer 36000.",
  });
  // Kill this exact service: the new process has no parser, journal or dedup cache.
  await stop(service.child);
  service = await runtime(f.root);
  await service.call("sync");
  expect(await f.journal()).toBe(before);
  expect(await service.replay()).toEqual(replay);
  // A resumed/aliased native session and the hook can redeliver IDs far outside
  // the 9k native tail AND the 500-event conversation retention window.
  const all = parseHerdrSeatTranscript("codex", await readFile(join(f.root, "rollout.jsonl"), "utf8"));
  expect(all).toHaveLength(36000);
  await service.call("hook", { entries: [all[0], all.at(-1)] });
  expect(await f.journal()).toBe(before);
  await writeFile(join(f.root, "other.jsonl"), records(36001, 1));
  await service.call("sync", { file: "other.jsonl" });
  const next = await f.journal();
  expect(next).toContain("Long conversation answer 36001.");
  await service.call("sync"); // Resume the old session after switching to another.
  expect(await f.journal()).toBe(next);
  await stop(service.child);
  service = await runtime(f.root);
  await service.call("hook", { entries: all.slice(0, 3) });
  await service.call("sync", { file: "other.jsonl" });
  expect(await f.journal()).toBe(next);
}, 60_000);

it.each(["entryIds", "messageIds"] as const)(
  "migrates a lifetime %s checkpoint before compacting metadata, then archives it on reset",
  async (field) => {
    const f = await fixture();
    const source = records(1, 36000);
    await writeFile(join(f.root, "rollout.jsonl"), source);
    const all = parseHerdrSeatTranscript("codex", source);
    let service = await runtime(f.root);
    await service.call("sync");
    await stop(service.child);
    const path = join(f.directory, "meta.json");
    const meta = JSON.parse(await readFile(path, "utf8"));
    // Persist the exact pre-#361 layout, including IDs older than the retained log.
    meta.seatTranscript = { sessionKey: meta.seatTranscript.sessionKey, [field]: all.map((e) => e.id) };
    await writeFile(path, JSON.stringify(meta));
    await rm(join(f.directory, "transcript-checkpoint.sqlite"));
    const before = await f.journal();
    service = await runtime(f.root);
    await service.call("sync"); // A quiet observation must migrate too.
    await service.call("hook", { entries: all.slice(0, 3) });
    expect(await f.journal()).toBe(before);
    expect((await readFile(path)).length).toBeLessThan(2048);
    await stop(service.child);
    service = await runtime(f.root);
    await service.call("hook", { entries: all.slice(0, 3) });
    expect(await f.journal()).toBe(before);
    const reset = (await service.call("reset")) as { archiveId: string };
    expect(
      await readFile(join(f.root, "conversation-archives", reset.archiveId, "transcript-checkpoint.sqlite")),
    ).not.toHaveLength(0);
    await writeFile(join(f.root, "new.jsonl"), records(40000, 1));
    await service.call("sync", { file: "new.jsonl" });
    expect((await f.journal()).trim().split("\n")).toHaveLength(1);
    await stop(service.child);
    service = await runtime(f.root);
    await service.call("sync", { file: "new.jsonl" });
    expect((await f.journal()).trim().split("\n")).toHaveLength(1);
  },
  60_000,
);

it("refuses missing or corrupt indexed checkpoints without replaying the native history", async () => {
  for (const corrupt of [false, true]) {
    const f = await fixture();
    await writeFile(join(f.root, "rollout.jsonl"), records(1, 2));
    let service = await runtime(f.root);
    await service.call("sync");
    const before = await f.journal();
    await stop(service.child);
    const path = join(f.directory, "transcript-checkpoint.sqlite");
    if (corrupt) await writeFile(path, "not a SQLite database");
    else await rm(path);
    service = await runtime(f.root);
    const refusal = await service.request("sync");
    expect(refusal.error).toBeTruthy();
    expect(
      createHash("sha256")
        .update(await f.journal())
        .digest("hex"),
    ).toBe(createHash("sha256").update(before).digest("hex"));
    await stop(service.child);
  }
});
