/** Offline Claude hook/transcript evidence. This module issues NO runtime authority. */
import { createHash } from "node:crypto";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const id = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
const tokenKeys = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];

/** Full supplied transcripts only; no truncating/evicting records into a false complete total. */
export function inspectNativeClaudeTranscript(bytes, { sessionId, agentId = null }) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length > 16 * 1024 * 1024 ||
    !id(sessionId) ||
    (agentId !== null && !id(agentId))
  )
    throw Error("Bounded transcript bytes and exact selected session/agent required");
  const issues = new Set(),
    messages = new Map(),
    uuids = new Map();
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.endsWith("\n")) issues.add("unterminated-transcript-record");
  for (const line of text.split("\n")) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      issues.add("malformed-transcript-record");
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      issues.add("malformed-transcript-record");
      continue;
    }
    // Count only assistant responses. Metadata and user/tool result text cannot add usage.
    if (entry.type !== "assistant") continue;
    if (
      entry.sessionId !== sessionId ||
      (agentId === null
        ? entry.isSidechain === true || entry.agentId != null
        : entry.agentId !== agentId || entry.isSidechain !== true)
    ) {
      issues.add("assistant-session-or-agent-mismatch");
      continue;
    }
    if (
      !id(entry.uuid) ||
      typeof entry.message?.id !== "string" ||
      !entry.message.id.length ||
      entry.message.id.length > 256
    ) {
      issues.add("assistant-identity-missing");
      continue;
    }
    const prior = uuids.get(entry.uuid),
      sha = digest(line);
    if (prior && prior !== sha) issues.add("conflicting-record-uuid");
    uuids.set(entry.uuid, sha);
    const usage = entry.message.usage;
    if (!usage || tokenKeys.some((key) => !Number.isSafeInteger(usage[key]) || usage[key] < 0)) {
      issues.add("assistant-usage-missing-or-invalid");
      continue;
    }
    const counts = tokenKeys.map((key) => usage[key]);
    const total = counts.reduce((a, b) => a + b, 0);
    if (!Number.isSafeInteger(total)) {
      issues.add("assistant-usage-overflow");
      continue;
    }
    const previous = messages.get(entry.message.id);
    // Streaming/content records may repeat one provider message. Do not sum them twice;
    // changed counters are ambiguous evidence, not permission to pick a convenient value.
    if (previous && JSON.stringify(previous) !== JSON.stringify(counts))
      issues.add("conflicting-message-usage");
    else messages.set(entry.message.id, counts);
  }
  if (!messages.size) issues.add("no-observed-assistant-usage");
  const total = [...messages.values()].flat().reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(total)) issues.add("transcript-usage-overflow");
  return {
    sessionId,
    agentId,
    sha256: digest(bytes),
    bytes: bytes.length,
    messageCount: messages.size,
    providerMessageIdsSha256: [...messages.keys()].map((messageId) => digest(messageId)),
    issues: [...issues],
    observedTokens: issues.size ? null : total,
    // Well-formed bytes are still model-writable observations, never provider authority.
    accountId: null,
    accountWideTokens: null,
    complete: false,
    authoritative: false,
  };
}

