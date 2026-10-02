/**
 * A throwaway Clankie service for the seat arm. It runs the real service
 * (apps/clankie/src/index.ts) under its own macOS sandbox: every state, config
 * and credential path is inside the attempt, provider keys in the checkout's
 * .env.local are unreadable, and its only network is loopback, where the one
 * Discord body it can reach is a fake that records what it was asked to do.
 * Nothing can reach the live service, the owner's Keychain or any account.
 */
import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const quote = (value) => JSON.stringify(value);

const freePort = () =>
  new Promise((done) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });

function serviceProfile(root, checkout) {
  return `(version 1)
(deny default)
(allow process-exec process-fork sysctl-read file-map-executable dynamic-code-generation)
(allow signal (target self) (target same-sandbox))
(allow process-info* (target self) (target same-sandbox))
(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.logd") (global-name "com.apple.system.logger") (global-name "com.apple.system.notification_center") (global-name "com.apple.FSEvents"))
(allow file-read-metadata)
(allow file-read* (literal "/") (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/opt/homebrew") (subpath "/private/etc") (subpath "/private/var/db/timezone") (subpath "/dev") (subpath ${quote(checkout)}) (subpath ${quote(root)}))
(deny file-read* (literal ${quote(join(checkout, ".env.local"))}) (subpath ${quote(join(checkout, "evals"))}))
(allow file-write* (subpath ${quote(root)}) (literal "/dev/null"))
(allow network-bind network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
(allow network-bind network-inbound (local unix-socket (subpath ${quote(root)})))
(allow network-outbound (remote unix-socket (subpath ${quote(root)})))
`;
}

/**
 * Enough of herdr for a fleet census, a hire and a follow-up message: every
 * command is logged, and state starts from the fixture's panes. Adapted from
 * the hire-brief test's fake.
 */
const fakeHerdr = (fleet) => `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
// Paths are baked in, not passed by environment, so the fixture stays out of \`printenv\`.
const statePath = ${JSON.stringify(fleet.state)};
const sessionPath = ${JSON.stringify(fleet.session)};
fs.appendFileSync(${JSON.stringify(fleet.log)}, JSON.stringify(args) + "\\n");
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const out = (result) => process.stdout.write(JSON.stringify({ result }));
const find = (target) => state.panes.find((pane) => pane.pane_id === target || pane.name === target || pane.terminal_id === target);
const [group, command] = args;
if (group === "api" && command === "snapshot") {
  out({ snapshot: { workspaces: [{ workspace_id: "w1", label: "eval" }], tabs: [{ tab_id: "w1:t1", workspace_id: "w1" }], panes: state.panes } });
} else if (group === "session" && command === "list") {
  process.stdout.write(JSON.stringify({ sessions: [] }));
} else if (group === "tab" && command === "create") {
  const n = state.panes.length + 10;
  const pane = { pane_id: "w1:p" + n, terminal_id: "term_eval" + n, agent: "shell", agent_status: "idle", cwd: process.cwd() };
  state.panes.push(pane);
  save();
  out({ root_pane: { pane_id: pane.pane_id } });
} else if (group === "agent" && command === "start") {
  const pane = find(args[args.indexOf("--pane") + 1]);
  const kind = args[args.indexOf("--kind") + 1];
  Object.assign(pane, { name: args[2], agent: kind, agent_status: "idle" });
  if (kind !== "codex") pane.agent_session = { source: "herdr:" + kind, kind: "path", value: sessionPath };
  save();
  out({});
} else if (group === "agent" && command === "prompt") {
  const pane = find(args[2]);
  if (!pane) { process.stderr.write("agent target " + args[2] + " not found"); process.exit(1); }
  pane.agent_status = "working";
  const text = args[3];
  const record = pane.agent === "codex"
    ? { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }], internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] } } }
    : { type: pane.agent === "claude" ? "user" : "message", uuid: "prompt-" + Date.now(), id: "prompt-" + Date.now(), message: { role: "user", content: text } };
  fs.appendFileSync(sessionPath, JSON.stringify(record) + "\\n");
  pane.agent_session = { source: "herdr:" + pane.agent, kind: "path", value: sessionPath };
  save();
  out({ agent: pane });
} else if (group === "agent" && command === "get") {
  const pane = find(args[2]);
  if (!pane) { process.stderr.write("agent target " + args[2] + " not found"); process.exit(1); }
  out({ agent: pane });
} else if (group === "agent" && command === "wait") {
  setTimeout(() => out({ agent: find(args[2]) }), 60000);
} else if (group === "agent" && command === "list") {
  out({ agents: state.panes.filter((pane) => pane.agent !== "shell") });
} else if (group === "pane" && command === "list") {
  out({ panes: state.panes });
} else if (group === "pane" && command === "send-keys") {
  const pane = find(args[2]);
  if (pane && pane.agent !== "shell") pane.agent_status = "working";
  save();
  out({});
} else {
  out({});
}
`;

