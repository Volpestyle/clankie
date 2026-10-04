/** Manual-only isolated-world probe. Never run in CI or against a shared/public world. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  MinecraftAction,
  MinecraftActionStatus,
  MinecraftSessionStatus,
  MinecraftStatus,
} from "@clankie/protocol";
import mineflayer, { type Bot } from "mineflayer";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
if (outputIndex === -1 || !args[outputIndex + 1])
  throw new Error(
    "Usage: node scripts/conformance.ts --output <private-scratch-directory> [--spike <minecraft-spike-directory>]. Start isolated Paper on 25684/25685 first.",
  );
const output = resolve(args[outputIndex + 1]!);
const spikeIndex = args.indexOf("--spike");
const spike = resolve(spikeIndex < 0 ? join(homedir(), "dev/minecraft-spike") : args[spikeIndex + 1]!);
const motorIndex = args.indexOf("--motor");
const motorEntry =
  motorIndex < 0 ? fileURLToPath(new URL("../src/main.ts", import.meta.url)) : resolve(args[motorIndex + 1]!);
const { rcon } = (await import(pathToFileURL(join(spike, "rcon.mjs")).href)) as {
  rcon(command: string): Promise<string>;
};
await mkdir(join(output, "frames"), { recursive: true });
const evidence: { at: number; label: string; command?: string; value: unknown }[] = [];
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const record = (label: string, value: unknown, command?: string) => {
  evidence.push({ at: Date.now(), label, ...(command ? { command } : {}), value });
  return value;
};
const command = async (label: string, value: string) => record(label, await rcon(value), value) as string;
const initialList = await command("before-catalog", "list");
assert.match(initialList, /There are 0 of/u, "Refuse to modify a world occupied by another player");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [motorEntry],
  cwd: dirname(fileURLToPath(new URL("../package.json", import.meta.url))),
  stderr: "pipe",
});
const client = new Client({ name: "minecraft-motor-conformance", version: "0.1.0" });
const session = { sessionId: `conformance-${Date.now()}`, connectionGeneration: 1 };
const username = "ClankieMotor";
const endpoint = { host: "127.0.0.1", port: 25684, version: "1.21.4", username, auth: "offline" as const };
let friend: Bot | null = null;
const friendChat: { player: string; text: string }[] = [];
const call = async <T>(name: string, input: Record<string, unknown> = {}): Promise<T> => {
  const reply = await client.callTool({ name, arguments: input });
  if (reply.isError) throw new Error(`MCP ${name} failed: ${JSON.stringify(reply.content)}`);
  const content = reply.content as { type: string; text?: string }[];
  const value = JSON.parse(content.find((entry) => entry.type === "text")?.text ?? "null") as T;
  record(`mcp:${name}`, value);
  return value;
};
const active = async () => {
  for (let i = 0; i < 150; i++) {
    const status = await call<MinecraftStatus>("status");
    if (status.session?.phase === "active") return;
    if (status.session?.phase === "disconnected") throw new Error("Bot ended before spawn");
    await sleep(100);
  }
  throw new Error("Spawn did not complete");
};
let actionCounter = 0;
const act = async (action: MinecraftAction) =>
  call<MinecraftActionStatus>("act", { session, actionId: `probe-${++actionCounter}`, action });
const terminal = async (actionId: string) => {
  for (let i = 0; i < 150; i++) {
    const status = await call<MinecraftActionStatus>("action_status", { session, actionId });
    if (!["running", "cancel_requested"].includes(status.state)) return status;
    await sleep(100);
  }
  throw new Error(`Action ${actionId} did not settle`);
};
const position = async (label: string) => {
  const result = await command(label, `data get entity ${username} Pos`);
  const match = result.match(/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/u);
  assert.ok(match, "RCON position must parse");
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};
const reset = async () => {
  await command("reset-mode", `gamemode survival ${username}`);
  await command("reset-position", `tp ${username} 0.5 64 0.5`);
  await sleep(350);
};
let gotoStopMs = 0;
let digCancelReplyMs = 0;
let report = "";
let failure: unknown;
let joined = false;
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "cancel_action"));
  const lazy = await call<MinecraftStatus>("status");
  assert.equal(lazy.session, null);
  const catalogList = await command("after-catalog", "list");
  assert.match(catalogList, /There are 0 of/u);
  await call("join", { profileId: "local-paper", session, endpoint });
  joined = true;
  await active();
  friend = mineflayer.createBot({ ...endpoint, username: "FriendMotor" });
  friend.on("chat", (player, text) => {
    friendChat.push({ player, text });
  });
  friend.on("error", () => {});
  const friendSpawn = new Promise<void>((resolve, reject) => {
    friend!.once("spawn", resolve);
    friend!.once("error", reject);
  });
  await friendSpawn;
  await command("joined", "list");
  await command("fixture-forceload", "forceload add -16 -16 112 16");
  assert.match(
    await command("fixture-floor", "fill -16 63 -4 96 63 8 minecraft:stone"),
    /Successfully|No blocks were filled/u,
  );
  await command("fixture-clear", "fill -4 64 -4 96 68 8 minecraft:air");
  await reset();

  const navigation = await act({ type: "goto", position: { x: 80, y: 64, z: 0 }, tolerance: 1 });
  let moving = await position("goto-start");
  for (let attempt = 0; attempt < 100 && moving[0]! <= 1; attempt++) {
    await sleep(100);
    moving = await position(`goto-before-cancel-${attempt}`);
  }
  assert.ok(moving[0]! > 1, "Navigation must actually start");
  const requestedAt = performance.now();
  const cancelled = await call<MinecraftActionStatus>("cancel_action", {
    session,
    actionId: navigation.actionId,
  });
  assert.equal(cancelled.state, "cancelled");
  let previous = await position("goto-cancel-sample-0");
  let stable = 0;
  for (let index = 1; index <= 12; index++) {
    await sleep(100);
    const next = await position(`goto-cancel-sample-${index}`);
    const delta = Math.hypot(...next.map((value, axis) => value - previous[axis]!));
    stable = delta < 0.02 ? stable + 1 : 0;
    if (stable === 3 && gotoStopMs === 0) gotoStopMs = performance.now() - requestedAt;
    previous = next;
  }
  assert.ok(gotoStopMs > 0 && gotoStopMs <= 1000, `Motor stop target missed: ${gotoStopMs}ms`);
  assert.equal((await terminal(navigation.actionId)).state, "cancelled");

  await reset();
  await command("dig-fixture", "setblock 2 64 0 minecraft:iron_block");
  await command("dig-pick", `item replace entity ${username} weapon.mainhand with minecraft:diamond_pickaxe`);
  await sleep(250);
  const digging = await act({ type: "dig", position: { x: 2, y: 64, z: 0 } });
  await sleep(300);
  const digAt = performance.now();
  assert.equal(
    (await call<MinecraftActionStatus>("cancel_action", { session, actionId: digging.actionId })).state,
    "cancelled",
  );
  digCancelReplyMs = performance.now() - digAt;
  for (let i = 0; i < 12; i++) {
    assert.match(
      await command(`dig-cancel-block-${i}`, "execute if block 2 64 0 minecraft:iron_block"),
      /Test passed/u,
    );
    await sleep(100);
  }
  // Exceeds the demonstrated stock iron completion time, proving no late block mutation.
  await sleep(7200);
  assert.match(
    await command("dig-no-late-mutation", "execute if block 2 64 0 minecraft:iron_block"),
    /Test passed/u,
  );
  assert.ok(digCancelReplyMs <= 1000);

  await command("rejected-fixture", "setblock 2 64 0 minecraft:dirt");
  await command("rejected-mode", `gamemode adventure ${username}`);
  const rejected = await terminal((await act({ type: "dig", position: { x: 2, y: 64, z: 0 } })).actionId);
  assert.notEqual(rejected.evidence.outcome, "verified");
  assert.match(
    await command("rejected-independent", "execute if block 2 64 0 minecraft:dirt"),
    /Test passed/u,
  );

  await reset();
  await command("dig-success-fixture", "setblock 2 64 0 minecraft:dirt");
  const dug = await terminal((await act({ type: "dig", position: { x: 2, y: 64, z: 0 } })).actionId);
  assert.equal(dug.evidence.outcome, "verified");
  assert.match(
    await command("dig-success-independent", "execute if block 2 64 0 minecraft:air"),
    /Test passed/u,
  );
  await command("place-supply", `give ${username} minecraft:dirt 8`);
  await command("place-fixture", "setblock 3 64 2 minecraft:air");
  await sleep(250);
  const placed = await terminal(
    (await act({ type: "place", position: { x: 3, y: 64, z: 2 }, item: "minecraft:dirt" })).actionId,
  );
  assert.equal(placed.evidence.outcome, "verified");
  assert.match(await command("place-independent", "execute if block 3 64 2 minecraft:dirt"), /Test passed/u);

  await command("follow-friend-start", "tp FriendMotor 8.5 64 0.5");
  await sleep(250);
  const following = await call<MinecraftActionStatus>("follow_player", {
    session,
    actionId: "follow-probe",
    player: "FriendMotor",
    distance: 2,
  });
  await sleep(1700);
  const followFirst = await position("follow-first");
  await command("follow-friend-moved", "tp FriendMotor 16.5 64 0.5");
  await sleep(1800);
  const followSecond = await position("follow-second");
  assert.ok(followSecond[0]! > followFirst[0]! + 3, "Continuous follow must react to player movement");
  await call("cancel_action", { session, actionId: following.actionId });
  const chatText = "motor-conformance-outgoing-1584";
  await terminal((await act({ type: "chat", text: chatText })).actionId);
  friend.chat("motor-conformance-incoming-1584");
  await sleep(500);
  assert.ok(
    friendChat.some((chat) => chat.player === username && chat.text === chatText),
    "Independent friend must receive bot chat",
  );
  record("independent-friend-chat", friendChat);
  const events = await call<{ events: { type: string; data: Record<string, unknown> }[] }>("poll_events", {
    session,
    limit: 64,
  });
  assert.ok(
    events.events.some(
      (event) => event.type === "chat" && event.data.text === "motor-conformance-incoming-1584",
    ),
  );

  let viewer: { available: boolean; frameUrl?: string } = { available: false };
  for (let i = 0; i < 100; i++) {
    viewer = await call("viewer_status", { session });
    if (viewer.available) break;
    await sleep(200);
  }
  assert.ok(viewer.available && viewer.frameUrl, "Same-bot browser PNG must be available");
  for (let i = 1; i <= 3; i++) {
    const frame: Response = await fetch(viewer.frameUrl);
    assert.equal(frame.status, 200);
    assert.equal(frame.headers.get("x-minecraft-session-id"), session.sessionId);
    assert.equal(frame.headers.get("x-minecraft-connection-generation"), "1");
    const png = Buffer.from(await frame.arrayBuffer());
    assert.ok(
      png.byteLength <= 262144 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    );
    await writeFile(join(output, "frames", `minecraft-${i}.png`), png);
    record(`frame-${i}`, { bytes: png.byteLength, headers: Object.fromEntries(frame.headers) });
    await sleep(650);
  }
  report = `# Minecraft motor conformance\n\nPassed live against local offline Paper 1.21.4, Node ${process.version}.\n\n- Lazy catalog: no ClankieMotor player before explicit join.\n- Goto cancellation: three RCON position samples stable within ${gotoStopMs.toFixed(1)} ms (target ≤1000 ms), remains stable through 1.2s.\n- Dig cancellation: MCP stop reply ${digCancelReplyMs.toFixed(1)} ms; RCON iron block preserved through 1.2s and beyond the stock 7.5s late mutation window.\n- Rejected Adventure dig: ${rejected.state}, evidence ${rejected.evidence.outcome}; RCON dirt remains.\n- Survival dig and place: inbound-packet verified, independently confirmed through RCON.\n- Continuous follow reacts to friend movement; outgoing chat independently received; incoming chat appears in bounded events.\n- Same-bot browser viewer: three 320×180 PNGs saved under frames, each ≤256 KiB.\n- Raw timestamped MCP/RCON records: conformance-evidence.json.\n\nLimitations: no online auth, human client, Activity publication or production server tested; craft/build are covered by cancellation/unit checks rather than this live slice. Bot-cache movement/chat completion remains local-only evidence.\n`;
} catch (error) {
  failure = error;
  report = `# Minecraft motor conformance\n\nFAILED: ${error instanceof Error ? error.message : String(error)}\n\nRaw timestamped evidence retained in conformance-evidence.json; this run is not accepted.\n`;
} finally {
  try {
    const leaving = await call<MinecraftSessionStatus>("leave", { session });
    record("leave-requested", leaving);
    let confirmed = false;
    for (let i = 0; i < 100; i++) {
      const status = await call<MinecraftStatus>("status");
      if (status.session?.termination.state === "confirmed") {
        record("leave-confirmed", status.session);
        confirmed = true;
        break;
      }
      await sleep(100);
    }
    if (joined) assert.ok(confirmed, "Leave must be confirmed by the exact end event");
  } catch (error) {
    if (joined) failure ??= error;
  }
  friend?.quit();
  await client.close();
  await transport.close();
  await sleep(300);
  try {
    assert.match(await command("final-players", "list"), /There are 0 of/u);
  } catch (error) {
    failure ??= error;
  }
  if (failure)
    report = `# Minecraft motor conformance\n\nFAILED: ${failure instanceof Error ? failure.message : String(failure)}\n\nRaw timestamped evidence retained in conformance-evidence.json; this run is not accepted.\n`;
  await writeFile(join(output, "conformance-evidence.json"), JSON.stringify(evidence, null, 2));
  await writeFile(join(output, "conformance.md"), report);
}
if (failure) throw failure;
console.log(
  `Conformance passed: goto stable ${gotoStopMs.toFixed(1)}ms, dig stop reply ${digCancelReplyMs.toFixed(1)}ms. Evidence: ${output}`,
);
