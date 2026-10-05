import { sanitizeForSupportBundle } from "@clankie/observability";
import { OPERATOR_CONVERSATION_TOOL_DETAIL_MAX } from "@clankie/protocol";
import { basename, dirname } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type HerdrSessionCensus } from "./herdr-census.ts";
import { operatorPromptWithHerdrSeat } from "./herdr-seat.ts";

const TOOL_DETAIL_TRUNCATED = "\n… truncated";

function boundOperatorToolDetail(detail: string): string {
  if (detail.length <= OPERATOR_CONVERSATION_TOOL_DETAIL_MAX) return detail;
  return `${detail.slice(0, OPERATOR_CONVERSATION_TOOL_DETAIL_MAX - TOOL_DETAIL_TRUNCATED.length)}${TOOL_DETAIL_TRUNCATED}`;
}

/** Serialize a tool payload without letting diagnostics fail the turn that produced it. */
export function formatOperatorToolDetail(value: unknown): string {
  let detail: string;
  try {
    const sanitized = sanitizeForSupportBundle(value);
    detail = JSON.stringify(sanitized, null, 2) ?? String(sanitized);
  } catch {
    return "[tool detail could not be serialized]";
  }
  return boundOperatorToolDetail(detail);
}

/** Prefer the result text Pi gave the model over dumping Pi's transport envelope. */
export function formatOperatorToolResult(result: unknown): string {
  if (typeof result !== "object" || result === null) return formatOperatorToolDetail(result);
  const content = (result as { readonly content?: unknown }).content;
  if (!Array.isArray(content)) return formatOperatorToolDetail(result);
  const visible = content.flatMap((block): string[] => {
    if (typeof block !== "object" || block === null) return [];
    const entry = block as { readonly mimeType?: unknown; readonly text?: unknown; readonly type?: unknown };
    if (entry.type === "text" && typeof entry.text === "string") return [entry.text];
    if (entry.type === "image") {
      return [`[image${typeof entry.mimeType === "string" ? `: ${entry.mimeType}` : ""}]`];
    }
    return [];
  });
  // ponytail: show model-visible content; add tool-specific renderers if structured details need their own UI.
  return visible.length === 0
    ? formatOperatorToolDetail(result)
    : boundOperatorToolDetail(stripVTControlCharacters(visible.join("\n\n")));
}

/** Pi loads a skill through the ordinary read tool; retain that meaning for the operator UI. */
export function operatorSkillName(toolName: string, args: unknown): string | undefined {
  if (toolName !== "read" || typeof args !== "object" || args === null) return undefined;
  const fields = args as { readonly file_path?: unknown; readonly path?: unknown };
  const path = typeof fields.path === "string" ? fields.path : fields.file_path;
  if (typeof path !== "string" || basename(path) !== "SKILL.md") return undefined;
  const name = basename(dirname(path));
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) && name.length <= 64 ? name : undefined;
}

export function resolveOperatorPrompt(
  message: string,
  skills: readonly { readonly disableModelInvocation: boolean; readonly name: string }[],
  herdrPaneId?: string,
  census?: HerdrSessionCensus,
): { readonly prompt: string; readonly skillName?: string } {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/u.exec(message);
  const token = match?.[1]?.toLowerCase();
  if (token === undefined) return { prompt: operatorPromptWithHerdrSeat(message, herdrPaneId, census) };
  const name = token.startsWith("skill:") ? token.slice("skill:".length) : token;
  const skill = skills.find((candidate) => candidate.name === name && !candidate.disableModelInvocation);
  if (skill === undefined) return { prompt: operatorPromptWithHerdrSeat(message, herdrPaneId, census) };
  const args = operatorPromptWithHerdrSeat(match?.[2]?.trim() ?? "", herdrPaneId, census).trim();
  return {
    prompt: `/skill:${skill.name}${args.length === 0 ? "" : ` ${args}`}`,
    skillName: skill.name,
  };
}
