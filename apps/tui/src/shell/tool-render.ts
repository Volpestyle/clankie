/**
 * Render definitions for the tools pi does not ship one for: every MCP tool the
 * service exposes as `${server}_${tool}` (`apps/clankie/src/mcp-host.ts`) plus
 * the authored captain bank.
 *
 * Without a definition `ToolExecutionComponent` falls back to the bold tool
 * name, `JSON.stringify(args, null, 2)`, and the first ten lines of raw output.
 * MCP results arrive as a `{ outcome, content }` envelope whose `content` is the
 * server's own JSON re-encoded into a single string, so a six-comment
 * `linear_list_comments` result is three lines, the ten-line cap never fires,
 * and the viewport fills with one enormous escaped-JSON line. Unwrapping the
 * envelope is what makes the preview a preview again.
 *
 * The service knows a nicer label for these (`linear: list_comments`, from the
 * catalog it registers in `captain/tools.ts`), but the operator protocol
 * projects only the tool name, so the row is titled by name here.
 */
import { Text, type Component } from "@earendil-works/pi-tui";
import {
  keyHint,
  type Theme,
  type ToolDefinition,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";

/**
 * pi renders these itself (`core/tools/index.ts`) and its definitions are the
 * better-looking ones, so they keep the row. A tool pi adds later falls through
 * to the generic renderer, which is duller than a bespoke one but never worse
 * than the fallback it replaces.
 */
const PI_BUILT_IN_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  "edit",
  "find",
  "grep",
  "ls",
  "read",
  "write",
]);

/** Matches pi's own `FALLBACK_PREVIEW_LINES`, so collapsed rows stay a uniform height. */
const PREVIEW_LINES = 10;
const ARGS_SUMMARY_WIDTH = 96;
const ARGS_VALUE_WIDTH = 48;

/** The fields the renderers actually read off pi's `ToolRenderContext`. */
interface RenderContext {
  readonly lastComponent: Component | undefined;
  readonly expanded: boolean;
  readonly isError: boolean;
}

interface ToolResultContent {
  readonly content?: readonly { readonly type: string; readonly text?: string | undefined }[] | undefined;
  readonly isError?: boolean | undefined;
}

function ellipsize(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

function summarizeValue(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  return ellipsize(text.replace(/\s+/gu, " ").trim(), ARGS_VALUE_WIDTH);
}

/** `issueId=VUH-1136 limit=30` — the collapsed row's one-line argument summary. */
export function summarizeToolArgs(args: unknown): string {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (value === undefined) continue;
    parts.push(`${key}=${summarizeValue(value)}`);
  }
  return ellipsize(parts.join(" "), ARGS_SUMMARY_WIDTH);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * `{"outcome":"ok","content":"{\"comments\":[…]}"}` becomes the inner JSON,
 * pretty-printed onto real lines. A refusal keeps its envelope but gains the
 * same indentation; anything that is not an MCP envelope — the authored bank's
 * plain text, a server's truncation notice — comes back untouched.
 */
export function unwrapMcpResult(output: string): string {
  const envelope = parseJson(output);
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) return output;
  const record = envelope as Record<string, unknown>;
  if (typeof record.outcome !== "string") return output;
  const content = record.content;
  if (typeof content !== "string") return JSON.stringify(record, null, 2);
  const inner = parseJson(content);
  return inner === undefined ? content : JSON.stringify(inner, null, 2);
}

/** The lines a result row shows, and how many it holds back behind the expand key. */
export function previewLines(
  output: string,
  expanded: boolean,
): { readonly lines: readonly string[]; readonly hidden: number } {
  const lines = output.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();
  if (expanded || lines.length <= PREVIEW_LINES) return { lines, hidden: 0 };
  return { lines: lines.slice(0, PREVIEW_LINES), hidden: lines.length - PREVIEW_LINES };
}

function textOutput(result: ToolResultContent): string {
  return (result.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

function reuseText(last: Component | undefined): Text {
  return last instanceof Text ? last : new Text("", 0, 0);
}

/**
 * A render-only definition. `ToolExecutionComponent` reads `renderCall`,
 * `renderResult`, and `renderShell` off it and never executes it — execution
 * belongs to the service — so the cast stands in for the `parameters`/`execute`
 * half of the interface rather than a stub that could be called by mistake.
 */
export function genericToolRenderer(name: string): ToolDefinition | undefined {
  if (PI_BUILT_IN_TOOLS.has(name)) return undefined;
  const definition = {
    renderCall(args: unknown, theme: Theme, context: RenderContext): Component {
      const text = reuseText(context.lastComponent);
      const title = theme.fg("toolTitle", theme.bold(name));
      if (context.expanded) {
        const detail = args === undefined ? "" : `\n${JSON.stringify(args, null, 2)}`;
        text.setText(title + theme.fg("dim", detail));
        return text;
      }
      const summary = summarizeToolArgs(args);
      text.setText(summary.length > 0 ? `${title} ${theme.fg("dim", summary)}` : title);
      return text;
    },
    renderResult(
      result: ToolResultContent,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: RenderContext,
    ): Component {
      const text = reuseText(context.lastComponent);
      const output = unwrapMcpResult(textOutput(result));
      if (output.length === 0) {
        text.setText("");
        return text;
      }
      const { lines, hidden } = previewLines(output, options.expanded);
      const color = context.isError || result.isError === true ? "error" : "toolOutput";
      let rendered = `\n${lines.map((line) => theme.fg(color, line)).join("\n")}`;
      if (hidden > 0) {
        rendered += `${theme.fg("muted", `\n... (${hidden} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
      }
      text.setText(rendered);
      return text;
    },
  };
  return definition as unknown as ToolDefinition;
}
