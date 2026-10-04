// Worker projection only. It never requests operator credentials or context.
export default async function ClankieNativeWorker() {
  return {
    config: async (config) => {
      config.mcp ??= {};
      for (const [name, server] of Object.entries(config.mcp)) {
        let tracker = /linear/iu.test(name);
        try {
          const host = new URL(server.url).hostname;
          tracker ||= host === "linear.app" || host.endsWith(".linear.app");
        } catch {
          /* Local MCP command. */
        }
        const command = Array.isArray(server.command) ? server.command.join(" ") : "";
        tracker ||= /\blinear-mcp\b|@linear\//iu.test(command);
        if (tracker) config.mcp[name] = { enabled: false };
      }
      config.mcp.clankie = { type: "local", command: ["clankie", "mcp", "--fleet"], enabled: true };
    },
  };
}
