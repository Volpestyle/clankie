export interface FleetLink {
  readonly schemaVersion: 1 | 2;
  readonly authentication?: "local-process";
  readonly fleet: string;
  readonly socket: string;
  readonly url: string;
  readonly token?: string;
}
export function readLink(socket?: string, env?: NodeJS.ProcessEnv): FleetLink | undefined;
export function seatRoute(link: FleetLink, paneId: string, route: string): URL;
