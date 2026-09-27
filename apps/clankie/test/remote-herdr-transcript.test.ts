import { expect, it, vi } from "vitest";
import type { AgentSessionFile, AgentTranscriptHost } from "@clankie/agent-transcript";
import { remoteHerdrTranscriptReader } from "../src/captain/remote-herdr-transcript.ts";
import type { HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";

const path = "C:\\Users\\volpe\\.claude\\projects\\project\\session-1.jsonl";
const agent: HerdrAgentSnapshot = {
  paneId: "w1:p1",
  terminalId: "term1",
  agent: "claude",
  status: "idle",
  title: "Worker",
  session: { source: "herdr:claude", kind: "id", value: "session-1" },
};
function fixture() {
  let text =
    JSON.stringify({
      type: "assistant",
      uuid: "a1",
      parentUuid: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Remote answer" }],
      },
    }) + "\n";
  const files: AgentSessionFile[] = [{ harness: "claude", path, size: Buffer.byteLength(text), mtimeMs: 1 }];
  const host: AgentTranscriptHost = {
    id: "pc",
    list: vi.fn(async () => files),
    readBytes: vi.fn(async (requested, from, count) => {
      expect(requested).toBe(path);
      const bytes = Buffer.from(text);
      return { bytes: bytes.subarray(from, from + count), size: bytes.length };
    }),
  };
  return {
    host,
    files,
    append: () => {
      text +=
        JSON.stringify({
          type: "assistant",
          uuid: "a2",
          parentUuid: "a1",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "New answer" }],
          },
        }) + "\n";
    },
  };
}

it("reads the exact remote native session on demand and observes later appends", async () => {
  const { host, append } = fixture();
  const read = remoteHerdrTranscriptReader(host);
  expect(host.list).not.toHaveBeenCalled();
  expect(await read(agent)).toMatchObject({ entries: [{ type: "message", text: "Remote answer" }] });
  append();
  expect((await read(agent))?.entries).toHaveLength(2);
  expect(host.list).toHaveBeenCalledTimes(1);
});

it("does not read a prefix match, another harness, an ambiguous id, or an unlisted path", async () => {
  const { host, files } = fixture();
  const read = remoteHerdrTranscriptReader(host);
  expect(await read({ ...agent, session: { ...agent.session!, value: "session" } })).toBeUndefined();
  expect(await read({ ...agent, agent: "codex" })).toBeUndefined();
  expect(
    await read({ ...agent, session: { source: "herdr:claude", kind: "path", value: "C:\\secret.jsonl" } }),
  ).toBeUndefined();
  files.push({ ...files[0]!, path: path.replace("project", "other") });
  expect(await read(agent)).toBeUndefined();
  expect(host.readBytes).not.toHaveBeenCalled();
});

it("accepts a listed exact path and qualifies session identity by host", async () => {
  const { host } = fixture();
  const byPath = { ...agent, session: { source: "herdr:claude", kind: "path" as const, value: path } };
  const pc = await remoteHerdrTranscriptReader(host)(byPath);
  const mac = await remoteHerdrTranscriptReader({ ...host, id: "mac" })(byPath);
  expect(pc?.entries).toEqual(mac?.entries);
  expect(pc?.sessionKey).not.toBe(mac?.sessionKey);
});
