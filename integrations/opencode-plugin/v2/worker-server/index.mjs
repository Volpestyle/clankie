// OpenCode 2 server part for a hired worker. It runs in the TUI's private
// server and only projects the worker's MCP: `clankie mcp --fleet` without an
// operator token, and no inherited personal tracker. It never writes the
// owner's configuration.
import { projectWorkerMcp } from "../worker-runtime.mjs";

export default {
  id: "clankie.native-worker-server",
  async setup(ctx) {
    await ctx.mcp.transform(projectWorkerMcp);
  },
};
