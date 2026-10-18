import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCodingTools,
  createReadOnlyTools,
  createPowerShellTool,
} from "@earendil-works/pi-coding-agent";
import type { SettingsStore } from "@clankie/settings";
import { requireMachineAccess } from "../machine-access.ts";
import { agentEnvironment, agentIdentity, asAgent, type AgentIdentity } from "../agent-identity.ts";
import type { AgentToolContext, AgentToolReply, AgentToolRequest } from "./agent-tool-host.ts";

/** Override every native coding tool, including tools a session can activate later. */
export function machineCodingTools(
  cwd: string,
  settings: SettingsStore,
  options?: Parameters<typeof createCodingTools>[1],
  identity: AgentIdentity | undefined = agentIdentity(),
) {
  const coding = createCodingTools(cwd, options);
  const tools = [
    ...coding,
    ...createReadOnlyTools(cwd, options).filter((tool) => tool.name !== "read"),
    createPowerShellTool(cwd),
  ];
  const host = identity === undefined ? undefined : agentToolHost(identity);
  return tools.map((tool) => ({
    ...tool,
    // Let the SDK retain its configured/default active loadout.
    defaultActive: false,
    execute: async (...args: Parameters<typeof tool.execute>) => {
      await requireMachineAccess(settings, "local", "shell");
      // A separated body runs every native tool as its agent uid (VUH-2320).
      return host === undefined
        ? tool.execute(...args)
        : (host.execute(cwd, tool.name, ...(args as unknown as HostCall)) as ReturnType<typeof tool.execute>);
    },
  }));
}

type HostCall = [
  toolCallId: string,
  params: unknown,
  signal?: AbortSignal,
  onUpdate?: (update: unknown) => void,
  context?: {
    cwd?: string;
    model?: unknown;
    thinkingLevel?: string;
    sessionManager?: { getSessionId?: () => string; getSessionFile?: () => string | undefined };
  },
];

const hosts = new Map<number, ReturnType<typeof createAgentToolHost>>();
function agentToolHost(identity: AgentIdentity) {
  let host = hosts.get(identity.uid);
  if (host === undefined) hosts.set(identity.uid, (host = createAgentToolHost(identity)));
  return host;
}

function hostScript(): string {
  const here = fileURLToPath(import.meta.url);
  const root = here.slice(0, here.lastIndexOf("/apps/clankie/src/"));
  const compiled = join(root, "apps/clankie/src/captain/agent-tool-host.js");
  return existsSync(compiled) ? compiled : compiled.replace(/\.js$/u, ".ts");
}

/** One long-lived agent process; it restarts on the next call after any exit. */
function createAgentToolHost(identity: AgentIdentity) {
  let child: ChildProcess | undefined;
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; onUpdate?: (update: unknown) => void }
  >();
  const start = (): ChildProcess => {
    const { command, args } = asAgent(identity, process.execPath, [hostScript(), "--agent-tool-host"]);
    const started = spawn(command, args, {
      cwd: identity.home,
      env: agentEnvironment(identity, process.env),
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    started.on("message", (reply: AgentToolReply) => {
      const call = pending.get(reply.id);
      if (call === undefined) return;
      if (reply.type === "update") return call.onUpdate?.(reply.update);
      pending.delete(reply.id);
      if (reply.type === "result") call.resolve(reply.result);
      else call.reject(new Error(reply.message));
    });
    const fail = (error: Error) => {
      if (child === started) child = undefined;
      for (const [id, call] of pending) {
        pending.delete(id);
        call.reject(error);
      }
    };
    started.once("error", (error) => fail(new Error(`Agent tool host unavailable: ${error.message}`)));
    started.once("exit", () => fail(new Error("Agent tool host exited")));
    started.unref();
    started.channel?.unref();
    return started;
  };
  return {
    execute(cwd: string, tool: string, ...[toolCallId, params, signal, onUpdate, context]: HostCall): Promise<unknown> {
      signal?.throwIfAborted();
      const process = (child ??= start());
      const id = randomUUID();
      const forwarded: AgentToolContext = {
        ...(context?.cwd === undefined ? {} : { cwd: context.cwd }),
        ...(context?.model === undefined ? {} : { model: JSON.parse(JSON.stringify(context.model)) }),
        ...(context?.thinkingLevel === undefined ? {} : { thinkingLevel: context.thinkingLevel }),
        ...(context?.sessionManager?.getSessionId === undefined
          ? {}
          : { sessionId: context.sessionManager.getSessionId() }),
        ...(context?.sessionManager?.getSessionFile?.() === undefined
          ? {}
          : { sessionFile: context.sessionManager.getSessionFile!() }),
      };
      return new Promise((resolve, reject) => {
        const abort = () => process.send({ id, type: "abort" } satisfies AgentToolRequest);
        signal?.addEventListener("abort", abort, { once: true });
        const settle = () => signal?.removeEventListener("abort", abort);
        pending.set(id, {
          resolve: (value) => (settle(), resolve(value)),
          reject: (error) => (settle(), reject(error)),
          ...(onUpdate === undefined ? {} : { onUpdate }),
        });
        process.send(
          { id, type: "execute", cwd, tool, toolCallId, params, context: forwarded } satisfies AgentToolRequest,
          (error) => {
            if (error === null) return;
            pending.delete(id);
            settle();
            reject(new Error(`Agent tool host unavailable: ${error.message}`));
          },
        );
      });
    },
  };
}
