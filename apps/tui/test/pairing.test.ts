import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
  type CredentialStore,
  type ProviderCredential,
  type RedactedCredential,
} from "@clankie/credential-broker";
import { isHeadlessCaptainCommand, runHeadlessCaptainCommand } from "../bin/headless-captain.ts";
import type { PairingOffer } from "../bin/pairing-offer.ts";
import { buildPairCommands } from "../src/pair-commands.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";

const OPERATOR_ENV: NodeJS.ProcessEnv = { CLANKIE_OPERATOR_TOKEN: "operator-secret" };

/** The relay health probe `clankie pair` runs before it mints anything. */
const RELAY_HEALTH = "127.0.0.1:4321/health";

function requestUrl(input: unknown): string {
  return input instanceof Request ? input.url : String(input);
}

/**
 * Answers the relay probe healthy so a test that is about the offer never
 * spawns a service. The relay's own guarantee has its own tests below.
 */
function withHealthyRelay(fetchImpl: typeof fetch): typeof fetch {
  return (async (input: unknown, init: unknown) => {
    if (requestUrl(input).includes(RELAY_HEALTH)) return new Response("ok");
    return await (fetchImpl as (input: unknown, init: unknown) => Promise<Response>)(input, init);
  }) as typeof fetch;
}

/**
 * Process seams for the relay guarantee. Without them a probe would read this
 * machine's own process table and a start would spawn a real service.
 */
interface RelaySeams {
  readonly env: NodeJS.ProcessEnv;
  readonly fetchImpl: typeof fetch;
  readonly spawnImpl: typeof spawn;
  readonly listProcessCommandsImpl: () => readonly (readonly [number, string])[];
  readonly processIsAliveImpl: (pid: number) => boolean;
}

/** A child that has already exited, so a start fails on its first poll. */
function exitingChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    exitCode: 1,
    pid: 424_242,
    kill: () => true,
    unref: () => {},
  }) as unknown as ChildProcess;
}

/** A relay that answers nothing and cannot be started. */
function stoppedRelay(offerFetch: typeof fetch): {
  readonly options: RelaySeams;
  readonly spawned: () => number;
} {
  let spawns = 0;
  return {
    spawned: () => spawns,
    options: {
      env: { ...OPERATOR_ENV, XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "clankie-pair-")) },
      fetchImpl: (async (input: unknown, init: unknown) => {
        if (requestUrl(input).includes(RELAY_HEALTH)) throw new Error("connect ECONNREFUSED 127.0.0.1:4321");
        return await (offerFetch as (input: unknown, init: unknown) => Promise<Response>)(input, init);
      }) as typeof fetch,
      spawnImpl: ((): ChildProcess => {
        spawns += 1;
        return exitingChild();
      }) as unknown as typeof spawn,
      listProcessCommandsImpl: () => [],
      processIsAliveImpl: () => false,
    },
  };
}

/** A spawn seam that fails the test by counting a start nobody should make. */
function countingSpawn(): { readonly impl: typeof spawn; readonly count: () => number } {
  let count = 0;
  return {
    count: () => count,
    impl: ((): ChildProcess => {
      count += 1;
      return exitingChild();
    }) as unknown as typeof spawn,
  };
}

class MemoryCredentialStore implements CredentialStore {
  public readonly credentials = new Map<string, ProviderCredential>();
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
    operatorCredentialStore?: CredentialStore;
    stdout?: { write(chunk: string): void };
    stderr?: { write(chunk: string): void };
    /** Process seams for the relay-guarantee tests. */
    service?: Partial<RelaySeams>;
    /** Opt out of the healthy-relay stub when the test owns the relay probe. */
    rawFetch?: boolean;
  } = {},
): Promise<number> {
  const fetchImpl =
    overrides.fetchImpl === undefined || overrides.rawFetch === true
      ? overrides.fetchImpl
      : withHealthyRelay(overrides.fetchImpl);
  return await runHeadlessCaptainCommand(["pair", ...args], {
    repoRoot: "/unused",
    env: overrides.env ?? OPERATOR_ENV,
    // The brokered captain bearer the relay would be started with. A memory
    // store keeps every test off the real Keychain.
    captainCredentialStore: new MemoryCredentialStore(),
    ...(overrides.operatorCredentialStore === undefined
      ? {}
      : { operatorCredentialStore: overrides.operatorCredentialStore }),
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
    ...(overrides.stdout === undefined ? {} : { stdout: overrides.stdout }),
    ...(overrides.stderr === undefined ? {} : { stderr: overrides.stderr }),
    ...overrides.service,
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
  it("auto-loads the broker credential when no environment override is present", async () => {
    const store = new MemoryCredentialStore();
    const token = mintOperatorToken();
    await store.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
    let authorization: string | null = null;

    const exit = await runPair(["--json"], {
      env: {},
      operatorCredentialStore: store,
      fetchImpl: (async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization");
        return Response.json(validOffer());
      }) as typeof fetch,
      stdout: outputBuffer().stream,
    });

    expect(exit).toBe(0);
    expect(authorization).toBe(`Bearer ${token}`);
  });

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
      operatorCredentialStore: new MemoryCredentialStore(),
      fetchImpl: throwingFetch(new Error("must not be called"), calls),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    expect(exit).toBe(1);
    expect(calls.count).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("Operator credential unavailable");
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
      fetchImpl: jsonFetch({ error: "internal", token: "body-secret-999" }, { status: 500 }),
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    expect(exit).toBe(1);
    expect(`${stdout.text()}${stderr.text()}`).not.toContain("body-secret-999");
  });
});

