import { basename, isAbsolute } from "node:path";
import {
  readHerdrSeatTranscript,
  SeatTranscriptUploadSchema,
  type SeatTranscriptUpload,
} from "@clankie/agent-transcript";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";

/** Plugin hook: read on the native host, send redacted display records only. */
export async function runSeatSyncCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    operatorCredentialStore?: CredentialStore;
    stdin?: AsyncIterable<string | Buffer>;
  } = {},
): Promise<number> {
  if (args.length) throw new Error("Usage: clankie seat-sync (Claude hook JSON on stdin)");
  const env = options.env ?? process.env;
  const sessionId = env.CLANKIE_SEAT_SESSION_ID;
  // Ordinary plugin use and child agents do not inherit a conversation claim.
  if (!sessionId) return 0;
  let input = "";
  for await (const chunk of options.stdin ?? process.stdin) {
    input += chunk.toString();
    if (Buffer.byteLength(input) > 65536) throw new Error("Seat hook input exceeds 64 KiB");
  }
  const hook = JSON.parse(input) as {
    session_id?: unknown;
    transcript_path?: unknown;
    hook_event_name?: unknown;
  };
  if (hook.session_id !== sessionId) return 0;
  if (
    !["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "SessionEnd", "PreCompact"].includes(
      String(hook.hook_event_name),
    )
  )
    throw new Error("Unsupported seat transcript hook");
  if (
    typeof hook.transcript_path !== "string" ||
    !isAbsolute(hook.transcript_path) ||
    basename(hook.transcript_path) !== `${sessionId}.jsonl`
  )
    throw new Error("Seat transcript does not match the launched session");
  const transcript = readHerdrSeatTranscript("claude", {
    source: "native-seat",
    kind: "path",
    value: hook.transcript_path,
  });
  const activity: SeatTranscriptUpload["activity"] =
    hook.hook_event_name === "PreCompact"
      ? undefined
      : hook.hook_event_name === "UserPromptSubmit"
        ? "responding"
        : "waiting";
  if (!transcript?.entries.length && activity === undefined) return 0;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
  });
  if (!credential) throw new Error("Seat transcript needs the operator credential");
  const url = new URL("/v1/seat/transcript", commandHost({ ...options, env }));
  if (env.CLANKIE_CONVERSATION_ID) url.searchParams.set("conversationId", env.CLANKIE_CONVERSATION_ID);
  const send = async (entries: SeatTranscriptUpload["entries"], final = false) => {
    const body = SeatTranscriptUploadSchema.parse({
      sessionId,
      entries,
      ...(final && activity !== undefined ? { activity } : {}),
    });
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 409)
      throw new Error(
        "Seat session is bound elsewhere or retired by reset; launch a new seat for this conversation",
      );
    if (!response.ok)
      throw new Error(
        `Seat transcript sync failed (${response.status}); the next hook retries retained records`,
      );
  };
  let page: SeatTranscriptUpload["entries"] = [],
    bytes = 0;
  for (const entry of transcript?.entries ?? []) {
    // A remote service must never resolve an image path from another host.
    if (entry.type === "viewed_image") continue;
    const size = Buffer.byteLength(JSON.stringify(entry));
    if (page.length && (page.length === 100 || bytes + size > 512 * 1024)) {
      await send(page);
      page = [];
      bytes = 0;
    }
    page.push(entry);
    bytes += size;
  }
  if (page.length || activity !== undefined) await send(page, true);
  return 0;
}
