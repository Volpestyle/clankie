// ADR 0328: Clankie with every extension switched off still does his core job.
// The real service composition (apps/clankie/src/index.ts) on a scratch port,
// reached only through its HTTP API, the `clankie` CLI and the operator MCP.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, expect, it } from "vitest";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, "../../..");
const cliEntry = join(repo, "apps/tui/bin/clankie.ts");
const OPERATOR = "core-only-operator";
const CAPTAIN = "core-only-captain";
const native = process.platform === "darwin";

// The local fleet link proves a reporting process sits in its pane with this helper.
beforeAll(async () => {
  if (native)
    await exec(process.execPath, [join(repo, "scripts/build-fleet-proof.mjs")], { timeout: 120_000 });
}, 130_000);

/**
 * The hired `claude`: no model and no account. It answers the account probe,
 * tells Herdr it is a Claude session, keeps a Claude-shaped transcript, sends
 * Claude's Stop hook, and runs the worker channel over the local fleet link:
 * it takes each message from its mailbox, answers it, and reports it to its lead.
 */
function standInClaude(state: string, home: string): string {
  return `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const argv = process.argv.slice(2);
if (argv[0] === "--version") { console.log("1.0.0 (Claude Code)"); process.exit(0); }
if (argv[0] === "auth") {
  console.log(JSON.stringify({ loggedIn: true, email: "core@example.invalid", authMethod: "claude.ai" }));
  process.exit(0);
}
const pane = process.env.HERDR_PANE_ID;
const session = argv.includes("--session-id") ? argv[argv.indexOf("--session-id") + 1] : randomUUID();
// Claude's own transcript, where the lead confirms its startup prompt arrived.
const projects = join(${JSON.stringify(home)}, ".claude", "projects", "-core-only");
mkdirSync(projects, { recursive: true });
const transcript = join(projects, session + ".jsonl");
const line = (entry) => appendFileSync(transcript, JSON.stringify({ uuid: randomUUID(), sessionId: session,
  timestamp: new Date().toISOString(), ...entry }) + "\\n");
const record = (text) => line({ type: "user", message: { role: "user", content: text } });
const answer = (text) => line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const named = /@(\\S+)$/u.exec(argv.at(-1) ?? "");
if (named) record(JSON.parse(readFileSync(named[1], "utf8")).clankieBrief);
execFileSync("herdr", ["pane", "report-agent", pane, "--source", "herdr:claude", "--agent", "claude",
  "--state", "idle", "--agent-session-id", session]);
console.log("stand-in claude ready");
const link = () => readdirSync(join(${JSON.stringify(state)}, "links")).filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(join(${JSON.stringify(state)}, "links", name), "utf8")))
  .find((entry) => entry.socket === process.env.HERDR_SOCKET_PATH);
const bridge = randomUUID();
const route = (path) => new URL("/v1/fleet/seats/" + encodeURIComponent(pane) + "/" + path, link().url);
const headers = { "x-clankie-pane": pane, "x-clankie-bridge-id": bridge, "content-type": "application/json" };
// Claude's hooks, through the same seat route its plugin posts to.
const hook = async (event, extra = {}) => {
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await fetch(route("hook"), { method: "POST", headers, body: JSON.stringify({
      schemaVersion: 1, event, sessionId: session, ...extra }) }).catch(() => undefined);
    if (response?.ok) return;
    await new Promise((done) => setTimeout(done, 250));
  }
};
// It answers a moment later, as Claude's turn would.
const finish = async (reply) => {
  await new Promise((done) => setTimeout(done, 500));
  answer(reply);
  await hook("Stop", { lastMessage: reply });
};
// Claude's first turn works the brief its startup prompt names with @; the lead
// confirms that prompt in the transcript, then waits for the turn's Stop.
if (named) void hook("Stop", { lastMessage: "ready for work" });
// The worker channel: wait on the seat's mailbox, acknowledge each event, and report it.
for (;;) {
  try {
    const response = await fetch(route("events?wait=20000"), { headers });
    if (!response.ok) { await new Promise((done) => setTimeout(done, 250)); continue; }
    for (const event of (await response.json()).events ?? []) {
      console.log("heard: " + event.content);
      // Claude writes the channel event into its session as it takes it, then answers.
      record("<channel source=\\"clankie\\" kind=\\"" + event.kind + "\\" conversation=\\"" + event.conversationId +
        "\\" event_id=\\"" + event.id + "\\">\\n" + event.content + "\\n</channel>");
      await fetch(route("events/" + encodeURIComponent(event.id) + "/ack"), { method: "POST", headers });
      await finish("heard: " + event.content.split("\\n").at(-1));
      const { binding } = await (await fetch(route("messages"), { headers })).json();
      const sent = await fetch(route("messages"), { method: "POST", headers, body: JSON.stringify({
        schemaVersion: 1, text: "report: " + event.content, delivery: { id: randomUUID(), binding } }) });
      console.log("reported " + sent.status + " " + (await sent.text()));
    }
  } catch (error) {
    console.log("channel error " + error);
    await new Promise((done) => setTimeout(done, 250));
  }
}
`;
}

