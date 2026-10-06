import { runMcpCommand } from "../../../tui/src/command/mcp.ts";

const [host] = process.argv.slice(2);
if (!host) throw new Error("Owned seat-pump fixture requires its HTTP host");
// A real stdio bridge and credential override against an owned HTTP service.
// The SDK client is a transport test peer; this does not claim Claude delivery.
process.exitCode = await runMcpCommand(["--lane", "operator", "--conversation", "global-default"], {
  host,
  pollWaitMs: 50,
  pollRetryMs: 5,
  readParentArgv: async () => "claude --dangerously-load-development-channels plugin:clankie@inline",
});