/** Lifecycle evidence cannot prove that an unseen child or request never existed. */
export class NativeClaudeObservation {
  #sessionId;
  #started = false;
  #active = false;
  #children = new Map();
  #issues = new Set();
  #events = [];
  #lastHash = "0".repeat(64);
  #encodedEventBytes = 0;
  #closed = false;
  #rootTranscript;
  constructor({ sessionId }) {
    if (!id(sessionId)) throw Error("Exact selected Claude root required");
    this.#sessionId = sessionId;
  }
  observe(event) {
    if (this.#closed) throw Error("Claude observation already sealed");
    const encoded = JSON.stringify(event);
    if (!encoded || Buffer.byteLength(encoded) > 65536 || this.#events.length >= 10000) {
      this.#issues.add("observation-capacity-exceeded");
      throw Error("Claude observation capacity exceeded");
    }
    const eventBytes = Buffer.byteLength(encoded);
    if (this.#encodedEventBytes + eventBytes > 1024 * 1024) {
      this.#issues.add("aggregate-observation-capacity-exceeded");
      throw Error("Claude aggregate observation capacity exceeded");
    }
    this.#encodedEventBytes += eventBytes;
    if (event?.session_id !== this.#sessionId) this.#issues.add("hook-session-mismatch");
    else
      switch (event.hook_event_name) {
        case "SessionStart":
          if (this.#started || event.source !== "startup")
            this.#issues.add("unexpected-root-restart-or-resume");
          this.#started = true;
          break;
        case "UserPromptSubmit":
          if (!this.#started) this.#issues.add("prompt-before-session-start");
          if (this.#active) this.#issues.add("overlapping-root-prompts");
          this.#active = true;
          break;
        case "SubagentStart":
          if (!this.#started || !this.#active) this.#issues.add("child-outside-observed-root-turn");
          if (!id(event.agent_id) || typeof event.agent_type !== "string" || !event.agent_type)
            this.#issues.add("child-identity-missing");
          else if (this.#children.has(event.agent_id)) this.#issues.add("duplicate-child-start");
          else
            this.#children.set(event.agent_id, {
              agentId: event.agent_id,
              agentType: event.agent_type,
              stopped: false,
              transcript: null,
            });
          break;
        case "SubagentStop": {
          const child = this.#children.get(event.agent_id);
          if (!child || child.agentType !== event.agent_type || child.stopped)
            this.#issues.add("unmatched-child-stop");
          else child.stopped = true;
          break;
        }
        case "Stop":
          if (!this.#active) this.#issues.add("unmatched-root-stop");
          this.#active = false;
          break;
        case "StopFailure":
          this.#issues.add("root-stop-failure");
          this.#active = false;
          break;
        case "SessionEnd":
          if (!this.#started || this.#active) this.#issues.add("session-end-without-settled-root");
          break;
        default:
          this.#issues.add("unsupported-lifecycle-event");
      }
    const record = {
      sequence: this.#events.length + 1,
      previous: this.#lastHash,
      event: structuredClone(event),
    };
    this.#lastHash = digest(JSON.stringify(record));
    this.#events.push({ ...record, sha256: this.#lastHash });
  }
  transcript(bytes, agentId = null) {
    if (this.#closed) throw Error("Claude observation already sealed");
    const result = inspectNativeClaudeTranscript(bytes, { sessionId: this.#sessionId, agentId });
    if (agentId === null) {
      if (this.#rootTranscript) this.#issues.add("duplicate-root-transcript");
      else this.#rootTranscript = result;
    } else {
      const child = this.#children.get(agentId);
      if (!child || child.transcript) this.#issues.add("unmatched-or-duplicate-child-transcript");
      else child.transcript = result;
    }
    return structuredClone(result);
  }
  /** Seal after collection; root Stop alone never settles outstanding children. */
  seal() {
    this.#closed = true;
    const issues = new Set(this.#issues);
    if (!this.#started) issues.add("missing-session-start");
    if (this.#active) issues.add("root-still-active");
    if (!this.#rootTranscript) issues.add("missing-root-transcript");
    for (const child of this.#children.values()) {
      if (!child.stopped) issues.add(`child-still-active:${child.agentId}`);
      if (!child.transcript) issues.add(`missing-child-transcript:${child.agentId}`);
    }
    const transcripts = [
      this.#rootTranscript,
      ...[...this.#children.values()].map((child) => child.transcript),
    ].filter(Boolean);
    for (const transcript of transcripts)
      for (const issue of transcript.issues) issues.add(`${transcript.agentId ?? "root"}:${issue}`);
    const providerMessages = new Set();
    for (const transcript of transcripts) {
      for (const messageHash of transcript.providerMessageIdsSha256) {
        if (providerMessages.has(messageHash)) issues.add("duplicate-provider-message-across-transcripts");
        providerMessages.add(messageHash);
      }
    }
    const observedTokens = transcripts.reduce(
      (total, transcript) => total + (transcript.observedTokens ?? 0),
      0,
    );
    if (!Number.isSafeInteger(observedTokens)) issues.add("aggregate-usage-overflow");
    return {
      source: "supplied-claude-hook-and-transcript-observations",
      sessionId: this.#sessionId,
      issues: [...issues],
      observedTokens: issues.size ? null : observedTokens,
      transcripts: structuredClone(transcripts),
      children: structuredClone([...this.#children.values()]),
      events: structuredClone(this.#events),
      lastHash: this.#lastHash,
      complete: false,
      authoritative: false,
      accountWideTokens: null,
      containmentStopConfirmed: false,
      limitation:
        "Supplied evidence is not process provenance, complete descendant inventory, provider accounting or a container stop receipt.",
    };
  }
}
