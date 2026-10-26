import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { parseHerdrSeatTranscript, inspectHerdrSeatTranscriptPathAsync } from "@clankie/agent-transcript";
import { readSeatTelemetry } from "./seat-telemetry.ts";
import { occupantIdForHerdrSession } from "./herdr-census.ts";
import { nativeSessionId } from "./native-session-resume.ts";
import type { RestartCandidate } from "./hired-seat-restarts.ts";
import { RestartRefusal } from "./hired-seat-restarts.ts";
import { splitFleetQualified } from "../herdr-fleet.ts";

/** Native user prompts and channel deliveries have different attribution in both harnesses. */
export async function readHiredRestartObservation(candidate: RestartCandidate) {
  const agent = candidate.agent;
  if (splitFleetQualified(agent.paneId)) throw new RestartRefusal("remote_restart_unavailable");
  if (!agent.session || !["claude", "codex"].includes(agent.agent))
    throw new RestartRefusal("source_unproven");
  const lookup = await inspectHerdrSeatTranscriptPathAsync(agent.agent, agent.session);
  if (!lookup.path) throw new RestartRefusal("usage_unreadable", JSON.stringify(lookup));
  const file = await open(lookup.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > 128 * 1024 * 1024)
      throw new RestartRefusal("transcript_inventory_unreadable");
    const source = await file.readFile("utf8");
    const records = source
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const id = nativeSessionId(agent);
    if (
      !id ||
      !records.some(
        (row) =>
          row.sessionId === id ||
          (row.type === "session_meta" && (row.payload as Record<string, unknown> | undefined)?.id === id),
      )
    )
      throw new RestartRefusal("transcript_identity_unknown");
    const times = records.map((row) => Date.parse(String(row.timestamp ?? ""))).filter(Number.isFinite);
    if (!times.length) throw new RestartRefusal("owner_quiet_unknown");
    let lastOwnerInputAt = times.reduce((earliest, at) => Math.min(earliest, at), Infinity);
    for (const entry of parseHerdrSeatTranscript(agent.agent, source, true)) {
      if (entry.type !== "message" || entry.role !== "operator" || entry.internal) continue;
      const at = Date.parse(entry.occurredAt ?? "");
      if (!Number.isFinite(at)) throw new RestartRefusal("owner_quiet_unknown");
      lastOwnerInputAt = Math.max(lastOwnerInputAt, at);
    }
    // Display parsers may hide channel-looking text. Only native metadata can
    // exclude an actual input from owner quiet, never the words somebody typed.
    const object = (value: unknown): Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const inputAt = (value: unknown) => {
      const at = Date.parse(typeof value === "string" ? value : "");
      if (!Number.isFinite(at)) throw new RestartRefusal("owner_quiet_unknown");
      lastOwnerInputAt = Math.max(lastOwnerInputAt, at);
    };
    for (const row of records) {
      if (row.isSidechain === true) continue;
      if (agent.agent === "claude") {
        const message = object(row.message);
        const content = message.content;
        const hasText =
          typeof content === "string" ||
          (Array.isArray(content) && content.some((item) => object(item).type === "text"));
        if (row.type === "user" && hasText && row.isMeta !== true && row.promptSource !== "system")
          inputAt(row.timestamp);
        const queued = object(row.attachment);
        if (row.type === "attachment" && queued.type === "queued_command") {
          const origin = object(queued.origin).kind;
          if (origin !== "channel" || queued.isMeta !== true) inputAt(queued.timestamp ?? row.timestamp);
        }
      } else {
        const payload = object(row.payload);
        if (row.type === "event_msg" && payload.type === "user_message") inputAt(row.timestamp);
        if (row.type === "response_item" && payload.type === "message" && payload.role === "user") {
          const metadata = object(payload.internal_chat_message_metadata_passthrough);
          const kinds = metadata.content_item_kinds;
          if (!Array.isArray(kinds) || kinds.includes("user.text"))
            inputAt(row.timestamp ?? metadata.create_time);
        }
      }
    }
    const telemetry = await readSeatTelemetry(
      {
        seatId: agent.terminalId,
        paneId: agent.paneId,
        subject: candidate.name ?? "",
        title: agent.title,
        occupantId: occupantIdForHerdrSession(agent.session),
        harness: agent.agent,
        status: agent.status,
        session: agent.session,
        workingDirectory: candidate.workingDirectory,
      },
      { transcriptPath: lookup.path },
    );
    const after = await file.stat();
    const current = await lstat(lookup.path);
    if (
      !current.isFile() ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.mtimeMs !== before.mtimeMs ||
      current.size !== before.size ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.size !== after.size
    )
      throw new RestartRefusal("transcript_changed_during_read");
    return { contextTokens: telemetry?.contextTokens, lastOwnerInputAt, detail: JSON.stringify(lookup) };
  } finally {
    await file.close();
  }
}
