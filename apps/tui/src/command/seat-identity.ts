/**
 * Where a hired worker sits: its Herdr pane and that session's socket, else the Herdr
 * desktop app's terminal it runs in (ADR 0319), named `herdr-core/<address>` beside the
 * core's socket. A Herdr pane id wins; empty variables are none. A desktop hire has no
 * pane id but may carry Clankie's Herdr socket for the `herdr` CLI (#291), so that
 * socket alone never names a seat while a desktop terminal does. The worker plugin's
 * link.mjs reads the same variables the same way.
 */
export function seatIdentity(env: NodeJS.ProcessEnv = process.env): {
  readonly pane: string | undefined;
  readonly socket: string | undefined;
} {
  const pane = env.HERDR_PANE_ID?.trim();
  const herdr = env.HERDR_SOCKET_PATH?.trim();
  if (pane) return { pane, socket: herdr || undefined };
  const terminal = env.HC_TERMINAL_ID?.trim();
  const core = env.HC_TERMINAL_SOCKET?.trim();
  if (terminal && core && /^t[0-9a-z]+$/u.test(terminal))
    return { pane: `herdr-core/${terminal}`, socket: core };
  return { pane: undefined, socket: herdr || undefined };
}
