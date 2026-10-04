import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { connectLaneUpstream, runMcpCommand } from "../../../tui/src/command/mcp.ts";

const [host, bearer] = process.argv.slice(2);
if (!host || !bearer) throw new Error("MCP integration fixture requires a host and bearer");

process.exitCode = await runMcpCommand(["--lane", "operator"], {
  transport: new StdioServerTransport() as unknown as Transport,
  readParentArgv: async () => undefined,
  connectUpstream: async () => connectLaneUpstream({ host, bearer }),
});
