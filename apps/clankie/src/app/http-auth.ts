import { type DiscordTransportKind } from "@clankie/protocol";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  type ClankieAppDependencies,
  type TrustedCaptainIdentity,
  type TrustedOperatorIdentity,
} from "./types.ts";
export function captainTransportKind(captain: TrustedCaptainIdentity): DiscordTransportKind {
  return captain.discordTransportKind ?? "bot";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export async function authenticateCaptain(
  request: Request,
  dependencies: ClankieAppDependencies,
): Promise<TrustedCaptainIdentity | "unavailable" | undefined> {
  if (!dependencies.authenticateCaptain) return "unavailable";
  return dependencies.authenticateCaptain(request);
}

export async function authenticateOperator(
  request: Request,
  dependencies: ClankieAppDependencies,
): Promise<TrustedOperatorIdentity | "unavailable" | undefined> {
  if (!dependencies.authenticateOperator) return "unavailable";
  return dependencies.authenticateOperator(request);
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export function createBearerAuthenticator<T>(
  token: string,
  identity: T,
): (request: Request) => Promise<T | undefined> {
  if (token.length === 0) throw new Error("Authentication token must not be empty");
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  return (request) => {
    const actual = createHash("sha256")
      .update(request.headers.get("authorization") ?? "")
      .digest();
    return Promise.resolve(timingSafeEqual(actual, expected) ? identity : undefined);
  };
}
