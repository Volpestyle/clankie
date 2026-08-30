import { DEFAULT_CONTROL_PLANE_URL } from "../../bin/pairing-offer.ts";

export type Writable = { write(chunk: string): unknown };

export function commandHost(options: { readonly host?: string; readonly env?: NodeJS.ProcessEnv }): string {
  const env = options.env ?? process.env;
  return (
    options.host ?? env.CLANKIE_CONTROL_PLANE_URL ?? env.CLANKIE_CAPTAIN_URL ?? DEFAULT_CONTROL_PLANE_URL
  );
}

export function outputJson(stream: Writable, value: unknown): void {
  stream.write(`${JSON.stringify(value)}\n`);
}
