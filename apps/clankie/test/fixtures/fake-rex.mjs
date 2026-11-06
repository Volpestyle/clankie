// A stand-in `rex` CLI for tests (#963): Rex isn't run in tests. It answers the subset of
// commands Clankie's Rex adapter uses, from a JSON state file (`FAKE_REX_STATE`), with the
// shapes Rex documents where it documents them (`rex ls --json`, `server.version`, the
// `rex events --json` envelope, exit 4 for an unreachable server) and the adapter's
// guessed shapes otherwise (`block ls`, the `program_status` and `process` block methods).
// Every call is appended to `FAKE_REX_LOG` as `{ argv, stdin }`.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.FAKE_REX_STATE;
const logPath = process.env.FAKE_REX_LOG;
const raw = process.argv.slice(2);
const stdin = await new Promise((resolve) => {
  if (process.stdin.isTTY) return resolve("");
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => resolve(data));
  process.stdin.on("error", () => resolve(data));
});
if (logPath) appendFileSync(logPath, `${JSON.stringify({ argv: raw, stdin })}\n`);

const load = () => JSON.parse(readFileSync(statePath, "utf8"));
const save = (state) => writeFileSync(statePath, JSON.stringify(state));
const fail = (code, message) => {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(code);
};
const out = (value) => process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);

// Global options may come first; the adapter passes these.
const args = [];
for (let index = 0; index < raw.length; index += 1) {
  const arg = raw[index];
  if (arg.startsWith("--autostart")) continue;
  if (arg === "--timeout" || arg === "-S") {
    index += 1;
    continue;
  }
  args.push(arg);
}
const flag = (name) => {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
};

const state = load();
if (state.down) fail(4, "server unreachable: dial unix: no such file or directory");
const session = (id) =>
  state.sessions.find((entry) => entry.session_id === id) ?? fail(3, `session ${id} not found`);
const block = (s, id) =>
  session(s).blocks.find((entry) => entry.block_id === id) ?? fail(3, `block ${id} not found`);
const [command, sub] = args;

if (command === "api" && sub === "call") {
  const method = args[2];
  if (method === "server.version") out(state.version);
  else if (method === "block.event") {
    const request = JSON.parse(stdin);
    if (state.failPaste) fail(1, "block.event: internal error (status=500 code=internal)");
    const target = block(request.session_id, request.block_id);
    if (request.event?.type !== "paste") fail(1, "unsupported event");
    target.pasted = [...(target.pasted ?? []), request.event.payload.text];
    save(state);
    out({});
  } else fail(1, `method ${method} not found (status=404 code=method_not_found)`);
} else if (command === "ls") {
  out({ sessions: state.sessions.map(({ session_id, label }) => ({ session_id, label })) });
} else if (command === "block" && sub === "ls") {
  out({
    blocks: session(flag("-s")).blocks.map(({ block_id, label, creator_name }) => ({
      block_id,
      label,
      creator_name,
    })),
  });
} else if (command === "block" && sub === "call") {
  const target = block(flag("-s"), flag("-b"));
  const method = args[args.indexOf(flag("-b")) + 1];
  if (method === "program_status") out({ records: target.records ?? [] });
  else if (method === "process") out({ foreground: target.foreground ?? null });
  else if (method === "format") out({ content: target.screen ?? "" });
  else fail(1, `method ${method} not found`);
} else if (command === "capture") {
  out(block(flag("-s"), flag("-b")).capture ?? "");
} else if (command === "send-key") {
  const target = block(flag("-s"), flag("-b"));
  const keys = args.slice(args.indexOf(flag("-b")) + 1);
  target.keys = [...(target.keys ?? []), ...keys];
  // An agent that takes a pasted message starts working on Enter, and says so.
  if (keys.includes("enter") && target.takes && (target.pasted ?? []).length > 0) {
    const root = target.records.find((record) => record.id === undefined);
    root.state = "working";
    state.events = [
      ...(state.events ?? []),
      {
        type: "session_event",
        payload: {
          session_id: flag("-s"),
          event: {
            type: "block_event",
            payload: {
              block_id: target.block_id,
              creator_name: "com.superlogical.terminal",
              name: "program_status_changed",
              payload: { record: { state: "working", app: root.app }, reason: "report" },
            },
          },
        },
      },
    ];
  }
  save(state);
} else if (command === "block" && sub === "close") {
  const s = session(flag("-s"));
  const id = args[args.length - 1];
  block(s.session_id, id);
  s.blocks = s.blocks.filter((entry) => entry.block_id !== id);
  save(state);
} else if (command === "events") {
  const id = flag("-s");
  let printed = 0;
  const tick = () => {
    const events = (load().events ?? []).filter((event) => event.payload?.session_id === id);
    for (; printed < events.length; printed += 1) out(events[printed]);
  };
  setInterval(tick, 25);
  process.on("SIGTERM", () => process.exit(0));
} else {
  fail(2, `unknown command: ${args.join(" ")}`);
}
