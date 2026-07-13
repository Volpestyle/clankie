import { describe, expect, it } from "vitest";
import { isHeadlessCaptainCommand, runHeadlessCaptainCommand } from "../bin/headless-captain.ts";
import type { PairingOffer } from "../bin/pairing-offer.ts";

const OPERATOR_ENV: NodeJS.ProcessEnv = { CLANKIE_OPERATOR_TOKEN: "operator-secret" };

function outputBuffer(): { readonly stream: { write(chunk: string): void }; readonly text: () => string } {
  let output = "";
  return {
    stream: {
      write(chunk) {
        output += chunk;
      },
    },
    text: () => output,
  };
}

function validOffer(overrides: Partial<PairingOffer> = {}): PairingOffer {
  return {
    version: 1,
    deepLink: "clankie://connect?offer=OFFER-CAPABILITY-abc123",
    code: "PAIR-7F3K",
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    ...overrides,
  };
}

/** A fake fetch that returns the given JSON body/status, recording call count. */
function jsonFetch(body: unknown, init?: ResponseInit, calls?: { count: number }): typeof fetch {
  return (async () => {
    if (calls !== undefined) calls.count += 1;
    return Response.json(body, init);
  }) as typeof fetch;
}

function throwingFetch(error: unknown, calls?: { count: number }): typeof fetch {
  return (async () => {
    if (calls !== undefined) calls.count += 1;
    throw error;
  }) as typeof fetch;
}

/** Never resolves on its own; rejects with an AbortError when the signal aborts. */
function abortableFetch(): typeof fetch {
  return ((_input: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    })) as typeof fetch;
}

async function runPair(
  args: readonly string[],
  overrides: {
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
    stdout?: { write(chunk: string): void };
    stderr?: { write(chunk: string): void };
  } = {},
): Promise<number> {
  return await runHeadlessCaptainCommand(["pair", ...args], {
    repoRoot: "/unused",
    env: overrides.env ?? OPERATOR_ENV,
    ...(overrides.fetchImpl === undefined ? {} : { fetchImpl: overrides.fetchImpl }),
    ...(overrides.stdout === undefined ? {} : { stdout: overrides.stdout }),
    ...(overrides.stderr === undefined ? {} : { stderr: overrides.stderr }),
  });
}

describe("clankie pair — recognition", () => {
  it("recognizes pair as a headless command and never falls through on unknown commands", () => {
    expect(isHeadlessCaptainCommand("pair")).toBe(true);
    expect(isHeadlessCaptainCommand("pairs")).toBe(false);
    expect(isHeadlessCaptainCommand("unknown")).toBe(false);
    expect(isHeadlessCaptainCommand(undefined)).toBe(false);
  });
});

describe("clankie pair — success", () => {
  it("renders a QR, the copyable code, and the deep link with expiry (human mode)", async () => {
    const offer = validOffer();
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const exit = await runPair([], {
      fetchImpl: jsonFetch(offer),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    expect(exit).toBe(0);
    expect(stderr.text()).toBe("");
    expect(stdout.text()).toContain("Scan this QR");
    expect(stdout.text()).toContain(`Pairing code: ${offer.code}`);
    expect(stdout.text()).toContain(offer.deepLink);
    expect(stdout.text()).toContain("single use");
    // The QR block makes the output far larger than the plain text alone.
    expect(stdout.text().split("\n").length).toBeGreaterThan(10);
  });

  it("emits strict ANSI-free JSON whose deep link matches the encoded one", async () => {
    const offer = validOffer();
    const stdout = outputBuffer();
    const exit = await runPair(["--json"], { fetchImpl: jsonFetch(offer), stdout: stdout.stream });
    expect(exit).toBe(0);
    expect(stdout.text()).not.toContain("\u001b"); // no ANSI escape sequences
    const parsed = JSON.parse(stdout.text());
    expect(parsed).toEqual({
      ok: true,
      code: offer.code,
      deepLink: offer.deepLink,
      expiresAt: offer.expiresAt,
    });
  });
});

describe("clankie pair — fail closed", () => {
  it("fails closed without contacting the service when no operator token is set", async () => {
    const calls = { count: 0 };
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const exit = await runPair([], {
      env: {},
      fetchImpl: throwingFetch(new Error("must not be called"), calls),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    expect(exit).toBe(1);
    expect(calls.count).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("Operator token required");
  });

  it.each([
    [
      "transport failure (ECONNREFUSED)",
      throwingFetch(new Error("connect ECONNREFUSED 127.0.0.1:4310")),
      "unavailable",
    ],
    ["absent route (404)", jsonFetch({ error: "not_found" }, { status: 404 }), "unavailable"],
    ["service unavailable (503)", jsonFetch({ error: "unavailable" }, { status: 503 }), "unavailable"],
    ["unauthorized (401)", jsonFetch({ error: "unauthorized" }, { status: 401 }), "unauthorized"],
    ["expired offer state", jsonFetch({ error: "expired" }, { status: 409 }), "expired"],
    ["consumed offer state", jsonFetch({ error: "consumed" }, { status: 409 }), "consumed"],
    ["revoked offer state", jsonFetch({ error: "revoked" }, { status: 409 }), "revoked"],
    ["malformed response", jsonFetch({ version: 1, deepLink: "" }), "malformed"],
  ])("fails closed on %s with JSON status %s", async (_label, fetchImpl, status) => {
    const stdout = outputBuffer();
    const exit = await runPair(["--json"], { fetchImpl, stdout: stdout.stream });
    expect(exit).toBe(1);
    const parsed = JSON.parse(stdout.text());
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe(status);
    expect(typeof parsed.error).toBe("string");
  });

  it("treats an already-expired valid offer as expired", async () => {
    const offer = validOffer({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
    const stdout = outputBuffer();
    const exit = await runPair(["--json"], { fetchImpl: jsonFetch(offer), stdout: stdout.stream });
    expect(exit).toBe(1);
    expect(JSON.parse(stdout.text()).status).toBe("expired");
  });

  it("fails closed when the request times out (human mode)", async () => {
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const exit = await runPair(["--timeout", "0.05"], {
      fetchImpl: abortableFetch(),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    expect(exit).toBe(1);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("clankie:");
  });
});

describe("clankie pair — redaction", () => {
  it("never echoes a secret carried by a transport error", async () => {
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const exit = await runPair(["--json"], {
      fetchImpl: throwingFetch(new Error("ECONNREFUSED token=leaked-secret-xyz")),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    expect(exit).toBe(1);
    expect(`${stdout.text()}${stderr.text()}`).not.toContain("leaked-secret-xyz");
  });

  it("never echoes a secret carried by a service error body", async () => {
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const exit = await runPair([], {
      fetchImpl: jsonFetch({ error: "revoked", token: "body-secret-999" }, { status: 409 }),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    expect(exit).toBe(1);
    expect(`${stdout.text()}${stderr.text()}`).not.toContain("body-secret-999");
  });
});
