/**
 * VUH-1373: a hired herdr seat is not a Swarm actor, so the captain's brief has
 * to reach it down the seat's own conversation lane. A real captain drives a
 * fake `herdr` on PATH that records every command it is given.
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { LaneToolBank } from "../src/captain/port.ts";

// Enough of herdr for one pi hire: a tab, an agent that reports a session, the
// pane list, and input that turns the idle agent into a working one.
const FAKE_HERDR = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const statePath = process.env.FAKE_HERDR_STATE;
fs.appendFileSync(process.env.FAKE_HERDR_LOG, JSON.stringify(args) + "\\n");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { panes: [] };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const out = (result) => process.stdout.write(JSON.stringify({ result }));
const find = (target) => state.panes.find((pane) => pane.pane_id === target || pane.name === target);
const [group, command] = args;
if (group === "tab" && command === "create") {
  const pane = { pane_id: "w1:p1", terminal_id: "term_0a1b2c", agent: "shell", agent_status: "idle" };
  state.panes.push(pane);
  save();
  out({ root_pane: { pane_id: pane.pane_id } });
} else if (group === "agent" && command === "start") {
  const pane = find(args[args.indexOf("--pane") + 1]);
  Object.assign(pane, {
    name: args[2],
    agent: args[args.indexOf("--kind") + 1],
    agent_status: "idle",
    agent_session: { source: "herdr:pi", kind: "path", value: process.env.FAKE_HERDR_SESSION },
  });
  save();
  out({});
} else if (group === "agent" && command === "get") {
  const pane = find(args[2]);
  if (pane === undefined) {
    process.stderr.write("agent target " + args[2] + " not found");
    process.exit(1);
  }
  out({ agent: pane });
} else if (group === "agent" && command === "wait") {
  setTimeout(() => out({ agent: find(args[2]) }), 60000);
} else if (group === "agent" && command === "list") {
  out({ agents: state.panes.filter((pane) => pane.agent !== "shell") });
} else if (group === "pane" && command === "list") {
  out({ panes: state.panes });
} else if (group === "pane" && command === "send-keys") {
  const pane = find(args[2]);
  if (pane.agent !== "shell") pane.agent_status = "working";
  save();
  out({});
} else {
  out({});
}
`;

const roots: string[] = [];
const path = process.env.PATH;
afterEach(async () => {
  process.env.PATH = path;
  delete process.env.FAKE_HERDR_STATE;
  delete process.env.FAKE_HERDR_LOG;
  delete process.env.FAKE_HERDR_SESSION;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-hire-brief-"));
  roots.push(root);
  const bin = join(root, "bin");
  await import("node:fs/promises").then((fs) => fs.mkdir(bin));
  await writeFile(join(bin, "herdr"), FAKE_HERDR);
  await chmod(join(bin, "herdr"), 0o755);
  process.env.PATH = `${bin}:${path}`;
  process.env.FAKE_HERDR_STATE = join(root, "herdr-state.json");
  process.env.FAKE_HERDR_LOG = join(root, "herdr.log");
  process.env.FAKE_HERDR_SESSION = join(root, "pi-session.jsonl");
  process.env.PI_CODING_AGENT_DIR = join(root, "pi-agent");
  const captain = createCaptain(
    {
      herdrAvailable: () => true,
      embodiment: {},
      browser: { catalog: async () => ({ available: false, tools: [] }) },
      mcp: { catalog: async () => [], call: async () => ({ outcome: "ok", content: "", isError: false }) },
    } as unknown as CaptainDeps,
    {
      repoRoot: root,
      stateDir: join(root, "state"),
      settings: new SettingsStore(join(root, "settings.json")),
    },
  );
  const commands = async () =>
    (await readFile(join(root, "herdr.log"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
  return { root, captain, commands };
}

async function call(bank: LaneToolBank, name: string, args: Record<string, unknown>) {
  const tool = bank.tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`${name} is not in the operator bank`);
  const result = await tool.call(args);
  const text = result.content.find((part) => part.type === "text");
  return JSON.parse(text?.type === "text" ? text.text : "null") as Record<string, unknown>;
}

test("the captain's brief reaches a freshly hired pi seat and starts its turn", async () => {
  const { root, captain, commands } = await fixture();
  try {
    const bank = await captain.laneToolBank("operator", "global-default");
    const brief = "BRIEF-7f3a: implement slugify from SPEC.md and report the tests you ran.";
    const hired = await call(bank, "hire_agent", {
      harness: "pi",
      title: "slugify worker",
      workingDirectory: root,
      brief,
    });
    expect(hired).toMatchObject({
      outcome: "spawned",
      seat: { seatId: "term_0a1b2c" },
      brief: { outcome: "delivered", seatId: "term_0a1b2c", status: "working" },
    });
    // The brief was typed into the hired pane and submitted — the same lane an
    // operator DM takes — not left in a Swarm inbox nothing reads.
    const sent = (await commands()).filter((args) => args[0] === "pane" && args[2] === "w1:p1");
    expect(sent).toContainEqual(["pane", "send-text", "w1:p1", brief]);
    const text = sent.findIndex((args) => args[1] === "send-text");
    expect(sent.slice(text + 1)).toContainEqual(["pane", "send-keys", "w1:p1", "Enter"]);

    // The seatId the hire returned is what the captain watches it by.
    const watch = await call(bank, "herdr_watch", { agent: "term_0a1b2c", reason: "harvest slugify" });
    expect(watch).toMatchObject({ outcome: "watching", paneId: "w1:p1", terminalId: "term_0a1b2c" });

    // And every id the hire handed back reaches the seat for a follow-up.
    const seat = hired.seat as { personaId: string; conversationId: string };
    for (const target of [seat.conversationId, seat.personaId]) {
      expect(
        await call(bank, "message_seat", { seat: target, message: `follow-up via ${target}` }),
      ).toMatchObject({
        outcome: "delivered",
        seatId: "term_0a1b2c",
      });
      expect(await commands()).toContainEqual(["pane", "send-text", "w1:p1", `follow-up via ${target}`]);
    }
    expect(await call(bank, "message_seat", { seat: "agent-nobody", message: "hello" })).toEqual({
      outcome: "unknown_seat",
      seat: "agent-nobody",
    });
  } finally {
    await captain.close();
  }
});
