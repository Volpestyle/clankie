/** Routing notices are transport progress, never another native answer or model turn. */
export async function readHookResponse(response, notice) {
  if (!response.headers.get("content-type")?.startsWith("application/x-ndjson")) return response.json();
  if (!response.body) throw new Error("Native question response missing");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let result;
  let settled = false;
  let previous;
  const line = (text) => {
    const event = JSON.parse(text);
    if (settled) throw new Error("Native question response after settlement");
    if (event.type === "question_route" && ["owner_feed", "lead"].includes(event.route)) {
      if (event.route !== previous)
        notice(
          event.route === "owner_feed"
            ? "Your question is in the owner's feed. The owner can answer while Watch stays on."
            : "Your question is with the leading conversation; no second question was sent.",
        );
      previous = event.route;
    } else if (event.type === "result") {
      result = event.result;
      settled = true;
    } else throw new Error("Native question response unavailable; do not resend an uncertain answer");
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      buffer += chunk.value ?? "";
      if (buffer.length > 256 * 1024) throw new Error("Native question response too large");
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const text = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (text) line(text);
      }
      if (chunk.done) break;
    }
    if (buffer.trim()) line(buffer);
    if (!settled || !result) throw new Error("Native question response interrupted; do not resend");
    return result;
  } finally {
    reader.releaseLock();
  }
}
