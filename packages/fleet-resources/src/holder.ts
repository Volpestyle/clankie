/** Deny inherited task identity at each new native process/pane boundary. */
export const RESOURCE_HOLDER_RESET_ENV = Object.freeze({
  CLANKIE_RESOURCE_HOLDER: "",
  CLANKIE_SEAT_HARNESS: "",
  CLANKIE_SEAT_SESSION_ID: "",
  CLANKIE_SEAT_PARENT_ARGV: "",
  CODEX_THREAD_ID: "",
  CLAUDE_SESSION_ID: "",
  CLAUDE_AGENT_ID: "",
});

/** Native session/subagent label only; never grants seat or cleanup authority. */
export function resourceHolderIdentity(env: NodeJS.ProcessEnv = process.env): string | undefined {
  // Codex injects the executing thread, including native spawn_agent children.
  // Claude's Bash hook scopes its native invocation metadata to a subshell.
  // Without either, an inherited label cannot identify the current caller;
  // other harnesses can still supply an explicit request holder/--holder.
  const caller = env.CODEX_THREAD_ID
    ? `codex:${env.CODEX_THREAD_ID}`
    : env.CLAUDE_SESSION_ID
      ? `claude:${env.CLAUDE_SESSION_ID}${env.CLAUDE_AGENT_ID ? `:agent:${env.CLAUDE_AGENT_ID}` : ""}`
      : undefined;
  if (caller !== undefined && (caller.length > 256 || /\p{Cc}/u.test(caller)))
    throw new Error("Invalid fleet holder identity");
  // Never validate or use a stale ancestor label in place of native metadata.
  // Empty launch overrides mean that this seat has no inherited holder.
  return caller;
}