/** Every extension the owner can switch, off (ADR 0328 "Choosing extensions"). */
const ALL_OFF = Object.fromEntries(
  ["persona", "world", "voice", "relay", "browser", "media", "computer", "minecraft", "tracker-linear"].map(
    (id) => [id, "off"],
  ),
);

/** One HTTP route each switched extension mounts; off, none of them is served. */
const EXTENSION_ROUTES = [
  ["computer", "POST", "/v1/computer"],
  ["computer", "POST", "/v1/computer/authority"],
  ["world", "POST", "/v1/activity/admit"],
  ["world", "POST", "/v1/activity/shares"],
  ["tracker-linear", "POST", "/v1/tracker/mirror/linear"],
  ["tracker-linear", "POST", "/v1/tracker/cutover/linear"],
  ["tracker-linear", "GET", "/v1/linear/deliveries"],
  ["voice", "GET", "/v1/discord/room-voice"],
  ["voice", "POST", "/v1/discord/voice-output-guard"],
  ["persona", "GET", "/v1/discord/rooms"],
  ["persona", "GET", "/v1/discord/settings"],
  ["persona", "GET", "/v1/discord/readiness"],
  ["persona", "GET", "/v1/operator/appearance"],
] as const;

/**
 * Operator tools a switched-on extension adds: voice's join, leave and screen
 * shares are listed; media's diagrams wait in the deferred catalog.
 */
const LISTED_EXTENSION_TOOLS = ["voice_join", "voice_leave", "observe_share"];
const DEFERRED_EXTENSION_TOOLS = ["draw_er_diagram", "draw_sequence_diagram"];

async function freePort(): Promise<number> {
  for (;;) {
    const server = createServer();
    await new Promise<void>((done, fail) => {
      server.once("error", fail);
      server.listen(0, "127.0.0.1", done);
    });
    const { port } = server.address() as { port: number };
    await new Promise((done) => server.close(done));
    if (port !== 4310 && port !== 4321) return port;
  }
}

