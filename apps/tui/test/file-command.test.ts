import { expect, it } from "vitest";
import { runFileCommand } from "../src/command/file.ts";

it("publishes one local path into the named conversation", async () => {
  const requests: unknown[] = [];
  const output: string[] = [];
  const file = {
    artifactId: "artifact-1",
    filename: "report.pdf",
    mediaType: "application/pdf",
    byteCount: 12,
    sha256: "0".repeat(64),
  };
  const exitCode = await runFileCommand(
    ["publish", "--conversation", "global-default", "build/report.pdf", "--name", "final-report.pdf"],
    {
      env: { CLANKIE_CAPTAIN_TOKEN: "test-captain" },
      fetchImpl: (async (_url: URL, init: RequestInit) => {
        requests.push(JSON.parse(String(init.body)) as unknown);
        return Response.json({ op: "publish_file", schemaVersion: 1, file });
      }) as typeof fetch,
      stdout: { write: (chunk: string) => output.push(chunk) },
    },
  );
  expect(exitCode).toBe(0);
  expect(requests).toEqual([
    {
      op: "publish_file",
      schemaVersion: 1,
      conversationId: "global-default",
      path: "build/report.pdf",
      filename: "final-report.pdf",
    },
  ]);
  expect(JSON.parse(output.join(""))).toEqual(file);
});
