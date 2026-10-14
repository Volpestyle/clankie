// Canonical source. integrations/claude-plugin/build.mjs copies this into the standalone worker.
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const parse = (value) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

/** Read new structured results and retained legacy text results. Never parse summaries. */
export function decodeMcpResult(result) {
  if (object(result?.structuredContent)) return result.structuredContent;
  for (const block of Array.isArray(result?.content) ? result.content : []) {
    if (!object(block) || block.type !== "text") continue;
    const value = parse(block.text);
    if (typeof value !== "string") return value;
  }
  return undefined;
}

/** Decode only the host envelope's content, not arbitrary provider string fields. */
function dataValue(value) {
  if (object(value) && typeof value.outcome === "string" && typeof value.content === "string")
    return { ...value, content: parse(value.content) };
  return value;
}

function summary(value, name, isError) {
  const data = object(value) && value.outcome === "ok" ? value.content : value;
  const state =
    value?.outcome === "ok" && object(data)
      ? (data.outcome ?? data.status ?? data.state)
      : (value?.outcome ?? value?.state);
  const label = name ? name.replace(/^.*__/, "").replaceAll("_", " ") : "Tool";
  if (value?.outcome === "uncertain" || value?.deliveryStage === "uncertain") {
    // The ID and detail are the only way to reconcile or report it (VUH-2100).
    const id = value.receiptId ?? value.deliveryId;
    return [
      "Outcome uncertain; may have applied. Reconcile the receipt; do not retry.",
      ...(typeof id === "string" ? [`ID ${id}.`] : []),
      ...(typeof value.detail === "string" ? [value.detail.slice(0, 300)] : []),
    ].join(" ");
  }
  if (value?.deliveryStage === "unavailable" && typeof value.detail === "string")
    return `Message unavailable. ${value.detail.slice(0, 300)}`;
  if (
    isError ||
    value?.isError === true ||
    ["failed", "uncertain", "refused", "error", "unavailable", "unconfirmed", "waiting_user"].includes(state)
  )
    // The detail names the actual cause; a bare reason code can mislead (VUH-2244).
    return `${label}: ${typeof state === "string" ? state : "failed"}${typeof (data?.reason ?? data?.code ?? data?.error) === "string" ? ` — ${(data.reason ?? data.code ?? data.error).slice(0, 256)}` : ""}.${typeof data?.detail === "string" && data.detail ? ` ${data.detail.slice(0, 300)}` : ""}`;
  if (object(data)) {
    const id = data.identifier ?? data.id;
    const status = typeof data.status === "string" ? data.status : data.state?.name;
    if (typeof id === "string" && /^[A-Z][A-Z0-9]*-\d+$/.test(id))
      return `${id}${status ? ` → ${status}` : ""}${typeof data.title === "string" ? `: ${data.title.slice(0, 160)}` : ""}`;
    if (value?.deliveryStage) return `Message ${value.deliveryStage}.`;
    if (/linear_(?:save|create(?:_worker)?)_comment$/.test(name) && (data.id || data.comment))
      return "Comment posted.";
  }
  if (Array.isArray(data)) return `${label}: ${data.length} results.`;
  return `${label}: result received.`;
}

/** MCP display projection only. Preserve errors, media, metadata and receipt identity. */
export function readableMcpResult(result, name = "") {
  if (object(result.structuredContent)) {
    const value = dataValue(result.structuredContent);
    const data = value?.outcome === "ok" ? value.content : value;
    // An upstream bridge may have already replaced the JSON with a summary.
    // Refresh failed results from their retained data, including the cause.
    if (result.isError || data?.state === "failed" || data?.state === "uncertain")
      return {
        ...result,
        structuredContent: value,
        content: [
          { type: "text", text: summary(value, name, result.isError) },
          ...result.content.filter(
            (_part, index) => index !== result.content.findIndex((part) => part.type === "text"),
          ),
        ],
      };
    return result;
  }
  const decoded = decodeMcpResult(result);
  if (decoded === undefined) return result;
  const value = dataValue(decoded);
  const structuredContent = object(value) ? value : { data: value };
  const dataIndex = result.content.findIndex(
    (part) => part.type === "text" && typeof parse(part.text) !== "string",
  );
  return {
    ...result,
    content: [
      { type: "text", text: summary(value, name, result.isError) },
      ...result.content.filter((_block, index) => index !== dataIndex),
    ],
    structuredContent,
  };
}
