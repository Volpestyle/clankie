import { describe, expect, it } from "vitest";
import { HERDR_SOCKET_HEADER, OPERATOR_AGENT_STANCE_MAX_MS } from "@clankie/protocol";
import { parseStanceArgs, runStanceCommand } from "../src/command/stance.ts";

describe("parseStanceArgs", () => {
  it("takes the pose, the note, and a bounded deadline", () => {
    expect(parseStanceArgs(["stuck", "--note", "waiting on review", "--for", "60"], "w1:p2")).toEqual({
      herdrPaneId: "w1:p2",
      pose: "stuck",
      note: "waiting on review",
      ttlMs: 60_000,
    });
  });

  it("clamps a long deadline rather than refusing it", () => {
    expect(parseStanceArgs(["working", "--for", "99999"], "w1:p2").ttlMs).toBe(OPERATOR_AGENT_STANCE_MAX_MS);
  });

  it("refuses a pose the room has no meaning for", () => {
    expect(() => parseStanceArgs(["dancing"], "w1:p2")).toThrow(/Usage/u);
    expect(() => parseStanceArgs([], "w1:p2")).toThrow(/Usage/u);
  });
});

describe("runStanceCommand", () => {
  const credentialStore = {
    read: () => Promise.resolve({ token: "captain-token", createdAt: new Date().toISOString() }),
  } as never;

  it("never names a seat: the pane it is running in is the whole claim", async () => {
    let sent: Record<string, unknown> | undefined;
    const written: string[] = [];
    const code = await runStanceCommand(["thinking", "--note", "reading the failing test"], {
      env: {
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: "/tmp/chosen.sock",
        HERDR_PANE_ID: "w3:p4",
        CLANKIE_CAPTAIN_TOKEN: "captain-token",
      },
      captainCredentialStore: credentialStore,
      stdout: { write: (chunk: string) => written.push(chunk) },
      fetchImpl: ((_url: URL, init: { body: string; headers: HeadersInit }) => {
        expect(new Headers(init.headers).get(HERDR_SOCKET_HEADER)).toBe("/tmp/chosen.sock");
        sent = JSON.parse(init.body) as Record<string, unknown>;
        return Promise.resolve(
          new Response(JSON.stringify({ op: "state_stance", result: { outcome: "stated" } }), {
            headers: { "content-type": "application/json" },
          }),
        );
      }) as unknown as typeof fetch,
    });

    expect(code).toBe(0);
    expect(sent).toEqual({
      op: "state_stance",
      schemaVersion: 1,
      stance: { herdrPaneId: "w3:p4", pose: "thinking", note: "reading the failing test" },
    });
    expect(written.join("")).toContain("stated");
  });

  it("says plainly that there is no figure to move outside a pane", async () => {
    await expect(
      runStanceCommand(["working"], { env: {}, captainCredentialStore: credentialStore }),
    ).rejects.toThrow(/HERDR_PANE_ID/u);
  });
});
