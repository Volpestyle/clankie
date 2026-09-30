import { describe, expect, it } from "vitest";
import type { CredentialStore, ProviderCredential, RedactedCredential } from "@clankie/credential-broker";
import { runHeadlessCaptainCommand } from "../bin/headless-captain.ts";
import type { PairingOffer } from "../bin/pairing-offer.ts";

// ADR 0204: `clankie pair` says which routes its QR carries, so the operator
// knows whether the App Store app can pair with it and without an account.

class MemoryCredentialStore implements CredentialStore {
  private readonly credentials = new Map<string, ProviderCredential>();
  public get(providerId: string): Promise<ProviderCredential | undefined> {
    return Promise.resolve(this.credentials.get(providerId));
  }
  public set(providerId: string, credential: ProviderCredential): Promise<void> {
    this.credentials.set(providerId, credential);
    return Promise.resolve();
  }
  public delete(providerId: string): Promise<boolean> {
    return Promise.resolve(this.credentials.delete(providerId));
  }
  public list(): Promise<Record<string, RedactedCredential>> {
    return Promise.resolve({});
  }
}

const offer = (overrides: Partial<PairingOffer>): PairingOffer => ({
  version: 1,
  deepLink: "clankie://connect?v=1&offer=OFFER-CAPABILITY-abc123",
  code: "PAIR-7F3K",
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  ...overrides,
});

async function pair(minted: PairingOffer, args: readonly string[] = []): Promise<string> {
  let output = "";
  const fetchImpl = (async (input: unknown) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.includes("/health") ? new Response("ok") : Response.json(minted);
  }) as typeof fetch;
  const exit = await runHeadlessCaptainCommand(["pair", ...args], {
    repoRoot: "/unused",
    env: { CLANKIE_OPERATOR_TOKEN: "operator-secret" },
    captainCredentialStore: new MemoryCredentialStore(),
    fetchImpl,
    stdout: { write: (chunk: string) => void (output += chunk) },
    stderr: { write: () => undefined },
  });
  expect(exit).toBe(0);
  return output;
}

describe("clankie pair — routes", () => {
  it("names both routes when the link carries the gateway and a direct origin", async () => {
    const text = await pair(offer({ gateway: true, direct: "https://mac.tail1234.ts.net" }));
    expect(text).toContain("Routes: remote access (gateway) + direct (https://mac.tail1234.ts.net)");
    expect(text).not.toContain("cannot reach");
  });

  it("warns when the App Store app cannot reach the direct origin over plain HTTP", async () => {
    const text = await pair(offer({ direct: "http://mac.tail1234.ts.net:4311" }));
    expect(text).toContain("Routes: direct (http://mac.tail1234.ts.net:4311)");
    expect(text).toContain("The App Store app cannot reach http://mac.tail1234.ts.net:4311");
  });

  it("says a link with no route pairs only a source build", async () => {
    const text = await pair(offer({}));
    expect(text).toContain("Route: this Mac only");
    expect(text).toContain("clankie gateway direct");
  });

  it("reports the routes in JSON", async () => {
    const parsed = JSON.parse(
      await pair(offer({ direct: "http://192.168.4.20:4311" }), ["--json"]),
    ) as unknown;
    expect(parsed).toMatchObject({
      ok: true,
      routes: { gateway: false, direct: "http://192.168.4.20:4311" },
    });
  });
});
