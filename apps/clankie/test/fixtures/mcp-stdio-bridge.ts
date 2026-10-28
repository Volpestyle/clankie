import { readFileSync } from "node:fs";
import {
  connectLaneUpstream,
  runMcpCommand,
  type LaneUpstreamTransportEvent,
} from "../../../tui/src/command/mcp.ts";

const [host, bearer, channel, diagnostics, bindingPath] = process.argv.slice(2);
if (!host || !bearer) throw new Error("MCP integration fixture requires a host and bearer");
const binding = bindingPath
  ? (JSON.parse(readFileSync(bindingPath, "utf8")) as { conversationId: string; bridgeClaim: string })
  : undefined;
process.exitCode = await runMcpCommand(
  ["--lane", "operator", ...(binding ? ["--conversation", binding.conversationId] : [])],
  {
    readParentArgv: async () =>
      channel === "channel" ? "claude --dangerously-load-development-channels server:clankie" : undefined,
    connectUpstream: async () =>
      connectLaneUpstream({
        host,
        bearer,
        ...binding,
        ...(diagnostics === "diagnostics"
          ? {
              onTransportEvent: (event: LaneUpstreamTransportEvent) => {
                process.stderr.write(`${JSON.stringify(event)}\n`);
              },
            }
          : {}),
      }),
  },
);
