/**
 * VUH-1373: a hired herdr seat is not a Swarm actor, so the captain's brief has
 * to reach it down the seat's own conversation lane. A real captain drives a
 * fake `herdr` on PATH that records every command it is given.
 */
import { chmod, mkdir, mkdtemp, readFile, readlink, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import type { LaneToolBank } from "../src/captain/port.ts";

// Enough of herdr for one hire: a tab, an agent that reports a session, the
// pane list, and input that turns the idle agent into a working one. Codex, like
// the real one, reports its session only once a prompt starts its first turn.
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
  const kind = args[args.indexOf("--kind") + 1];
  Object.assign(pane, { name: args[2], agent: kind, agent_status: "idle" });
  if (kind !== "codex") {
    pane.agent_session = { source: "herdr:pi", kind: "path", value: process.env.FAKE_HERDR_SESSION };
  }
  save();
  out({});
} else if (group === "agent" && command === "prompt") {
  const pane = find(args[2]);
  pane.agent_status = "working";
  const text = args[3];
  const record = pane.agent === "codex"
    ? { type: "response_item", payload: { type: "message", role: "user", content: [{type:"input_text",text}], internal_chat_message_metadata_passthrough: {content_item_kinds:["user.text"]} } }
    : { type: pane.agent === "claude" ? "user" : "message", uuid: "prompt-1", id: "prompt-1", message: { role: "user", content: text } };
  fs.appendFileSync(process.env.FAKE_HERDR_SESSION, JSON.stringify(record) + "\\n");
  const delay = Number(process.env.FAKE_HERDR_FIRST_TURN_DELAY_MS ?? 0);
  if (delay > 0) {
    // The turn has started but is still connecting MCP servers.
    pane.session_at = Date.now() + delay;
  } else {
    pane.agent_session = { source: "herdr:" + pane.agent, kind: "path", value: process.env.FAKE_HERDR_SESSION };
  }
  save();
  out({ agent: pane });
} else if (group === "agent" && command === "get") {
  const pane = find(args[2]);
  if (pane === undefined) {
    process.stderr.write("agent target " + args[2] + " not found");
    process.exit(1);
  }
  if (pane.session_at !== undefined && Date.now() >= pane.session_at) {
    pane.agent_session = { source: "herdr:" + pane.agent, kind: "path", value: process.env.FAKE_HERDR_SESSION };
    delete pane.session_at;
    save();
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
const codexHome = process.env.CODEX_HOME;
afterEach(async () => {
  process.env.PATH = path;
  if (codexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = codexHome;
  delete process.env.FAKE_HERDR_STATE;
  delete process.env.FAKE_HERDR_LOG;
  delete process.env.FAKE_HERDR_SESSION;
  delete process.env.FAKE_HERDR_FIRST_TURN_DELAY_MS;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clankie-hire-brief-"));
  roots.push(root);
  const bin = join(root, "bin");
  await import("node:fs/promises").then(async (fs) => {
    await fs.mkdir(bin);
    await fs.mkdir(join(root, "integrations/worker-skills"), { recursive: true });
    await fs.mkdir(join(root, ".agents/skills"), { recursive: true });
    await fs.mkdir(join(root, "codex/skills"), { recursive: true });
  });
  process.env.CODEX_HOME = join(root, "codex");
  await writeFile(join(root, "codex/auth.json"), "synthetic credential presence; never read");
  await writeFile(join(bin, "herdr"), FAKE_HERDR);
  await chmod(join(bin, "herdr"), 0o755);
  await writeFile(join(bin, "claude"), "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o755 });
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
      // These cases exercise the legacy terminal fallback with a fake Herdr.
      seatAdapters: [],
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

test.each(["pi", "claude"])(
  "the captain's long brief reaches a freshly hired %s seat and starts its turn",
  async (harness) => {
    const { root, captain, commands } = await fixture();
    try {
      const bank = await captain.laneToolBank("operator", "global-default");
      const brief =
        "BRIEF-7f3a: implement slugify from SPEC.md and report the tests you ran.\n" +
        "Synthetic assignment context.\n".repeat(120) +
        "BRIEF-END";
      const hired = await call(bank, "hire_agent", {
        harness,
        title: "slugify worker",
        workingDirectory: root,
        brief,
      });
      expect(hired, JSON.stringify(hired)).toMatchObject({
        outcome: "spawned",
        seat: { seatId: "term_0a1b2c" },
        brief: { outcome: "delivered", seatId: "term_0a1b2c", status: "working" },
      });
      // Submitted once through the paste-aware agent surface, then checked in
      // the native transcript before the hire reports delivered.
      const sent = await commands();
      expect(sent.filter((args) => args.includes(brief))).toHaveLength(1);
      expect(sent.find((args) => args.includes(brief))?.slice(0, 4)).toEqual([
        "agent",
        "prompt",
        "w1:p1",
        brief,
      ]);
      expect(sent.some((args) => args[1] === "send-text")).toBe(false);

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
        expect(await commands()).toContainEqual(
          expect.arrayContaining(["agent", "prompt", "w1:p1", `follow-up via ${target}`]),
        );
      }
      expect(await call(bank, "message_seat", { seat: "agent-nobody", message: "hello" })).toEqual({
        outcome: "unknown_seat",
        seat: "agent-nobody",
      });
    } finally {
      await captain.close();
    }
  },
);

test("a codex hire runs off the shared daemon and its brief is the first turn that reports its session", async () => {
  const { root, captain, commands } = await fixture();
  try {
    const bank = await captain.laneToolBank("operator", "global-default");
    const brief = "BRIEF-2c9e: reply with just ok.";
    const hired = await call(bank, "hire_agent", {
      harness: "codex",
      title: "codex worker",
      workingDirectory: root,
      brief,
    });
    expect(hired, JSON.stringify(hired)).toMatchObject({
      outcome: "spawned",
      seat: { seatId: "term_0a1b2c", harness: "codex" },
      brief: { outcome: "delivered", seatId: "term_0a1b2c", status: "working" },
    });
    const sent = await commands();
    const start = sent.find((args) => args[0] === "agent" && args[1] === "start");
    expect(start?.slice(-2)).toEqual(["--", "--no-daemon"]);
    // Submitted once, through herdr's own prompt, before the session could exist.
    expect(sent.filter((args) => args.includes(brief))).toEqual([
      [
        "agent",
        "prompt",
        "w1:p1",
        brief,
        "--wait",
        "--until",
        "working",
        "--until",
        "blocked",
        "--timeout",
        "10000",
      ],
    ]);
  } finally {
    await captain.close();
  }
});

test("a codex hire waits past the old 10 s limit for a first turn still connecting MCP servers", async () => {
  const { root, captain } = await fixture();
  process.env.FAKE_HERDR_FIRST_TURN_DELAY_MS = "11000";
  try {
    const bank = await captain.laneToolBank("operator", "global-default");
    const hired = await call(bank, "hire_agent", {
      harness: "codex",
      title: "slow codex worker",
      workingDirectory: root,
      brief: "BRIEF-7f31: reply with just ok.",
    });
    expect(hired, JSON.stringify(hired)).toMatchObject({
      outcome: "spawned",
      seat: { seatId: "term_0a1b2c", harness: "codex" },
    });
  } finally {
    await captain.close();
  }
}, 30_000);

test.each([undefined, "default"])(
  "Codex hires select headroom and honor the account override %s",
  async (override) => {
    const { root, captain } = await fixture();
    try {
      const second = join(root, "second-codex");
      await mkdir(join(second, "sessions"), { recursive: true });
      await mkdir(join(root, "codex", "sessions"), { recursive: true });
      await writeFile(join(second, "auth.json"), "synthetic presence only");
      for (const [home, used] of [
        [join(root, "codex"), 90],
        [second, 10],
      ] as const) {
        await writeFile(
          join(home, "sessions", "usage.jsonl"),
          JSON.stringify({
            timestamp: new Date().toISOString(),
            payload: {
              rate_limits: {
                primary: { used_percent: used, window_minutes: 300, resets_at: Date.now() / 1000 + 3600 },
                secondary: {
                  used_percent: used,
                  window_minutes: 10080,
                  resets_at: Date.now() / 1000 + 86400,
                },
              },
            },
          }) + "\n",
        );
      }
      const settings = new SettingsStore(join(root, "settings.json"));
      await settings.update((current) => ({
        ...current,
        codexAccounts: [{ label: "second", home: second }],
      }));
      const bank = await captain.laneToolBank("operator", "global-default");
      const account = { label: override ?? "second", home: override ? join(root, "codex") : second };
      const result = await call(bank, "hire_agent", {
        harness: "codex",
        title: "Account worker",
        workingDirectory: root,
        brief: "Reply with OK.",
        ...(override ? { account: override } : {}),
      });
      expect(result).toMatchObject({ outcome: "spawned", seat: { account } });
      const overlays = await readdir(join(root, "state", "worker-codex"));
      expect(await readlink(join(root, "state", "worker-codex", overlays[0]!, "auth.json"))).toBe(
        join(account.home, "auth.json"),
      );
      const roster = await captain.serveOperatorConversation({ schemaVersion: 1, op: "fleet" });
      expect(
        roster.op === "fleet" && roster.snapshot.seats.find((seat) => seat.seatId === "term_0a1b2c")?.account,
      ).toEqual(account);
    } finally {
      await captain.close();
    }
  },
);