describe("clankie pair — review offers", () => {
  it("mints a small set of long-lived single-use offers and marks the output", async () => {
    const bodies: unknown[] = [];
    let minted = 0;
    const stdout = outputBuffer();
    const exit = await runPair(["--review", "--days", "14"], {
      fetchImpl: (async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        minted += 1;
        return Response.json(
          validOffer({
            code: `CODE-000${minted}`,
            deepLink: `clankie://connect?offer=OFFER-${minted}`,
            expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60_000).toISOString(),
            review: true,
          }),
        );
      }) as typeof fetch,
      stdout: stdout.stream,
    });
    expect(exit).toBe(0);
    expect(bodies).toEqual([{ review: { days: 14 } }, { review: { days: 14 } }, { review: { days: 14 } }]);
    const text = stdout.text();
    expect(text).toContain("REVIEW OFFER — 14 days, 3 single-use codes.");
    expect(text).toContain("clankie devices");
    expect(text).toContain("Code 1: CODE-0001");
    expect(text).toContain("Code 3: CODE-0003");
    expect(text).toContain("clankie://connect?offer=OFFER-2");
    expect(text).not.toContain("Pairing code:");
  });

  it("emits the review JSON shape with --count", async () => {
    const offer = validOffer({ review: true });
    const calls = { count: 0 };
    const stdout = outputBuffer();
    const exit = await runPair(["--review", "--days", "7", "--count", "2", "--json"], {
      fetchImpl: jsonFetch(offer, undefined, calls),
      stdout: stdout.stream,
    });
    expect(exit).toBe(0);
    expect(calls.count).toBe(2);
    expect(JSON.parse(stdout.text())).toEqual({
      ok: true,
      review: true,
      expiresAt: offer.expiresAt,
      offers: [
        { code: offer.code, deepLink: offer.deepLink, expiresAt: offer.expiresAt },
        { code: offer.code, deepLink: offer.deepLink, expiresAt: offer.expiresAt },
      ],
    });
  });

  it.each([
    [["--review"], "--review requires --days"],
    [["--days", "3"], "require --review"],
    [["--review", "--days", "40"], "--days must be a whole number from 1 to 31"],
    [["--review", "--days", "3", "--count", "11"], "--count must be a whole number from 1 to 10"],
  ])("rejects %j without contacting the service", async (args, message) => {
    const calls = { count: 0 };
    const stderr = outputBuffer();
    const exit = await runPair(args, {
      fetchImpl: throwingFetch(new Error("must not be called"), calls),
      stderr: stderr.stream,
    });
    expect(exit).toBe(1);
    expect(calls.count).toBe(0);
    expect(stderr.text()).toContain(message);
  });

  it("keeps the ordinary request body empty", async () => {
    const bodies: unknown[] = [];
    const exit = await runPair(["--json"], {
      fetchImpl: (async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json(validOffer());
      }) as typeof fetch,
      stdout: outputBuffer().stream,
    });
    expect(exit).toBe(0);
    expect(bodies).toEqual([{}]);
  });
});

