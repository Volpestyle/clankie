import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { expect, test, vi } from "vitest";
import { runSeatHookCommand } from "../src/command/seat-hook.ts";

const SESSION = "10000000-0000-4000-8000-000000000001";
const TOKEN = "clankie_op_" + "a".repeat(43);
const stdin = (value: unknown) => Readable.from([JSON.stringify(value)]);

test("a hired seat's Stop reports its final text to the service for its own pane", async () => {
  const requests: { url: string; auth: string | null; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    requests.push({
      url: String(url),
      auth: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify({ schemaVersion: 1, recorded: true }));
  }) as unknown as typeof fetch;
  const env = { HERDR_PANE_ID: "w1:p1", CLANKIE_OPERATOR_TOKEN: TOKEN };
  await runSeatHookCommand([], {
    env,
    host: "http://127.0.0.1:1",
    fetchImpl,
    stdin: stdin({ hook_event_name: "Stop", session_id: SESSION, last_assistant_message: "Tests pass." }),
  });
  await runSeatHookCommand([], {
    env,
    host: "http://127.0.0.1:1",
    fetchImpl,
    stdin: stdin({ hook_event_name: "StopFailure", session_id: SESSION, error: "rate_limit" }),
  });
  expect(requests).toEqual([
    {
      url: "http://127.0.0.1:1/v1/fleet/seats/w1%3Ap1/hook",
      auth: `Bearer ${TOKEN}`,
      body: { schemaVersion: 1, event: "Stop", sessionId: SESSION, lastMessage: "Tests pass." },
    },
    {
      url: "http://127.0.0.1:1/v1/fleet/seats/w1%3Ap1/hook",
      auth: `Bearer ${TOKEN}`,
      body: { schemaVersion: 1, event: "StopFailure", sessionId: SESSION, error: "rate_limit" },
    },
  ]);
});

test("without the final text in the hook, the transcript's last reply is reported", async () => {
  const root = await mkdtemp(join(tmpdir(), "seat-hook-"));
  try {
    const transcript = join(root, `${SESSION}.jsonl`);
    await writeFile(
      transcript,
      [
        { type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "go" } },
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: "u1",
          message: { role: "assistant", content: [{ type: "text", text: "Finished the slugify task." }] },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n") + "\n",
    );
    let body: unknown;
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response("{}");
    }) as unknown as typeof fetch;
    await runSeatHookCommand([], {
      env: { HERDR_PANE_ID: "w1:p1", CLANKIE_OPERATOR_TOKEN: TOKEN },
      host: "http://127.0.0.1:1",
      fetchImpl,
      stdin: stdin({ hook_event_name: "Stop", session_id: SESSION, transcript_path: transcript }),
    });
    expect(body).toMatchObject({ event: "Stop", lastMessage: "Finished the slugify task." });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("outside a hired pane, or for a pane Clankie does not drive, nothing is reported", async () => {
  const fetchImpl = vi.fn(async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
  const hook = { hook_event_name: "Stop", session_id: SESSION };
  expect(await runSeatHookCommand([], { env: {}, fetchImpl, stdin: stdin(hook) })).toBe(0);
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(
    await runSeatHookCommand([], {
      env: { HERDR_PANE_ID: "w1:p9", CLANKIE_OPERATOR_TOKEN: TOKEN },
      host: "http://127.0.0.1:1",
      fetchImpl,
      stdin: stdin(hook),
    }),
  ).toBe(0);
  expect(fetchImpl).toHaveBeenCalledOnce();
});

test("a prompt's injected messages are acknowledged by exact ID on current and older hosts", async () => {
  const messageId = "10000000-0000-4000-8000-000000000002";
  for (const legacy of [false, true]) {
    const requests: Record<string, unknown>[] = [];
    const server = createServer(async (req, res) => {
      let input = "";
      for await (const chunk of req) input += chunk;
      const body = JSON.parse(input) as Record<string, unknown>;
      res.setHeader("content-type", "application/json");
      if (legacy && body.occurredAt !== undefined) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "invalid_request" }));
        return;
      }
      requests.push(body);
      res.end(
        JSON.stringify(
          body.deliveredMessageIds
            ? { recorded: true }
            : { recorded: true, additionalContext: "Clankie's answer", messageIds: [messageId] },
        ),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const output: string[] = [];
      const address = server.address() as { port: number };
      const code = await runSeatHookCommand([], {
        env: { HERDR_PANE_ID: "w1:p1", CLANKIE_OPERATOR_TOKEN: TOKEN },
        host: `http://127.0.0.1:${address.port}`,
        stdin: stdin({ hook_event_name: "UserPromptSubmit", session_id: SESSION }),
        stdout: { write: (text: string) => output.push(text) },
      });
      expect(code).toBe(0);
      expect(JSON.parse(output.join(""))).toEqual({
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "Clankie's answer" },
      });
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({ event: "UserPromptSubmit", sessionId: SESSION });
      expect(requests[1]).toEqual({ ...requests[0], deliveredMessageIds: [messageId] });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  }
});

test("a failed injected-message receipt leaves the hook successful after the context is written", async () => {
  const messageId = "10000000-0000-4000-8000-000000000003";
  const output: string[] = [];
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ recorded: true, additionalContext: "Clankie's answer", messageIds: [messageId] })),
    )
    .mockRejectedValueOnce(new TypeError("fetch failed")) as unknown as typeof fetch;
  try {
    const code = await runSeatHookCommand([], {
      env: { HERDR_PANE_ID: "w1:p1", CLANKIE_OPERATOR_TOKEN: TOKEN },
      host: "http://127.0.0.1:1",
      fetchImpl,
      stdin: stdin({ hook_event_name: "UserPromptSubmit", session_id: SESSION }),
      stdout: { write: (text: string) => output.push(text) },
    });
    expect(code).toBe(0);
    expect(JSON.parse(output.join(""))).toEqual({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "Clankie's answer" },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("hook receipt failed"));
  } finally {
    stderr.mockRestore();
  }
});
