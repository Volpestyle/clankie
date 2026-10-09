/** Native session/subagent label only; never grants seat or cleanup authority. */
export function resourceHolderIdentity(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const inherited = env.CLANKIE_RESOURCE_HOLDER;
  if (inherited !== undefined && (!inherited || inherited.length > 256 || /\p{Cc}/u.test(inherited)))
    throw new Error("Invalid fleet holder identity");
  // Codex injects the executing thread, including native spawn_agent children.
  // A holder inherited from its parent must not collapse those distinct tasks.
  const holder = env.CODEX_THREAD_ID ? `codex:${env.CODEX_THREAD_ID}` : inherited;
  if (holder !== undefined && (holder.length > 256 || /\p{Cc}/u.test(holder)))
    throw new Error("Invalid fleet holder identity");
  return holder;
}
