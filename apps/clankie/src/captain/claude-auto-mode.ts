import { spawn } from "node:child_process";

/**
 * Whether Claude Code would run a hire in auto mode, answered by the installed
 * harness itself (issue #341). Claude decides per model, provider, settings and
 * a server switch, and silently falls back to per-command approval when it
 * refuses; a hired worker then stalls at its first command. Claude's control
 * protocol answers `set_permission_mode` with the same gate before any prompt
 * is sent, so the probe costs no model call.
 */
export type ClaudeAutoModeVerdict =
  | { readonly available: true }
  | { readonly available: false; readonly code: string; readonly reason: string }
  /** Claude could not answer (missing, slow, older protocol): no claim either way. */
  | { readonly available: undefined; readonly detail: string };

export interface ClaudeAutoModeProbeInput {
  readonly cwd: string;
  readonly model?: string;
  readonly env?: Readonly<Record<string, string>>;
}

const PROBE_MS = 20_000;
const RETRY_MS = 250;

/** A probe that never touches the seat: no hooks, MCP servers, session file or pane identity. */
export async function probeClaudeAutoMode(
  input: ClaudeAutoModeProbeInput,
  options: { readonly executable?: string; readonly timeoutMs?: number } = {},
): Promise<ClaudeAutoModeVerdict> {
  // The worker plugin's hooks and bridge would claim the service's own pane.
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...input.env }).filter(
      ([key, value]) => value !== undefined && !/^(?:HERDR_|CLANKIE_|HC_TERMINAL_ID$|CLAUDECODE$)/u.test(key),
    ),
  ) as NodeJS.ProcessEnv;
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--settings",
    JSON.stringify({ disableAllHooks: true }),
    ...(input.model === undefined ? [] : ["--model", input.model]),
  ];
  return await new Promise<ClaudeAutoModeVerdict>((resolve) => {
    let settled = false;
    let attempts = 0;
    let buffer = "";
    const child = spawn(options.executable ?? "claude", args, {
      cwd: input.cwd,
      env,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const finish = (verdict: ClaudeAutoModeVerdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill();
      resolve(verdict);
    };
    const timer = setTimeout(
      () => finish({ available: undefined, detail: "Claude did not answer the auto mode check in time" }),
      options.timeoutMs ?? PROBE_MS,
    );
    const send = (id: string, request: Record<string, unknown>) =>
      child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: id, request })}\n`);
    const askMode = () => send(`mode-${attempts}`, { subtype: "set_permission_mode", mode: "auto" });
    child.on("error", (error) => finish({ available: undefined, detail: error.message }));
    child.on("exit", (code) =>
      finish({ available: undefined, detail: `Claude exited (${String(code)}) before answering` }),
    );
    child.stdin.on("error", () => {
      /* An exiting child closes its stdin; exit settles the verdict. */
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let message: { type?: unknown; response?: Record<string, unknown> };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const response = message.response;
        if (message.type !== "control_response" || response === undefined) continue;
        const id = response.request_id;
        if (id === "initialize") {
          if (response.subtype !== "success")
            return finish({ available: undefined, detail: String(response.error ?? "initialize refused") });
          askMode();
          continue;
        }
        if (typeof id !== "string" || !id.startsWith("mode-")) continue;
        if (response.subtype === "success") return finish({ available: true });
        const reason = String(response.error ?? "auto mode refused");
        const code = typeof response.error_code === "string" ? response.error_code : undefined;
        // Claude's gate reads a remote switch at startup; until then it says ask again.
        if ((code === "auto_mode_unavailable" || code === undefined) && /not known yet/u.test(reason)) {
          attempts++;
          setTimeout(askMode, RETRY_MS);
          continue;
        }
        // Only a gate refusal is a verdict; any other error is an older or different protocol.
        if (code?.startsWith("auto_mode_")) return finish({ available: false, code, reason });
        return finish({ available: undefined, detail: reason });
      }
    });
    send("initialize", { subtype: "initialize" });
  });
}
