import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import {
  readHerdrSeatTranscriptSince,
  SeatTranscriptUploadSchema,
  type SeatTranscriptUpload,
} from "@clankie/agent-transcript";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";

/** Plugin hook: read on the native host, send redacted display records only. */
const POST_TOOL_SYNC_INTERVAL_MS = 2_000;

export async function runSeatSyncCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    operatorCredentialStore?: CredentialStore;
    stdin?: AsyncIterable<string | Buffer>;
    /** Waits before each retry of a failed upload; a retired seat is never retried. */
    retryDelaysMs?: readonly number[];
    /** One caller budget across pages and retries. */
    signal?: AbortSignal;
    /** Remote hooks retain only IDs the service has acknowledged, never transcript text. */
    checkpointPath?: string;
    /** Where the acknowledged native fold is kept between hooks (ids and offsets, never text). */
    transcriptCheckpointPath?: string;
  } = {},
): Promise<number> {
  if (args.length) throw new Error("Usage: clankie seat-sync (native seat hook JSON on stdin)");
  const env = options.env ?? process.env;
  const sessionId = env.CLANKIE_SEAT_SESSION_ID;
  const harness = env.CLANKIE_SEAT_HARNESS === "codex" ? "codex" : "claude";
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
    ![
      "SessionStart",
      "UserPromptSubmit",
      "PostToolUse",
      "Stop",
      "StopFailure",
      "SessionEnd",
      "PreCompact",
      "Interrupt",
    ].includes(String(hook.hook_event_name))
  )
    throw new Error("Unsupported seat transcript hook");
  // Mid-turn progress (VUH-1564): at most one upload per burst of tool calls.
  // Stop and the next prompt still carry anything a skipped call left behind.
  if (hook.hook_event_name === "PostToolUse") {
    const marker = join(tmpdir(), `clankie-seat-sync-${sessionId}`);
    try {
      if (Date.now() - statSync(marker).mtimeMs < POST_TOOL_SYNC_INTERVAL_MS) return 0;
    } catch {
      /* first progress sync of this session */
    }
    writeFileSync(marker, "");
  }
  if (
    typeof hook.transcript_path !== "string" ||
    !isAbsolute(hook.transcript_path) ||
    !(harness === "codex"
      ? basename(hook.transcript_path).startsWith("rollout-") &&
        basename(hook.transcript_path).endsWith(`-${sessionId}.jsonl`)
      : basename(hook.transcript_path) === `${sessionId}.jsonl`)
  )
    throw new Error("Seat transcript does not match the launched session");
  const url = new URL("/v1/seat/transcript", commandHost({ ...options, env }));
  if (env.CLANKIE_CONVERSATION_ID) url.searchParams.set("conversationId", env.CLANKIE_CONVERSATION_ID);
  // Each hook continues from the fold the service last acknowledged (VUH-2391),
  // so it reads and sends what the session appended since, not the whole
  // session. A start or resume replays the retained window once.
  const foldPath =
    options.transcriptCheckpointPath ?? join(tmpdir(), `clankie-seat-transcript-${sessionId}.json`);
  const saved = hook.hook_event_name === "SessionStart" ? undefined : readFold(foldPath, sessionId, url.href);
  const transcript = readHerdrSeatTranscriptSince(
    harness,
    { source: "native-seat", kind: "path", value: hook.transcript_path },
    saved,
  );
  const saveFold = () => {
    if (transcript)
      writePrivate(foldPath, { sessionId, target: url.href, transcript: transcript.checkpoint });
  };
  const activity: SeatTranscriptUpload["activity"] =
    hook.hook_event_name === "PreCompact"
      ? undefined
      : hook.hook_event_name === "UserPromptSubmit" || hook.hook_event_name === "PostToolUse"
        ? "responding"
        : "waiting";
  if (!transcript?.entries.length && activity === undefined) {
    saveFold();
    return 0;
  }
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
  });
  if (!credential) throw new Error("Seat transcript needs the operator credential");
  // One upload budget for the whole transcript, not ten seconds per page.
  const budget = () =>
    options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000);
  let signal = budget();
  const acknowledged = new Set<string>();
  if (options.checkpointPath) {
    try {
      const checkpoint: unknown = JSON.parse(readFileSync(options.checkpointPath, "utf8"));
      if (
        typeof checkpoint === "object" &&
        checkpoint !== null &&
        "sessionId" in checkpoint &&
        checkpoint.sessionId === sessionId &&
        "target" in checkpoint &&
        checkpoint.target === url.href &&
        "entries" in checkpoint &&
        Array.isArray(checkpoint.entries) &&
        checkpoint.entries.every((id: unknown) => typeof id === "string")
      )
        for (const id of checkpoint.entries) acknowledged.add(id);
    } catch {
      /* Missing or invalid checkpoints replay safely. */
    }
  }
  const send = async (entries: SeatTranscriptUpload["entries"], final = false) => {
    signal.throwIfAborted();
    const body = SeatTranscriptUploadSchema.parse({
      sessionId,
      entries,
      ...(final && activity !== undefined ? { activity } : {}),
    });
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    // Release the response connection before uploading another page.
    await response.body?.cancel();
    if (response.status === 409)
      throw new SeatSessionRetiredError(
        "Seat session is bound elsewhere or retired by reset; launch a new seat for this conversation",
      );
    // A service older than the interrupt entry (VUH-2680) refuses the whole
    // page. Resend it without them; that service could never show them.
    if (response.status === 400 && entries.some((entry) => entry.type === "interrupted")) {
      await send(
        entries.filter((entry) => entry.type !== "interrupted"),
        final,
      );
      if (options.checkpointPath) {
        for (const entry of entries) acknowledged.add(entry.id);
        writePrivate(options.checkpointPath, {
          sessionId,
          target: url.href,
          entries: [...acknowledged].slice(-RETAINED_ENTRIES),
        });
      }
      return;
    }
    if (!response.ok)
      throw new Error(
        `Seat transcript sync failed (${response.status}); the next hook retries retained records`,
      );
    if (options.checkpointPath) {
      for (const entry of entries) acknowledged.add(entry.id);
      // Keep the checkpoint bounded to the native reader's retained window, newest last.
      writePrivate(options.checkpointPath, {
        sessionId,
        target: url.href,
        entries: [...acknowledged].slice(-RETAINED_ENTRIES),
      });
    }
  };
  const upload = async () => {
    let page: SeatTranscriptUpload["entries"] = [],
      bytes = 0;
    for (const entry of transcript?.entries ?? []) {
      // A remote service must never resolve an image path from another host.
      if (entry.type === "viewed_image") continue;
      // Channel envelopes are native delivery metadata, not operator chat.
      // Keep the display-only upload compatible with the service's strict schema.
      if (entry.type === "message" && entry.internal) continue;
      if (acknowledged.has(entry.id)) continue;
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
  };
  // Acknowledged pages need no replay; failed pages stay in the native transcript.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await upload();
      saveFold();
      return 0;
    } catch (error) {
      const wait = options.retryDelaysMs?.[attempt];
      if (wait === undefined || error instanceof SeatSessionRetiredError) throw error;
      await delay(wait, undefined, options.signal ? { signal: options.signal } : undefined);
      signal = budget();
    }
  }
}

export class SeatSessionRetiredError extends Error {}

/** The native reader's retained window (agent-transcript MAX_ENTRIES). */
const RETAINED_ENTRIES = 9_000;
/** A fold checkpoint past this is not one this command wrote. */
const FOLD_CHECKPOINT_MAX_BYTES = 64 * 1024 * 1024;

function readFold(path: string, sessionId: string, target: string): unknown {
  try {
    if (statSync(path).size > FOLD_CHECKPOINT_MAX_BYTES) return undefined;
    const saved: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof saved === "object" &&
      saved !== null &&
      "sessionId" in saved &&
      saved.sessionId === sessionId &&
      "target" in saved &&
      saved.target === target &&
      "transcript" in saved
      ? saved.transcript
      : undefined;
  } catch {
    /* Missing or invalid checkpoints replay the window safely. */
    return undefined;
  }
}

/** Atomic owner-only replace; a failed write only causes an idempotent replay. */
function writePrivate(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    renameSync(temporary, path);
  } catch {
    /* A failed checkpoint only causes an idempotent replay. */
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}
