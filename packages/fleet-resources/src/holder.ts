/** Native session/subagent label only; never grants seat or cleanup authority. */
export function resourceHolderIdentity(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const holder =
    env.CLANKIE_RESOURCE_HOLDER ?? (env.CODEX_THREAD_ID ? `codex:${env.CODEX_THREAD_ID}` : undefined);
  if (holder !== undefined && (!holder || holder.length > 256 || /\p{Cc}/u.test(holder)))
    throw new Error("Invalid fleet holder identity");
  return holder;
}