describe("clankie pair — the relay guarantee (VUH-1037)", () => {
  it("reuses a healthy relay and starts nothing", async () => {
    const probes: string[] = [];
    const spawn = countingSpawn();
    const stdout = outputBuffer();
    const exit = await runPair(["--json"], {
      rawFetch: true,
      fetchImpl: (async (input: unknown) => {
        probes.push(requestUrl(input));
        return requestUrl(input).includes(RELAY_HEALTH) ? new Response("ok") : Response.json(validOffer());
      }) as typeof fetch,
      service: { spawnImpl: spawn.impl, listProcessCommandsImpl: () => [] },
      stdout: stdout.stream,
    });
    expect(exit).toBe(0);
    expect(spawn.count()).toBe(0);
    // The relay is proven up before the offer exists, never after.
    expect(probes[0]).toContain(RELAY_HEALTH);
    expect(probes.at(-1)).toContain("/v1/pairing/offer");
  });

  it("mints no offer when the relay is down and cannot be started", async () => {
    const offers = { count: 0 };
    const relay = stoppedRelay(jsonFetch(validOffer(), undefined, offers));
    const stdout = outputBuffer();
    const exit = await runPair(["--json"], {
      rawFetch: true,
      service: relay.options,
      stdout: stdout.stream,
      stderr: outputBuffer().stream,
    });
    expect(exit).toBe(1);
    expect(relay.spawned()).toBe(1);
    expect(offers.count).toBe(0);
    const parsed = JSON.parse(stdout.text());
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe("unavailable");
    expect(parsed.error).toContain("App relay is not running");
  });

  it("mints no review offer either when the relay fails", async () => {
    const offers = { count: 0 };
    const relay = stoppedRelay(jsonFetch(validOffer({ review: true }), undefined, offers));
    const stderr = outputBuffer();
    const stdout = outputBuffer();
    const exit = await runPair(["--review", "--days", "7"], {
      rawFetch: true,
      service: relay.options,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    expect(exit).toBe(1);
    expect(offers.count).toBe(0);
    expect(stdout.text()).toBe("");
    expect(stderr.text()).toContain("App relay is not running");
  });

  it("never starts a relay for a caller without an operator credential", async () => {
    const spawn = countingSpawn();
    const stderr = outputBuffer();
    const exit = await runPair([], {
      env: {},
      operatorCredentialStore: new MemoryCredentialStore(),
      rawFetch: true,
      fetchImpl: throwingFetch(new Error("must not be called")),
      service: { spawnImpl: spawn.impl, listProcessCommandsImpl: () => [] },
      stderr: stderr.stream,
    });
    expect(exit).toBe(1);
    expect(spawn.count()).toBe(0);
    expect(stderr.text()).toContain("Operator credential unavailable");
  });

  it("fails closed for a remote control plane whose relay it cannot prove", async () => {
    const requests: string[] = [];
    const spawn = countingSpawn();
    const stdout = outputBuffer();
    const exit = await runPair(["--json"], {
      // Userinfo in the origin must not survive into the message.
      env: { ...OPERATOR_ENV, CLANKIE_CONTROL_PLANE_URL: "http://me:hunter2@100.64.0.5:4310" },
      rawFetch: true,
      fetchImpl: (async (input: unknown) => {
        requests.push(requestUrl(input));
        return Response.json(validOffer());
      }) as typeof fetch,
      service: { spawnImpl: spawn.impl, listProcessCommandsImpl: () => [] },
      stdout: stdout.stream,
      stderr: outputBuffer().stream,
    });
    expect(exit).toBe(1);
    // No local relay started, and nothing minted against a relay it cannot see.
    expect(spawn.count()).toBe(0);
    expect(requests).toEqual([]);
    const parsed = JSON.parse(stdout.text());
    expect(parsed.ok).toBe(false);
    expect(parsed.status).toBe("unavailable");
    expect(parsed.error).toContain("100.64.0.5:4310");
    expect(parsed.error).toContain("on that machine");
    expect(stdout.text()).not.toContain("hunter2");
  });

  it("keeps a failing start's own words out of both streams", async () => {
    const offers = { count: 0 };
    const relay = stoppedRelay(jsonFetch(validOffer(), undefined, offers));
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const exit = await runPair([], {
      rawFetch: true,
      service: {
        ...relay.options,
        spawnImpl: (() => {
          throw new Error("spawn pnpm failed: CLANKIE_CAPTAIN_TOKEN=leaked-secret-xyz");
        }) as unknown as RelaySeams["spawnImpl"],
      },
      stdout: stdout.stream,
      stderr: stderr.stream,
    });
    expect(exit).toBe(1);
    expect(offers.count).toBe(0);
    expect(`${stdout.text()}${stderr.text()}`).not.toContain("leaked-secret-xyz");
    expect(stderr.text()).toContain("clankie restart relay");
  });

  it("mints nothing once the deadline passed while the relay was coming up", async () => {
    const offers = { count: 0 };
    const stdout = outputBuffer();
    const exit = await runPair(["--json", "--timeout", "0.05"], {
      rawFetch: true,
      fetchImpl: (async (input: unknown) => {
        // The probe answers healthy, but only after the command's own clock ran
        // out; the offer double below ignores the abort signal entirely.
        if (requestUrl(input).includes(RELAY_HEALTH)) {
          await new Promise((resolve) => setTimeout(resolve, 150));
          return new Response("ok");
        }
        offers.count += 1;
        return Response.json(validOffer());
      }) as typeof fetch,
      service: { spawnImpl: countingSpawn().impl, listProcessCommandsImpl: () => [] },
      stdout: stdout.stream,
    });
    expect(exit).toBe(1);
    expect(offers.count).toBe(0);
    expect(JSON.parse(stdout.text()).status).toBe("interrupted");
  });
});

describe("clankie pair — a batch that fails partway", () => {
  const seams = { listProcessCommandsImpl: () => [] };

  it("shows the offers it already minted instead of orphaning them", async () => {
    // Each POST mints server-side, and an unredeemed offer has no revoke route:
    // codes the command drops would be live capability nobody can see.
    const minted: string[] = [];
    let posts = 0;
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const exit = await runPair(["--json", "--review", "--days", "31", "--count", "5"], {
      fetchImpl: (async () => {
        posts += 1;
        if (posts === 4) return Response.json({ error: "internal" }, { status: 500 });
        minted.push(`CODE-${posts}`);
        return Response.json(
          validOffer({
            code: `CODE-${posts}`,
            deepLink: `clankie://connect?offer=OFFER-${posts}`,
            review: true,
          }),
        );
      }) as typeof fetch,
      service: seams,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exit).toBe(1);
    // Stopped at the failure rather than minting the rest of the batch.
    expect(posts).toBe(4);
    expect(minted).toEqual(["CODE-1", "CODE-2", "CODE-3"]);
    const parsed = JSON.parse(stdout.text());
    expect(parsed).toMatchObject({ ok: false, status: "unavailable", partial: true, review: true });
    expect(parsed.offers.map((offer: { code: string }) => offer.code)).toEqual(minted);
    expect(stderr.text()).toContain("clankie:");
  });

  it("stops at the deadline mid-batch and still shows what it minted (human mode)", async () => {
    let posts = 0;
    const starts: number[] = [];
    const stdout = outputBuffer();
    const stderr = outputBuffer();
    const timeoutMs = 150;
    const startedAt = Date.now();
    const exit = await runPair(["--review", "--days", "7", "--count", "5", "--timeout", "0.15"], {
      fetchImpl: (async () => {
        posts += 1;
        starts.push(Date.now() - startedAt);
        // Answers slowly and ignores the abort signal, so only the command's
        // own clock can stop the batch.
        await new Promise((resolve) => setTimeout(resolve, 300));
        return Response.json(validOffer({ code: `CODE-${posts}`, review: true }));
      }) as typeof fetch,
      service: seams,
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(exit).toBe(1);
    // One mint began before the deadline; none began after it.
    expect(posts).toBe(1);
    expect(starts.every((start) => start < timeoutMs)).toBe(true);
    expect(stdout.text()).toContain("PARTIAL — 1 offer had already been minted");
    expect(stdout.text()).toContain("cannot be revoked");
    expect(stdout.text()).toContain("Code 1: CODE-1");
    expect(stderr.text()).toContain("clankie:");
  });
});

describe("/pair in the console", () => {
  function shellFixture(): {
    readonly results: { prompt: string; body: string; tone: string }[];
    readonly shell: ClankieFaceShell;
  } {
    const results: { prompt: string; body: string; tone: string }[] = [];
    return {
      results,
      shell: {
        insertCommandResult: (prompt: string, body: string, tone: string) =>
          results.push({ prompt, body, tone }),
      } as unknown as ClankieFaceShell,
    };
  }

  it("renders the offer through the same command the CLI runs", async () => {
    const offer = validOffer();
    const view = shellFixture();
    const command = buildPairCommands({
      repoRoot: "/unused",
      env: OPERATOR_ENV,
      captainCredentialStore: new MemoryCredentialStore(),
      fetchImpl: withHealthyRelay(jsonFetch(offer)),
      spawnImpl: countingSpawn().impl,
      listProcessCommandsImpl: () => [],
    })[0]!;

    await command.run("", view.shell);

    expect(view.results[0]?.tone).toBe("success");
    expect(view.results[0]?.body).toContain(`Pairing code: ${offer.code}`);
    expect(view.results[0]?.body).toContain(offer.deepLink);
  });

  it("shares the relay guarantee: no offer, an error in the transcript", async () => {
    const offers = { count: 0 };
    const relay = stoppedRelay(jsonFetch(validOffer(), undefined, offers));
    const view = shellFixture();
    const command = buildPairCommands({
      repoRoot: "/unused",
      captainCredentialStore: new MemoryCredentialStore(),
      ...relay.options,
    })[0]!;

    await command.run("", view.shell);

    expect(offers.count).toBe(0);
    expect(view.results[0]?.tone).toBe("error");
    expect(view.results[0]?.body).toContain("App relay is not running");
  });
});
