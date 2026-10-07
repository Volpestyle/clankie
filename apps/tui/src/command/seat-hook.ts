import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { readHerdrSeatTranscript } from "@clankie/agent-transcript";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  FleetSeatHookSchema,
  fleetSeatHookPath,
  OPERATOR_CONVERSATION_SUMMARY_MAX,
  OPERATOR_CONVERSATION_TEXT_MAX,
  type FleetSeatHook,
} from "@clankie/protocol";
import { commandHost } from "./io.ts";

const EVENTS = new Set<FleetSeatHook["event"]>(["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "PreToolUse", "PermissionRequest", "Notification", "PostToolUse", "SessionEnd"]);

/**
 * The worker plugin's lifecycle hook (VUH-1458): tell the service a hired
 * seat settled a turn, with the harness's own final text. Only a seat Clankie
 * hired into a herdr pane reports; anywhere else this is a no-op.
 */
export async function runSeatHookCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    operatorCredentialStore?: CredentialStore;
    stdin?: AsyncIterable<string | Buffer>;
    stdout?: { write(text: string): unknown };
  } = {},
): Promise<number> {
  if (args.length) throw new Error("Usage: clankie seat-hook (Claude hook JSON on stdin)");
  const env = options.env ?? process.env;
  const paneId = env.HERDR_PANE_ID?.trim();
  if (!paneId) return 0;
  let input = "";
  for await (const chunk of options.stdin ?? process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > 256 * 1024) throw new Error("Seat hook input exceeds 256 KiB");
  }
  const hook = JSON.parse(input) as {
    hook_event_name?: unknown;
    session_id?: unknown;
    transcript_path?: unknown;
    last_assistant_message?: unknown;
    error?: unknown;
    tool_name?: unknown; tool_use_id?: unknown; tool_input?: unknown; notification_type?: unknown;
  };
  const event = hook.hook_event_name as FleetSeatHook["event"];
  if (!EVENTS.has(event) || typeof hook.session_id !== "string") return 0;
  let lastMessage = typeof hook.last_assistant_message === "string" ? hook.last_assistant_message : undefined;
  if (lastMessage === undefined && (event === "Stop" || event === "StopFailure")) {
    // Older Claude Code omits the final text from the hook; the transcript has it.
    const path =
      typeof hook.transcript_path === "string" && isAbsolute(hook.transcript_path)
        ? hook.transcript_path
        : undefined;
    const entries =
      path === undefined
        ? []
        : (readHerdrSeatTranscript("claude", { source: "seat-hook", kind: "path", value: path })?.entries ??
          []);
    const last = entries.findLast((entry) => entry.type === "message" && entry.role === "agent");
    lastMessage = last?.type === "message" ? last.text : undefined;
  }
  const body = FleetSeatHookSchema.parse({
    schemaVersion: 1,
    event,
    sessionId: hook.session_id,
    ...(typeof hook.tool_name === "string" ? { toolName: hook.tool_name } : {}),
    ...(event === "PermissionRequest" ? { toolUseId: randomUUID() } : typeof hook.tool_use_id === "string" ? { toolUseId: hook.tool_use_id } : {}),
    ...(hook.tool_input && typeof hook.tool_input === "object" ? { toolInput: hook.tool_input } : {}),
    ...(typeof hook.notification_type === "string" ? { notificationType: hook.notification_type } : {}),
    ...(lastMessage === undefined || lastMessage.trim() === ""
      ? {}
      : { lastMessage: lastMessage.slice(0, OPERATOR_CONVERSATION_TEXT_MAX) }),
    ...(event === "StopFailure"
      ? {
          error: (typeof hook.error === "string" ? hook.error : "error").slice(
            0,
            OPERATOR_CONVERSATION_SUMMARY_MAX,
          ),
        }
      : {}),
  });
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
  });
  if (!credential) throw new Error("Seat hook needs the operator credential");
  const response = await (options.fetchImpl ?? fetch)(
    new URL(fleetSeatHookPath(paneId), commandHost({ ...options, env })),
    {
      method: "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(event === "PermissionRequest" || event === "PreToolUse" ? 570_000 : 10_000),
    },
  );
  // An unknown seat is a pane Clankie is not driving; nothing to report.
  if (response.status === 404) return 0;
  if (!response.ok) throw new Error(`Seat hook was refused (${response.status})`);
  if (event === "PermissionRequest" || event === "PreToolUse") {
    const result = (await response.json()) as { hookOutput?: unknown };
    if (result.hookOutput) (options.stdout ?? process.stdout).write(JSON.stringify(result.hookOutput) + "\n");
  }
  if (event === "UserPromptSubmit") {
    const result = (await response.json()) as { additionalContext?: unknown };
    if (typeof result.additionalContext === "string" && result.additionalContext)
      (options.stdout ?? process.stdout).write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: result.additionalContext,
          },
        }) + "\n",
      );
  }
  return 0;
}
