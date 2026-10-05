/** Shared tool output display, extracted from VUH-1442's app formatter. Node-free. */
export type ToolOutputPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly uri: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Strings stay intact, including malformed/truncated host JSON. */
export function prettyToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Decode only complete JSON values; never replace literal backslashes in command output. */
export function formatToolOutput(rawOutput: unknown): ToolOutputPart[] {
  if (rawOutput === undefined || rawOutput === "") return [];
  return outputParts(rawOutput, 0);
}

function outputParts(value: unknown, depth: number): ToolOutputPart[] {
  if (depth >= 12) return [{ kind: "text", text: prettyToolValue(value) }];
  if (typeof value === "string") {
    try {
      return outputParts(JSON.parse(value), depth + 1);
    } catch {
      return [{ kind: "text", text: value }];
    }
  }
  // The authored MCP host uses a string content field; ordinary API objects
  // with a content string are retained, matching the original app contract.
  if (record(value) && typeof value.outcome === "string" && typeof value.content === "string") {
    return outputParts(value.content, depth + 1);
  }
  const content = record(value) && Array.isArray(value.content) ? value.content : value;
  if (
    Array.isArray(content) &&
    content.length > 0 &&
    content.every((part) => record(part) && typeof part.type === "string")
  ) {
    return content.flatMap((part): ToolOutputPart[] => {
      if (
        ["text", "input_text", "output_text"].includes(part.type as string) &&
        typeof part.text === "string"
      ) {
        return outputParts(part.text, depth + 1);
      }
      if (
        part.type === "image" &&
        typeof part.data === "string" &&
        typeof part.mimeType === "string" &&
        part.mimeType.startsWith("image/")
      ) {
        return [{ kind: "image", uri: `data:${part.mimeType};base64,${part.data}` }];
      }
      return [{ kind: "text", text: prettyToolValue(part) }];
    });
  }
  return [{ kind: "text", text: prettyToolValue(value) }];
}
