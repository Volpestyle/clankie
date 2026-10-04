import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  connectLaneUpstream,
  runMcpCommand,
  type LaneUpstreamTransportEvent,
} from "../../../tui/src/command/mcp.ts";

const [host, bearer, channel, diagnostics] = process.argv.slice(2);
if (!host || !bearer) throw new Error("MCP integration fixture requires a host and bearer");
process.exitCode = await runMcpCommand(["--lane", "operator"], {
  transport: new StdioServerTransport() as unknown as Transport,
  readParentArgv: async () =>
    channel === "channel" ? "claude --dangerously-load-development-channels server:clankie" : undefined,
  connectUpstream: async () =>
    connectLaneUpstream({
      host,
      bearer,
      ...(diagnostics === "diagnostics"
        ? {
            onTransportEvent: (event: LaneUpstreamTransportEvent) => {
              process.stderr.write(`${JSON.stringify(event)}\n`);
            },
          }
        : {}),
    }),
});
