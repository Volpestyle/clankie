import { type CredentialStore } from "@clankie/credential-broker";
import { describe, expect, it } from "vitest";
import { runHeadlessCaptainCommand } from "../bin/headless-captain.ts";
import { runMemoryCardCommand } from "../src/command/memory-card.ts";
import { runPromptCommand, type LaneReadCommandOptions } from "../src/command/prompt.ts";

/**
 * The consumer is another harness's system prompt or a per-turn hook, so what
 * is asserted here is the plain-text passthrough: no JSON envelope, no added
 * newline, no trimming.
 */

const OPERATOR_TOKEN = `clankie_op_${"a".repeat(43)}`;

const credentialStore = {
  get: () => Promise.resolve({ type: "api", key: OPERATOR_TOKEN }),
} as unknown as CredentialStore;

function recorder(
  body: string,
  status = 200,
): {
  readonly fetchImpl: typeof fetch;
  readonly requests: { url: URL; headers: Record<string, string> }[];
} {
  const requests: { url: URL; headers: Record<string, string> }[] = [];
  return {
    requests,
    fetchImpl: ((url: URL, init: { headers: Record<string, string> }) => {
      requests.push({ url, headers: init.headers });
      return Promise.resolve(new Response(body, { status, headers: { "content-type": "text/plain" } }));
    }) as unknown as typeof fetch,
  };
}

function options(fetchImpl: typeof fetch, written: string[]): LaneReadCommandOptions {
  return {
    env: { CLANKIE_CONTROL_PLANE_URL: "http://127.0.0.1:4310" },
    operatorCredentialStore: credentialStore,
    stdout: { write: (chunk: string) => written.push(chunk) },
    fetchImpl,
  };
}

describe("clankie prompt", () => {
  it("prints the operator lane's prompt verbatim under the operator bearer", async () => {
    const written: string[] = [];
    const { fetchImpl, requests } = recorder("You are Clankie.\n\n## Persona\n\nThe seed guy.\n");

    const code = await runPromptCommand([], options(fetchImpl, written));

    expect(code).toBe(0);
    expect(requests[0]?.url.pathname).toBe("/v1/captain/prompt");
    expect(requests[0]?.url.search).toBe("?lane=operator");
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${OPERATOR_TOKEN}`);
    // Verbatim: a system prompt is not reformatted on its way out.
    expect(written.join("")).toBe("You are Clankie.\n\n## Persona\n\nThe seed guy.\n");
  });

  it("asks for named sections and a named lane", async () => {
    const written: string[] = [];
    const { fetchImpl, requests } = recorder("persona\nmodel\n");

    const code = await runPromptCommand(
      ["--lane", "discord_voice", "--sections", "persona, model"],
      options(fetchImpl, written),
    );

    expect(code).toBe(0);
    expect(requests[0]?.url.searchParams.get("lane")).toBe("discord_voice");
    expect(requests[0]?.url.searchParams.get("sections")).toBe("persona,model");
  });

  it("refuses a lane or a section the captain has no meaning for", async () => {
    const written: string[] = [];
    const { fetchImpl, requests } = recorder("unused");

    await expect(runPromptCommand(["--lane", "twitch"], options(fetchImpl, written))).rejects.toThrow(
      /Usage/u,
    );
    await expect(
      runPromptCommand(["--sections", "identity,secrets"], options(fetchImpl, written)),
    ).rejects.toThrow(/Usage/u);
    await expect(runPromptCommand(["--lane"], options(fetchImpl, written))).rejects.toThrow(/Usage/u);
    expect(requests).toEqual([]);
    expect(written).toEqual([]);
  });

  it("says so plainly when this install holds no operator credential", async () => {
    const written: string[] = [];
    const { fetchImpl } = recorder("unused");

    await expect(
      runPromptCommand([], {
        env: {},
        operatorCredentialStore: {
          get: () => Promise.resolve(undefined),
        } as unknown as CredentialStore,
        stdout: { write: (chunk: string) => written.push(chunk) },
        fetchImpl,
      }),
    ).rejects.toThrow(/operator credential/u);
  });

  it("fails closed on a refusal without echoing the body", async () => {
    const written: string[] = [];
    const { fetchImpl } = recorder('{"error":"lane_forbidden"}', 403);

    await expect(runPromptCommand(["--lane", "gameplay"], options(fetchImpl, written))).rejects.toThrow(
      "clankie service returned 403",
    );
    expect(written).toEqual([]);
  });
});

describe("clankie memory-card", () => {
  it("reads the card that lane's next run would inject", async () => {
    const written: string[] = [];
    const { fetchImpl, requests } = recorder("## Recent\n\n- fixed the gateway\n");

    const code = await runMemoryCardCommand(["--lane", "discord_presence"], options(fetchImpl, written));

    expect(code).toBe(0);
    expect(requests[0]?.url.pathname).toBe("/v1/captain/memory-card");
    expect(requests[0]?.url.search).toBe("?lane=discord_presence");
    expect(written.join("")).toBe("## Recent\n\n- fixed the gateway\n");
  });

  it("prints an empty card as nothing at all", async () => {
    const written: string[] = [];
    const { fetchImpl, requests } = recorder("");

    expect(await runMemoryCardCommand([], options(fetchImpl, written))).toBe(0);
    expect(requests[0]?.url.searchParams.get("lane")).toBe("operator");
    expect(written.join("")).toBe("");
  });

  it("takes no flag but the lane", async () => {
    const written: string[] = [];
    const { fetchImpl, requests } = recorder("unused");

    await expect(
      runMemoryCardCommand(["--sections", "persona"], options(fetchImpl, written)),
    ).rejects.toThrow(/Usage/u);
    await expect(
      runMemoryCardCommand(["--lane", "operator", "--extra"], options(fetchImpl, written)),
    ).rejects.toThrow(/Usage/u);
    expect(requests).toEqual([]);
  });
});

describe("the headless nouns", () => {
  it("routes both reads to stdout as text, with no JSON envelope around them", async () => {
    for (const noun of ["prompt", "memory-card"]) {
      const written: string[] = [];
      const errors: string[] = [];
      const { fetchImpl } = recorder("You are Clankie.\n");

      const exitCode = await runHeadlessCaptainCommand([noun], {
        repoRoot: "/unused",
        env: { CLANKIE_CONTROL_PLANE_URL: "http://127.0.0.1:4310" },
        operatorCredentialStore: credentialStore,
        stdout: { write: (chunk: string) => written.push(chunk) },
        stderr: { write: (chunk: string) => errors.push(chunk) },
        fetchImpl,
      });

      expect(exitCode).toBe(0);
      expect(errors).toEqual([]);
      expect(written.join("")).toBe("You are Clankie.\n");
    }
  });

  it("reports a usage error on stderr and exits 1", async () => {
    const written: string[] = [];
    const errors: string[] = [];
    const { fetchImpl } = recorder("unused");

    const exitCode = await runHeadlessCaptainCommand(["prompt", "--lane", "twitch"], {
      repoRoot: "/unused",
      env: { CLANKIE_CONTROL_PLANE_URL: "http://127.0.0.1:4310" },
      operatorCredentialStore: credentialStore,
      stdout: { write: (chunk: string) => written.push(chunk) },
      stderr: { write: (chunk: string) => errors.push(chunk) },
      fetchImpl,
    });

    expect(exitCode).toBe(1);
    expect(written).toEqual([]);
    expect(errors.join("")).toContain("Usage: clankie prompt");
  });
});
