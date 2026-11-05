import { createServer, type Socket } from "node:net";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { createGrokSeatAdapter } from "../../src/captain/grok-seat-adapter.ts";
const cleanup: Array<() => unknown | Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Production Grok adapter/IPC; binary version, leader process witness and replies are fixtures. */
export async function grokReceiptFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "receipt-grok-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  await mkdir(bin);
  const executable = join(bin, "grok");
  await writeFile(executable, "#!/bin/sh\nprintf 'grok 1.0.46 (fixture)\\n'\n", { mode: 0o700 });
  const processHelper = join(root, "process.py");
  let sessionId = "",
    admitted = 0,
    hook = async () => {},
    sending = false;
  const cwd = process.cwd();
  const proof = {
    nativeOccupantId: "fixture-grok",
    pane: "fixture-pane",
    fleet: "default",
    binding: { socketPath: join(root, "herdr.sock") },
    processes: [{ pid: process.pid, startTime: "1" }],
    shell: { pid: process.pid, startTime: "1" },
  };
  const native = {
    capture: async () => ({
      paneId: "fixture-pane",
      terminalId: "fixture-seat",
      process: proof.shell,
      check: async () => true,
      verifyAllocation: async () => {
        if (sending) {
          const next = hook;
          hook = async () => {};
          await next();
        }
      },
      proof: async () => proof,
      report: async () => {},
    }),
    createCommandTab: async () => "fixture-pane",
    register: () => () => {},
    allows: async () => true,
  };
  // Record only the macOS host observations. The real adapter, socket/inode
  // checks, native protocol and final sender admission run on every CI host.
  const adapter = createGrokSeatAdapter({
    repoRoot: root,
    stateDir: root,
    native,
    processHelper,
    discover: async () => ({ executable, version: "1.0.46" }),
    readProcess: async (file, args) => {
      if (
        file === "/usr/bin/python3" &&
        JSON.stringify(args) === JSON.stringify(["-I", processHelper, String(process.pid)])
      )
        return JSON.stringify({
          pid: process.pid,
          uid: process.getuid!(),
          birth: ["1", "1"],
          executable,
        });
      if (file === "/usr/sbin/lsof" && args[2] === String(process.pid)) {
        if (JSON.stringify(args) === JSON.stringify(["-a", "-p", String(process.pid), "-U", "-Fn"]))
          return `p${process.pid}\nn${socketPath}\n`;
        if (JSON.stringify(args) === JSON.stringify(["-a", "-p", String(process.pid), "-d", "cwd", "-Fn"]))
          return `p${process.pid}\nn${cwd}\n`;
      }
      throw new Error(`Unrecorded Grok process observation: ${file} ${args.join(" ")}`);
    },
  });
  const prepared = await adapter.prepare!({
    harness: "grok",
    cwd,
    brief: "",
    env: { PATH: bin, GROK_HOME: root },
  });
  cleanup.push(() => prepared.dispose());
  sessionId = prepared.command[prepared.command.indexOf("--session-id") + 1]!;
  const socketPath = prepared.command[prepared.command.indexOf("--leader-socket") + 1]!;
  // This directory is owned by the prepared launch, and the adapter leaves its
  // native TUI for the owner. The fixture owns both and removes only its path.
  cleanup.push(() => rm(join(socketPath, ".."), { recursive: true, force: true }));
  await writeFile(
    join(root, "active_sessions.json"),
    JSON.stringify([{ pid: process.pid, session_id: sessionId, cwd }]),
  );
  const sockets = new Set<Socket>();
  const server = createServer((peer) => {
    sockets.add(peer);
    peer.once("close", () => sockets.delete(peer));
    let buffer = Buffer.alloc(0);
    const write = (frame: unknown) => {
      const body = Buffer.from(JSON.stringify(frame)),
        header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      peer.write(Buffer.concat([header, body]));
    };
    peer.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (buffer.length < size + 4) break;
        const frame = JSON.parse(buffer.subarray(4, size + 4).toString());
        buffer = buffer.subarray(size + 4);
        if (frame.type === "register") {
          write({
            type: "registered",
            ready: true,
            leader_protocol_version: 1,
            leader_binary_version: "1.0.46",
            leader_capabilities: { control_v1: true },
          });
          continue;
        }
        if (frame.type === "control") {
          write({
            type: "control_result",
            request_id: frame.request_id,
            result: {
              Ok: {
                pid: process.pid,
                socket_path: socketPath,
                leader_protocol_version: 1,
                leader_binary_version: "1.0.46",
              },
            },
          });
          continue;
        }
        const rpc = JSON.parse(frame.payload);
        let result: unknown = {};
        if (rpc.method === "initialize")
          result = {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
            _meta: { agentVersion: "1.0.46" },
          };
        if (rpc.method === "session/load") result = { _meta: { sessionId } };
        if (rpc.method === "_x.ai/mcp/list")
          result = {
            result: {
              servers: [
                {
                  name: "clankie",
                  session: {
                    enabled: true,
                    status: "ready",
                    tools: ["clankie_tools", "clankie_call", "message_clankie"].map((name) => ({
                      name,
                      enabled: true,
                    })),
                  },
                },
              ],
            },
          };
        if (rpc.method === "session/prompt") {
          admitted++;
          result = { stopReason: "end_turn", _meta: { sessionId, promptId: rpc.params._meta.promptId } };
        }
        write({ type: "acp", payload: JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }) });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanup.push(async () => {
    for (const peer of sockets) peer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const started = await prepared.start({ paneId: "fixture-pane", name: "fixture", run: async () => {} });
  if (started.outcome !== "started") throw new Error(JSON.stringify(started));
  cleanup.push(() => started.control.close());
  const send = started.control.send.bind(started.control);
  started.control.send = async (...args) => {
    sending = true;
    try {
      return await send(...args);
    } finally {
      sending = false;
    }
  };
  return {
    control: started.control,
    admitted: () => admitted,
    beforeMutation: (next: () => Promise<void>) => {
      hook = next;
    },
  };
}
