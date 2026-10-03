// Verify only the injected native client and the exact known session. Context
// preflight is read-only; it neither creates a session nor starts a model turn.
export async function loadNativeContext(client, sessionId, bridge, signal) {
  if (typeof sessionId !== "string" || !/^ses_[A-Za-z0-9]{8,128}$/u.test(sessionId))
    throw new Error("Invalid native session identity");
  const session = await client.session.get({ path: { id: sessionId }, throwOnError: true, signal });
  if (session.data?.id !== sessionId) throw new Error("Native session identity mismatch");
  await bridge("bind", { sessionId });
  const context = await bridge("context", { sessionId });
  if (typeof context.text !== "string" || !context.text.trim())
    throw new Error("Clankie operator context unavailable");
  return context.text;
}

// Native server API only. The injected client belongs to this TUI's server;
// never discover a port or replace it with `opencode serve`.
export async function deliverNativeEvent(client, sessionId, event, bridge, signal) {
  const status = await client.session.status({ throwOnError: true, signal });
  if (status.data?.[sessionId]?.type && status.data[sessionId].type !== "idle")
    return { status: "busy", detail: "Waiting for the bound session to become idle; no steering." };
  const session = await client.session.get({ path: { id: sessionId }, throwOnError: true, signal });
  if (session.data?.id !== sessionId) throw new Error("Native session identity mismatch");
  // This per-launch journal claim precedes dispatch. A lost response stops
  // this launcher from resending; journals are not a cross-launch dedupe fence.
  await bridge("claim", { sessionId, eventId: event.id });
  try {
    await client.session.promptAsync({
      path: { id: sessionId },
      body: {
        parts: [
          {
            type: "text",
            text: `<clankie-seat-event>\n${JSON.stringify(event)}\n</clankie-seat-event>`,
            synthetic: true,
          },
        ],
      },
      throwOnError: true,
      signal,
    });
  } catch (error) {
    await bridge("receipt", { sessionId, eventId: event.id, status: "uncertain" }).catch(() => {});
    throw new Error(
      `uncertain_delivery: ${String(error)}; reconcile the native transcript before any manual retry`,
    );
  }
  await bridge("receipt", { sessionId, eventId: event.id, status: "delivered" });
  return { status: "delivered", detail: "Accepted by the bound session API; completion is separate." };
}

export function projectMessages(sessionId, messages) {
  const entries = [];
  for (const { info, parts } of messages) {
    if (info.sessionID !== sessionId || !["user", "assistant"].includes(info.role)) continue;
    for (const part of parts) {
      if (part.sessionID !== sessionId || part.messageID !== info.id) continue;
      const occurredAt =
        typeof info.time?.created === "number" ? new Date(info.time.created).toISOString() : undefined;
      if (
        part.type === "text" &&
        !part.synthetic &&
        typeof part.text === "string" &&
        (info.role === "user" || typeof info.time?.completed === "number")
      ) {
        // The service deduplicates display IDs, so publish assistant text only
        // after completion. Chunk complete text instead of freezing a partial
        // streaming snapshot or silently discarding its tail.
        for (let offset = 0; offset < part.text.length; offset += 16384) {
          entries.push({
            type: "message",
            id: `${part.id}:${offset}`,
            role: info.role === "user" ? "operator" : "agent",
            text: part.text.slice(offset, offset + 16384),
            ...(occurredAt ? { occurredAt } : {}),
          });
        }
      } else if (part.type === "tool" && info.role === "assistant" && part.state) {
        const status = part.state.status;
        if (!["running", "completed", "error"].includes(status)) continue;
        entries.push({
          type: "tool",
          id: `${part.id}:${status}`,
          toolCallId: part.callID,
          name: part.tool,
          phase: status === "error" ? "failed" : status === "completed" ? "completed" : "started",
          detail: String(part.state.output ?? part.state.error ?? "").slice(0, 16384),
          ...(occurredAt ? { occurredAt } : {}),
        });
      }
    }
  }
  return entries;
}
