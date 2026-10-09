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
  const state = value?.outcome === "ok" && object(data) ? (data.outcome ?? data.status) : value?.outcome;
  const label = name ? name.replace(/^.*__/, "").replaceAll("_", " ") : "Tool";
  if (value?.outcome === "uncertain" || value?.deliveryStage === "uncertain")
    return "Outcome uncertain; may have applied. Reconcile the receipt; do not retry.";
  if (
    isError ||
    value?.isError === true ||
    ["refused", "error", "unavailable", "unconfirmed", "waiting_user"].includes(state)
  )
    return `${label}: ${state ?? "failed"}${typeof value?.reason === "string" ? ` — ${value.reason.slice(0, 180)}` : ""}.`;
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
  if (object(result.structuredContent)) return result;
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
