import { boundedString } from "./update-files.ts";

/** Official sources only: HTTPS, or loopback HTTP for a local fixture. */
export function releaseUrl(value: unknown): string {
  const url = new URL(boundedString(value, 2048));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
    throw Error("Release source must be HTTPS");
  return url.toString();
}
