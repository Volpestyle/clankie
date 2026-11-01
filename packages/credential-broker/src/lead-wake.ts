import { LeadWakeNameSchema, leadWakeUrl } from "@clankie/protocol/connector";
import type { CredentialStore } from "./credential-store.ts";

/**
 * A connected lead's wake webhook (ADR 0336): the address a lead such as Grok Bot made
 * to take jobs, and the key it checks. Both are secrets the owner hands Clankie once at
 * the Mac; they live only here, never in settings, logs, notes or answers.
 */
export const LEAD_WAKE_PROVIDER_PREFIX = "lead-wake-";
const AUTHORIZATION_MAX = 4_096;

export interface LeadWake {
  readonly url: string;
  /** The whole Authorization header value, such as `Bearer abc`. */
  readonly authorization: string;
}

export function leadWakeProviderId(name: string): string {
  return `${LEAD_WAKE_PROVIDER_PREFIX}${LeadWakeNameSchema.parse(name)}`;
}

/**
 * The Authorization header value from what the owner pasted: a bare key becomes
 * `Bearer KEY`; a value that already names its scheme (`Bearer KEY`, `Basic …`) is kept.
 * One line of visible characters, or nothing.
 */
export function leadWakeAuthorization(raw: string): string | undefined {
  const value = raw.trim();
  if (value.length === 0 || value.length > AUTHORIZATION_MAX) return undefined;
  if (/[^\x21-\x7e ]/u.test(value)) return undefined;
  return /^[A-Za-z][A-Za-z0-9._~+/-]* \S/u.test(value) ? value : `Bearer ${value}`;
}

/** Stores a lead's webhook, replacing any before it. Throws on an address or key it won't keep. */
export async function setLeadWake(
  store: CredentialStore,
  name: string,
  input: { readonly url: string; readonly authorization: string },
): Promise<void> {
  const url = leadWakeUrl(input.url);
  if (url === undefined)
    throw new Error("The webhook address must be https with a named host (or http on this Mac's loopback).");
  const authorization = leadWakeAuthorization(input.authorization);
  if (authorization === undefined) throw new Error("The webhook key must be one line of visible characters.");
  await store.set(leadWakeProviderId(name), { type: "wellknown", key: url.href, token: authorization });
}

export async function readLeadWake(store: CredentialStore, name: string): Promise<LeadWake | undefined> {
  const credential = await store.get(leadWakeProviderId(name));
  if (credential?.type !== "wellknown") return undefined;
  const url = leadWakeUrl(credential.key);
  const authorization = leadWakeAuthorization(credential.token);
  return url === undefined || authorization === undefined ? undefined : { url: url.href, authorization };
}

export async function clearLeadWake(store: CredentialStore, name: string): Promise<boolean> {
  return store.delete(leadWakeProviderId(name));
}

/** The names of the leads with a stored webhook, sorted. Names only: never an address or key. */
export async function listLeadWakes(store: CredentialStore): Promise<string[]> {
  const listed = await store.list();
  return Object.keys(listed)
    .filter((id) => id.startsWith(LEAD_WAKE_PROVIDER_PREFIX) && listed[id]?.type === "wellknown")
    .map((id) => id.slice(LEAD_WAKE_PROVIDER_PREFIX.length))
    .filter((name) => LeadWakeNameSchema.safeParse(name).success)
    .sort();
}
