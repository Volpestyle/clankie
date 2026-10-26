// Isolated native Node processes only. Control traffic never carries seat authority.
import { spawn } from "node:child_process";
import { createServer, request, Agent } from "node:http";
const role = process.argv[2];
const agent = new Agent({ keepAlive: true, maxSockets: 1 });
const children = [];
async function mcpChild(command) {
  const processChild = spawn(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      new URL("./operator-seat-binding-native-mcp.ts", import.meta.url).pathname,
      command.origin,
    ],
    {
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        ...process.env,
        NODE_ENV: "test",
        CLANKIE_OPERATOR_TOKEN: "native-fixture",
        CLANKIE_BRIDGE_NONCE_FILE: command.file,
      },
    },
  );
  children.push(processChild);
  return new Promise((resolve, reject) => {
    let text = "";
    const deadline = setTimeout(() => {
      processChild.kill("SIGKILL");
      reject(new Error("actual MCP fixture timed out"));
    }, 20_000);
    processChild.stdout.on("data", (chunk) => {
      text += chunk;
    });
    processChild.once("error", reject);
    processChild.once("exit", (code) => {
      clearTimeout(deadline);
      if (code !== 0) reject(new Error(`actual MCP fixture exited ${code}`));
      else resolve(JSON.parse(text.trim()));
    });
  });
}
async function child(name) {
  const processChild = spawn(process.execPath, [import.meta.filename, name], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, NODE_ENV: "test" },
  });
  children.push(processChild);
  return new Promise((resolve, reject) => {
    let text = "";
    processChild.stdout.on("data", (chunk) => {
      text += chunk;
      if (text.includes("\n")) resolve(JSON.parse(text.split("\n")[0]));
    });
    processChild.once("error", reject);
    processChild.once("exit", (code) => {
      if (!text.includes("\n")) reject(new Error(`fixture exited ${code}`));
    });
  });
}
const descendants =
  role === "launcher"
    ? [await child("harness")]
    : role === "harness"
      ? [await child("bridge"), await child("sibling"), await child("shell")]
      : role === "shell"
        ? [await child("nested")]
        : [];
const server = createServer(async (incoming, outgoing) => {
  let text = "";
  for await (const chunk of incoming) text += chunk;
  const command = JSON.parse(text);
  if (command.environment) {
    outgoing.end(
      JSON.stringify({
        filePresent: process.env.CLANKIE_BRIDGE_NONCE_FILE !== undefined,
        rawPresent: process.env.CLANKIE_BRIDGE_NONCE !== undefined,
      }),
    );
    return;
  }
  if (command.spawnMcp) {
    try {
      outgoing.end(JSON.stringify(await mcpChild(command)));
    } catch (error) {
      outgoing.end(JSON.stringify({ error: String(error) }));
    }
    return;
  }
  if (command.spawn) {
    outgoing.end(JSON.stringify(await child(command.spawn)));
    return;
  }
  const result = await new Promise((resolve, reject) => {
    const req = request(
      command.url,
      {
        method: command.method ?? "GET",
        agent,
        headers: {
          authorization: "Bearer native-fixture",
          "content-type": "application/json",
          ...command.headers,
        },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            body: body ? JSON.parse(body) : {},
            localPort: req.socket.localPort,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(command.body === undefined ? undefined : JSON.stringify(command.body));
  }).catch((error) => ({ error: String(error) }));
  outgoing.end(JSON.stringify(result));
});
server.listen(0, "127.0.0.1", () => {
  console.log(JSON.stringify({ role, pid: process.pid, port: server.address().port, descendants }));
});
process.on("SIGTERM", () => {
  agent.destroy();
  server.close();
  process.exit(0);
});
