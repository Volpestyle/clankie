// Service-authored launch helper. stdin is the secret transport; stdout is receipts only.
import { createServer, createConnection } from "node:net";
import { createInterface } from "node:readline";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
const execute = promisify(execFile);
const quote = (text) => "'" + text.replaceAll("'", "''") + "'";
const line = (stream) =>
  new Promise((resolve, reject) => {
    let text = "";
    const finish = (error, value) => {
      clearTimeout(timer);
      stream.off("data", data);
      stream.off("error", lost);
      stream.off("end", lost);
      if (error) reject(error);
      else resolve(value);
    };
    const lost = () => finish(new Error("Launch transport lost"));
    const data = (chunk) => {
      text += chunk.toString();
      if (text.length > 1024 * 1024) return finish(new Error("Launch frame too large"));
      if (!text.includes("\n")) return;
      try {
        finish(undefined, JSON.parse(text.slice(0, text.indexOf("\n"))));
      } catch {
        finish(new Error("Invalid launch frame"));
      }
    };
    const timer = setTimeout(() => finish(new Error("Launch transport timeout")), 45000);
    stream.on("error", lost);
    stream.on("end", lost);
    stream.on("data", data);
  });
const ps = async (script) =>
  (
    await execute(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { timeout: 10000 },
    )
  ).stdout.trim();

if (process.argv[2] === "--head") {
  const socket = createConnection({ host: "127.0.0.1", port: Number(process.argv[3]) });
  socket.on("connect", () =>
    socket.write(JSON.stringify({ ticket: process.argv[4], pane: process.env.HERDR_PANE_ID }) + "\n"),
  );
  const spec = await line(socket);
  socket.end();
  if (!spec.token || spec.pane !== process.env.HERDR_PANE_ID) throw new Error("Launch binding changed");
  const child = spawn(
    spec.executable,
    [
      "--name",
      spec.title,
      "--session-id",
      spec.nativeSession,
      "--plugin-dir",
      spec.plugin,
      "--dangerously-load-development-channels",
      "plugin:clankie-remote-lead@inline",
      "--settings",
      JSON.stringify({
        outputStyle: "clankie",
        autoMemoryEnabled: false,
        enabledPlugins: { "clankie-remote-lead@inline": true },
      }),
    ],
    {
      cwd: spec.cwd,
      stdio: "inherit",
      env: {
        ...process.env,
        CLANKIE_REMOTE_LEAD_TOKEN: spec.token,
        CLANKIE_SEAT_SESSION_ID: spec.nativeSession,
        CLANKIE_SEAT_HARNESS: "claude",
        CLANKIE_REMOTE_LEAD_FLEET: spec.fleet,
        CLANKIE_CONVERSATION_ID: spec.conversationId,
      },
    },
  );
  delete spec.token;
  child.on("error", () => {
    process.stderr.write("Remote lead harness failed to start\n");
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
} else {
  if (process.platform !== "win32") throw new Error("Remote lead launch currently requires Windows");
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
  const first = await input.next();
  const spec = JSON.parse(first.value);
  const sessions = JSON.parse((await execute("herdr", ["session", "list", "--json"])).stdout).sessions;
  const matches = sessions.filter((entry) => entry.name === spec.session && entry.running);
  if (matches.length !== 1) throw new Error("Registered Herdr session unavailable");
  const env = { ...process.env, HERDR_SOCKET_PATH: matches[0].socket_path };
  const herdr = async (args) => JSON.parse((await execute("herdr", args, { env, timeout: 15000 })).stdout);
  const executable = await ps(
    "$ErrorActionPreference='Stop'; $a=@(Get-Command claude.exe -All -CommandType Application | Select-Object -ExpandProperty Source -Unique); if($a.Count -ne 1){throw 'Native Claude unavailable'}; $a[0]",
  );
  const created = await herdr([
    "workspace",
    "create",
    "--cwd",
    spec.cwd,
    "--label",
    spec.title,
    "--no-focus",
  ]);
  const pane = created.result.root_pane.pane_id;
  const info = (await herdr(["pane", "process-info", "--pane", pane])).result.process_info;
  const shell = {
    pid: info.shell_pid,
    startTime: await ps(
      `(Get-Process -Id ${Number(info.shell_pid)}).StartTime.ToUniversalTime().ToString('O')`,
    ),
  };
  process.stdout.write(JSON.stringify({ stage: "allocated", pane, shell }) + "\n");
  const second = await input.next();
  const { token, conversationId } = JSON.parse(second.value);
  const ticket = randomUUID();
  const server = createServer();
  let claimed = false;
  const sent = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Lead handoff unconfirmed"));
    }, 45000);
    server.on("connection", async (socket) => {
      try {
        const hello = await line(socket);
        if (claimed || hello.ticket !== ticket || hello.pane !== pane) {
          socket.destroy();
          return;
        }
        claimed = true;
        server.close();
        socket.end(JSON.stringify({ ...spec, executable, pane, token, conversationId }) + "\n", () => {
          clearTimeout(timeout);
          resolve();
        });
      } catch {
        socket.destroy();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const command = `& ${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} --head ${server.address().port} ${quote(ticket)}`;
  await herdr(["pane", "run", pane, command]);
  await sent;
  process.stdout.write(JSON.stringify({ stage: "dispatched", pane }) + "\n");
  await input.return();
}
