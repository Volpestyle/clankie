/** Named operator launches. Claude numbers select shell commands; Codex numbers select exact registered labels. */
export function operatorHarness(
  command: string | undefined,
): "claude" | "codex" | "opencode" | "grok" | undefined {
  if (/^claude\d*$/u.test(command ?? "")) return "claude";
  if (/^codex\d*$/u.test(command ?? "")) return "codex";
  if (command === "opencode" || command === "grok") return command;
  return undefined;
}
