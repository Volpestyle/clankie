import type { GatewayDoorwayReport } from "./command/gateway.ts";

/**
 * The one thing worth doing next for phone access, from the live doorway and
 * what is configured. `status`, `doctor` and the console commands that open on
 * a next step (`/pair`, `/remote-access`) share it so they never disagree.
 */
export function nextStepLine(input: {
  readonly doorway: GatewayDoorwayReport;
  /** A gateway URL and account credential are stored. */
  readonly remoteAccessConfigured: boolean;
  readonly directRouteConfigured: boolean;
}): string {
  switch (input.doorway.state) {
    case "sign_in_required":
      return 'Sign this Mac back in: run /remote-access and choose "Sign this Mac back in", or `clankie remote-access on`.';
    case "unavailable":
      return "Remote access is configured but holds no connection: read Clankie's log, then `clankie restart captain`.";
    case "unreachable":
      return "Clankie is not answering: start him with `clankie`, then check `clankie status`.";
    default:
      break;
  }
  if (input.remoteAccessConfigured || input.directRouteConfigured) {
    return "Pair a phone or tablet: run `clankie pair` (or /pair).";
  }
  return "Pair a phone or tablet: run `clankie pair`. To reach him away from this network, sign in with `clankie remote-access on` or set `clankie gateway direct`.";
}
