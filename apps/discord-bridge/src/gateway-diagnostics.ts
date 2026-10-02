/** Only allowlisted lifecycle facts leave discord.js debug; never tokens or raw packets. */
export function gatewayDiagnostic(debug: string): Record<string, string | number | boolean> | undefined {
  const match = /^\[WS => Shard (\d+)\] ([\s\S]+)$/u.exec(debug);
  if (!match) return undefined;
  const shardId = Number(match[1]);
  const message = match[2]!;
  if (message.startsWith("Destroying shard\n")) {
    const reason = /\n\s*Reason: ([^\n]+)/u.exec(message)?.[1];
    const known = new Map([
      ["Zombie connection", "heartbeat_ack_missing"],
      ["Told to reconnect by Discord", "discord_requested_reconnect"],
      ["Got disconnected by Discord", "discord_closed"],
    ]);
    const code = /\n\s*Code: (\d+)/u.exec(message)?.[1];
    return {
      shardId,
      event: "destroy",
      reason: known.get(reason ?? "") ?? "other",
      ...(code ? { code: Number(code) } : {}),
    };
  }
  const invalid = /^Invalid session; will attempt to resume: (true|false)$/u.exec(message);
  if (invalid) return { shardId, event: "invalid_session", resumable: invalid[1] === "true" };
  const resumed = /^Resumed and replayed (\d+) events$/u.exec(message);
  if (resumed) return { shardId, event: "resumed", replayedEvents: Number(resumed[1]) };
  const closed = /^The gateway closed with an unexpected code (\d+),/u.exec(message);
  if (closed) return { shardId, event: "closed", code: Number(closed[1]) };
  return undefined;
}