/**
 * The fake fleet lives beside the attempt, not inside the service: every arm
 * gets the same `herdr` on PATH, because a machine has herdr with or without
 * Clankie. Returns the paths and environment a process needs to use it.
 */
export function writeFleet(dir, panes) {
  const fleet = {
    bin: join(dir, "bin"),
    state: join(dir, "herdr-state.json"),
    log: join(dir, "herdr.jsonl"),
    session: join(dir, "herdr-session.jsonl"),
  };
  mkdirSync(fleet.bin, { recursive: true });
  writeFileSync(join(fleet.bin, "herdr"), fakeHerdr(fleet));
  chmodSync(join(fleet.bin, "herdr"), 0o755);
  writeFileSync(fleet.state, JSON.stringify({ panes }));
  writeFileSync(fleet.log, "");
  writeFileSync(fleet.session, "");
  fleet.calls = () =>
    readFileSync(fleet.log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return fleet;
}

/** What the fake voice body answers, in the protocol's DiscordVoicePresenceResult shape. */
const VOICE_ANSWERS = {
  "/voice/join": {
    action: "joined",
    channelId: "voice-lounge",
    actorCanBeHeard: true,
    transcriptLoggingEnabled: true,
  },
  "/voice/leave": { action: "left", channelId: "voice-lounge" },
};

/** The Discord body's control port: records every action, answers success. */
function fakeDiscordBody(port, logPath) {
  const server = createHttpServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      let parsed = body;
      try {
        parsed = JSON.parse(body);
      } catch {
        /* keep raw text */
      }
      appendFileSync(
        logPath,
        `${JSON.stringify({ at: new Date().toISOString(), method: request.method, path: request.url, body: parsed })}\n`,
      );
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(VOICE_ANSWERS[request.url] ?? { ok: true }));
    });
  });
  return new Promise((done) => server.listen(port, "127.0.0.1", () => done(server)));
}

/**
 * Start the service under `root/service`. `seed(paths)` writes fixture state
 * (memory, room logs, fleet) before the process starts.
 */
