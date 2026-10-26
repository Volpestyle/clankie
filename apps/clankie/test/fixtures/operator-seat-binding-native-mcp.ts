import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runMcpCommand } from "../../../tui/src/command/mcp.ts";

// The actual MCP command, with only its harness detection replaced. HTTP,
// nonce-file reading, upstream MCP, kernel identity and admission remain real.
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "isolated-native-seat-proof", version: "1" });
let ready!: () => void;
const serving = new Promise<void>((resolve) => {
  ready = resolve;
});
const running = runMcpCommand(["--lane", "operator", "--conversation", "native-seat"], {
  env: process.env,
  host: process.argv[2]!,
  readParentArgv: async () => "codex",
  transport: serverTransport,
  stderr: {
    write: (text) => {
      if (text.includes("serving the operator lane")) ready();
    },
  },
});
try {
  await Promise.race([
    serving,
    running.then(() => {
      throw new Error("MCP exited before serving");
    }),
  ]);
  await client.connect(clientTransport);
  const result = await client.listTools();
  await client.close();
  const exit = await running;
  console.log(
    JSON.stringify({
      pid: process.pid,
      tools: result.tools.map((tool) => tool.name),
      exit,
      filePresent: process.env.CLANKIE_BRIDGE_NONCE_FILE !== undefined,
      rawPresent: process.env.CLANKIE_BRIDGE_NONCE !== undefined,
    }),
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
}
