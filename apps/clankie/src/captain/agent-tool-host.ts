/**
 * Runs the captain's native coding tools as the hosted agent uid (VUH-2320).
 * The service starts this through setpriv and proxies each tool call over IPC,
 * so read, write, edit, find, grep, ls, bash and powershell all touch the
 * machine with the agent's permissions, never the service's.
 */
import {
  createCodingTools,
  createPowerShellTool,
  createReadOnlyTools,
} from "@earendil-works/pi-coding-agent";

type HostedTool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
/** The same native loadout `machineCodingTools` exposes, built here as the agent. */
const nativeTools = (cwd: string): Map<string, HostedTool> =>
  new Map(
    [...createCodingTools(cwd), ...createReadOnlyTools(cwd), createPowerShellTool(cwd)].map((tool) => [
      tool.name,
      tool as unknown as HostedTool,
    ]),
  );

export type AgentToolRequest =
  | {
      readonly id: string;
      readonly type: "execute";
      readonly cwd: string;
      readonly tool: string;
      readonly toolCallId: string;
      readonly params: unknown;
      readonly context: AgentToolContext;
    }
  | { readonly id: string; readonly type: "abort" };

/** The serializable part of a tool context that the native tools read. */
export interface AgentToolContext {
  readonly cwd?: string;
  readonly model?: unknown;
  readonly thinkingLevel?: string;
  readonly sessionId?: string;
  readonly sessionFile?: string;
}

export type AgentToolReply =
  | { readonly id: string; readonly type: "update"; readonly update: unknown }
  | { readonly id: string; readonly type: "result"; readonly result: unknown }
  | { readonly id: string; readonly type: "error"; readonly message: string };

if (process.argv.includes("--agent-tool-host")) {
  const toolsByCwd = new Map<string, Map<string, HostedTool>>();
  const running = new Map<string, AbortController>();
  const send = (reply: AgentToolReply) => {
    if (process.connected) process.send?.(reply);
  };
  process.on("message", (message: AgentToolRequest) => {
    if (message.type === "abort") {
      running.get(message.id)?.abort();
      return;
    }
    const controller = new AbortController();
    running.set(message.id, controller);
    void (async () => {
      try {
        let tools = toolsByCwd.get(message.cwd);
        if (tools === undefined) {
          tools = nativeTools(message.cwd);
          toolsByCwd.set(message.cwd, tools);
        }
        const tool = tools.get(message.tool);
        if (tool === undefined) throw new Error(`Unknown tool ${message.tool}`);
        const { sessionId, sessionFile, ...context } = message.context;
        const result = await tool.execute(
          message.toolCallId,
          message.params,
          controller.signal,
          (update: unknown) => send({ id: message.id, type: "update", update }),
          {
            ...context,
            sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile },
          },
        );
        send({ id: message.id, type: "result", result });
      } catch (error) {
        send({ id: message.id, type: "error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        running.delete(message.id);
      }
    })();
  });
  // The service owns this process's lifetime.
  process.once("disconnect", () => process.exit(0));
}