export async function startService(
  root,
  { checkout = repo, settings = {}, seed, fleet, env: extra = {} } = {},
) {
  const base = join(root, "service");
  const paths = {
    base,
    home: join(base, "home"),
    config: join(base, "config"),
    xdgState: join(base, "xdg-state"),
    data: join(base, "data"),
    state: join(base, "state"),
    tmp: join(base, "tmp"),
    settings: join(base, "config", "clankie", "settings.json"),
    discordLog: join(base, "discord-body.jsonl"),
    log: join(base, "service.log"),
    herdrSocket: join(base, "herdr.sock"),
  };
  // Harness homes a hire inspects for session files; empty, never the owner's.
  for (const dir of [
    paths.home,
    join(paths.home, ".codex", "sessions"),
    join(paths.home, ".claude", "projects"),
    dirname(paths.settings),
    paths.xdgState,
    paths.data,
    paths.state,
    paths.tmp,
  ])
    mkdirSync(dir, { recursive: true });
  writeFileSync(paths.discordLog, "");
  // A hire checks for its harness CLI; the service sees inert stand-ins, never
  // the owner's real Claude Code or Codex.
  const harnessBin = join(base, "bin");
  mkdirSync(harnessBin, { recursive: true });
  for (const name of ["claude", "codex"]) {
    writeFileSync(
      join(harnessBin, name),
      `#!/bin/sh\n[ "$1" = "--version" ] && echo "0.0.0 (${name} eval stand-in)"\nexit 0\n`,
    );
    chmodSync(join(harnessBin, name), 0o755);
  }
  // A fleet means a fake herdr answering on a real socket; otherwise no herdr at all.
  let socket;
  if (fleet) {
    socket = createServer((connection) => connection.end());
    await new Promise((done) => socket.listen(paths.herdrSocket, done));
  }
  writeFileSync(
    paths.settings,
    JSON.stringify({
      schemaVersion: 1,
      herdr: fleet ? { runtime: "external", socketPath: paths.herdrSocket } : { runtime: "disabled" },
      ...settings,
    }),
  );
  await seed?.(paths);
  const [port, relay, activity, producer, control] = await Promise.all(
    Array.from({ length: 5 }, () => freePort()),
  );
  const body = await fakeDiscordBody(control, paths.discordLog);
  const token = `eval-operator-${Math.random().toString(36).slice(2)}`;
  const captainToken = `eval-captain-${Math.random().toString(36).slice(2)}`;
  writeFileSync(join(base, "service.sb"), serviceProfile(root, checkout));
  const child = spawn(
    "/usr/bin/sandbox-exec",
    [
      "-f",
      join(base, "service.sb"),
      join(checkout, "apps/clankie/node_modules/.bin/tsx"),
      join(checkout, "apps/clankie/src/index.ts"),
    ],
    {
      cwd: base,
      env: {
        PATH: `${harnessBin}:${fleet ? `${fleet.bin}:` : ""}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
        HOME: paths.home,
        TMPDIR: paths.tmp,
        XDG_CONFIG_HOME: paths.config,
        XDG_STATE_HOME: paths.xdgState,
        XDG_DATA_HOME: paths.data,
        CLANKIE_STATE: paths.state,
        CLANKIE_SETTINGS_FILE: paths.settings,
        CLANKIE_CREDENTIALS_FILE: join(dirname(paths.settings), "credentials.json"),
        CLANKIE_OPERATOR_TOKEN: token,
        CLANKIE_CAPTAIN_TOKEN: captainToken,
        CLANKIE_BROWSER_ENABLED: "false",
        CLANKIE_TLDRAW_ENABLED: "false",
        PORT: String(port),
        CLANKIE_RELAY_PORT: String(relay),
        CLANKIE_ACTIVITY_PORT: String(activity),
        CLANKIE_ACTIVITY_PRODUCER_PORT: String(producer),
        // Both Discord bodies resolve to the recording fake, never the live bridge.
        CLANKIE_DISCORD_BRIDGE_CONTROL_PORT: String(control),
        CLANKIE_USER_SESSION_CONTROL_PORT: String(control),
        LANG: "en_US.UTF-8",
        SHELL: "/bin/sh",
        ...extra,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  writeFileSync(paths.log, "");
  const capture = (chunk) => appendFileSync(paths.log, chunk);
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const url = `http://127.0.0.1:${port}`;
  const exited = new Promise((done) => child.once("exit", done));
  // The service shuts down gracefully on SIGTERM but may take its time; a
  // campaign never leaves one running, so escalate and wait for the exit.
  const stop = async () => {
    const signal = (name) => {
      try {
        process.kill(-child.pid, name);
      } catch {
        /* already exited */
      }
    };
    if (child.exitCode === null && child.signalCode === null) {
      signal("SIGTERM");
      const timer = setTimeout(() => signal("SIGKILL"), 5000);
      await exited;
      clearTimeout(timer);
    }
    body.closeAllConnections();
    await new Promise((done) => body.close(done));
    // The service may still hold the socket; closing must not wait on it.
    socket?.close();
  };
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      if ((await fetch(`${url}/health`)).ok) break;
    } catch {
      /* not listening yet */
    }
    if (child.exitCode !== null || Date.now() > deadline) {
      await stop();
      throw Error(`Throwaway service did not start:\n${readFileSync(paths.log, "utf8").slice(-2000)}`);
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  return {
    url,
    port,
    token,
    captainToken,
    paths,
    stop,
    discordCalls: () =>
      readFileSync(paths.discordLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}
