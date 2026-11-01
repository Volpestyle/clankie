export interface FleetLink {
  readonly schemaVersion: 1 | 2;
  readonly authentication?: "local-process";
  readonly fleet: string;
  readonly socket: string;
  readonly url: string;
  readonly token?: string;
}
/** This process's seat: its Herdr pane, else its desktop-app terminal as `herdr-core/<address>` (ADR 0319). */
export function seatIdentity(env?: NodeJS.ProcessEnv): {
  readonly pane: string | undefined;
  readonly socket: string | undefined;
};
export function readLink(socket?: string, env?: NodeJS.ProcessEnv): FleetLink | undefined;
export function seatRoute(link: FleetLink, paneId: string, route: string): URL;