it.skipIf(!native)(
  "runs the fleet with every extension switched off",
  async () => {
    const started = Date.now();
    const root = await realpath(await mkdtemp(join(tmpdir(), "core-only-")));
    const home = join(root, "home");
    const project = join(root, "project");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(project);
    await exec("git", ["init", "-q", "-b", "main"], { cwd: project });
    await exec(
      "git",
      [
        "-c",
        "user.name=Core",
        "-c",
        "user.email=core@example.invalid",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init",
      ],
      { cwd: project },
    );
    // A hire checks its checkout is fresh against origin/main.
    await exec("git", ["init", "-q", "--bare", "-b", "main", join(root, "origin.git")]);
    await exec("git", ["remote", "add", "origin", join(root, "origin.git")], { cwd: project });
    await exec("git", ["push", "-q", "-u", "origin", "main"], { cwd: project });
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "claude"), standInClaude(join(root, "state"), home), { mode: 0o755 });
    // The default Claude profile the account probe reads: signed in and onboarded.
    await mkdir(join(home, ".claude"));
    await writeFile(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }));
    const path = `${bin}:${process.env.PATH}`;
    // The scratch Herdr's panes find the stand-in first; it never sees the owner's session.
    const inherited = process.env.PATH;
    process.env.PATH = path;
    const herdr = await isolatedHerdr(join(root, "herdr-log")).finally(() => {
      process.env.PATH = inherited;
    });
    const [port, relayPort, devicePort] = [await freePort(), await freePort(), await freePort()];
    const url = `http://127.0.0.1:${port}`;
    const settings = join(root, "settings.json");
    await writeFile(
      settings,
      JSON.stringify({
        schemaVersion: 1,
        herdr: { runtime: "external", session: "default", socketPath: herdr.socketPath },
        captain: { workingDirectory: root },
        extensions: ALL_OFF,
      }),
    );
    const env: NodeJS.ProcessEnv = {
      PATH: path,
      HOME: home,
      NODE_ENV: "test",
      CI: "1",
      CLANKIE_SCRATCH: "1",
      CLANKIE_STATE: join(root, "state"),
      CLANKIE_SETTINGS_FILE: settings,
      CLANKIE_CREDENTIALS_FILE: join(root, "credentials.json"),
      CLANKIE_TEST_FLEET_RESOURCES_DIRECTORY: join(root, "fleet-resources"),
      CLANKIE_OPERATOR_TOKEN: OPERATOR,
      CLANKIE_CAPTAIN_TOKEN: CAPTAIN,
      CLANKIE_CAPTAIN_URL: url,
      CLANKIE_CONTROL_PLANE_URL: url,
      CLANKIE_RELAY_PORT: String(relayPort),
      CLANKIE_RELAY_URL: `http://127.0.0.1:${relayPort}`,
      CLANKIE_DEVICE_PORT: String(devicePort),
      PORT: String(port),
    };
    const service: ChildProcess = spawn(
      process.execPath,
      [
        "--import",
        join(repo, "apps/tui/node_modules/tsx/dist/loader.mjs"),
        join(repo, "apps/clankie/src/index.ts"),
      ],
      { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let log = "";
    service.stdout!.on("data", (data) => (log += String(data)));
    service.stderr!.on("data", (data) => (log += String(data)));
    const operator = { authorization: `Bearer ${OPERATOR}` };
    const clankie = async (args: string[], cwd = project) => {
      const { stdout } = await exec(process.execPath, [cliEntry, ...args], { cwd, env, timeout: 60_000 });
      return JSON.parse(stdout);
    };
    let mcp: Client | undefined;
    try {
      const deadline = Date.now() + 30_000;
      while (!log.includes("clankie listening") && service.exitCode === null && Date.now() < deadline)
        await new Promise((done) => setTimeout(done, 50));
      expect(log, log).toContain("clankie listening");

      // /health is ok and every extension it lists is off.
      const health = (await (await fetch(`${url}/health`)).json()) as {
        ok: boolean;
        extensions: { id: string; state: string }[];
      };
      expect(health.ok).toBe(true);
      expect(health.extensions.map((entry) => entry.id).sort()).toEqual([
        "browser",
        "computer",
        "media",
        "persona",
        "relay",
        "tracker-linear",
        "voice",
        "world",
      ]);
      expect(health.extensions.filter((entry) => entry.state !== "off")).toEqual([]);
      const listed = await clankie(["extensions"]);
      expect(listed.switches).toEqual(ALL_OFF);
      expect(listed.extensions.filter((entry: { state: string }) => entry.state !== "off")).toEqual([]);

      // Extension routes are not mounted.
      for (const [, method, path] of EXTENSION_ROUTES) {
        const response = await fetch(`${url}${path}`, {
          method,
          headers: { ...operator, "content-type": "application/json" },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        expect({ path, status: response.status }).toEqual({ path, status: 404 });
      }

      // Issues on a local-files tracker, through the CLI and the service.
      expect((await clankie(["work", "init"])).repo.backend).toBe("default");
      const created = await clankie(["work", "create", "Core-only issue", "--criterion", "It works"]);
      expect(created.item.location).toMatch(/^\.clankie\/work\/.+\.md$/u);
      const file = await readFile(join(project, created.item.location), "utf8");
      expect(file).toContain("Core-only issue");
      await clankie(["work", "update", created.item.id, "--check", "1", "--status", "done"]);
      const items = (await clankie(["work", "list"])).items as { id: string; status: string }[];
      expect(items).toEqual([expect.objectContaining({ id: created.item.id, status: "done" })]);

      // The notes board the apps share is served by the core: the owner reads it.
      const board = await fetch(`${url}/operator/v1/dispatch`, {
        method: "POST",
        headers: { ...operator, "content-type": "application/json" },
        body: JSON.stringify({ op: "app_notes", schemaVersion: 1, action: "read" }),
      });
      expect(board.status).toBe(200);
      expect(((await board.json()) as { result: unknown }).result).toEqual(
        expect.objectContaining({ notes: [] }),
      );

      // The operator MCP, through `clankie mcp`, offers no extension's tools.
      mcp = new Client({ name: "core-only", version: "1" });
      await mcp.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [cliEntry, "mcp", "--lane", "operator", "--conversation", "global-default"],
          env: env as Record<string, string>,
          cwd: project,
          stderr: "ignore",
        }),
      );
      const tools = (await mcp.listTools()).tools.map((tool) => tool.name);
      expect(tools).toEqual(expect.arrayContaining(["hire_agent", "message_seat", "worker_reports"]));
      expect(tools.filter((name) => LISTED_EXTENSION_TOOLS.includes(name))).toEqual([]);
      const deferred = (await mcp.callTool({
        name: "mcp_tool_search",
        arguments: { names: DEFERRED_EXTENSION_TOOLS },
      })) as { structuredContent?: { tools?: { name: string }[]; missing?: string[] } };
      expect(deferred.structuredContent?.tools).toEqual([]);
      expect(deferred.structuredContent?.missing?.sort()).toEqual([...DEFERRED_EXTENSION_TOOLS].sort());

      // A hire into the scratch Herdr starts in its own pane.
      const dispatch = async (body: Record<string, unknown>) => {
        const response = await fetch(`${url}/operator/v1/dispatch`, {
          method: "POST",
          headers: { authorization: `Bearer ${CAPTAIN}`, "content-type": "application/json" },
          body: JSON.stringify({ schemaVersion: 1, ...body }),
        });
        expect(response.status).toBe(200);
        return (await response.json()) as any;
      };
      const hired = await dispatch({
        op: "spawn_seat",
        conversationId: "global-default",
        seat: { schemaVersion: 1, title: "Core worker", workingDirectory: project, harness: "claude" },
      });
      expect(hired.result, log).toMatchObject({
        outcome: "spawned",
        control: { mode: "channel" },
        seat: { harness: "claude", title: "Core worker" },
      });
      const seat = hired.result.seat as { seatId: string };
      const panes = (await herdr.cli("pane", "list")).result.panes as {
        pane_id: string;
        terminal_id: string;
        agent?: string;
        agent_session?: { value: string };
      }[];
      const hire = panes.find((entry) => entry.terminal_id === seat.seatId);
      expect(hire).toMatchObject({ agent: "claude", agent_session: { value: expect.any(String) } });

      // He messages it through the MCP; its channel takes the message into its session.
      const messaged = (await mcp.callTool({
        name: "message_seat",
        arguments: { seat: seat.seatId, message: "core-only hello" },
      })) as { structuredContent?: Record<string, unknown> };
      expect(messaged.structuredContent).toMatchObject({ outcome: "delivered", deliveryStage: "consumed" });

      // He reads its session through the MCP.
      const read = async () =>
        (
          (await mcp!.callTool({
            name: "agent_session_read",
            arguments: { ref: `local:${hire!.agent_session!.value}`, tail: 10 },
          })) as { structuredContent?: { entries?: { role: string; text: string }[] } }
        ).structuredContent?.entries ?? [];
      await expect
        .poll(read, { timeout: 20_000 })
        .toContainEqual(expect.objectContaining({ role: "agent", text: "heard: core-only hello" }));

      // Its report lands with its lead.
      const reports = async () =>
        (await dispatch({ op: "worker_reports", conversationId: "global-default" })).page.items as {
          paneId: string;
          text: string;
        }[];
      await expect.poll(reports, { timeout: 20_000 }).toEqual([
        expect.objectContaining({
          paneId: hire!.pane_id,
          text: expect.stringContaining("core-only hello"),
        }),
      ]);

      console.info(`core-only composition proof took ${Date.now() - started} ms`);
    } finally {
      await mcp?.close().catch(() => {});
      if (service.exitCode === null && service.signalCode === null) {
        const exited = once(service, "exit");
        service.kill("SIGTERM");
        const timer = setTimeout(() => service.kill("SIGKILL"), 5_000);
        await exited;
        clearTimeout(timer);
      }
      await herdr.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  180_000,
);
