import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it.each(["local-process", "remote-token"])(
  "%s hook writes context then acknowledges exact IDs",
  async (authentication) => {
    const root = await mkdtemp(join(tmpdir(), "worker-next-turn-"));
    const requests: Record<string, unknown>[] = [];
    const messageId = "10000000-0000-4000-8000-000000000001";
    const server = createServer(async (req, res) => {
      let input = "";
      for await (const chunk of req) input += chunk;
      const body = JSON.parse(input) as Record<string, unknown>;
      requests.push(body);
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          body.deliveredMessageIds
            ? { recorded: true }
            : {
                recorded: true,
                deliveryStage: "uncertain",
                additionalContext: "Clankie's answer",
                messageIds: [messageId],
              },
        ),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address() as { port: number };
      const directory = join(root, ".clankie", "links");
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "fleet.json"),
        JSON.stringify({
          schemaVersion: authentication === "local-process" ? 2 : 1,
          authentication,
          fleet: "default",
          socket: "/tmp/test-herdr.sock",
          token: "t".repeat(43),
          url: `http://127.0.0.1:${address.port}`,
        }),
      );
      const child = spawn(
        process.execPath,
        [join(import.meta.dirname, "../../../integrations/claude-plugin/worker/bin/seat-hook.mjs")],
        {
          env: {
            ...process.env,
            HOME: root,
            HERDR_PANE_ID: "w3:p8",
            HERDR_SOCKET_PATH: "/tmp/test-herdr.sock",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "session-1" }));
      const [code] = await once(child, "exit");
      expect(code).toBe(0);
      expect(JSON.parse(output)).toEqual({
        hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "Clankie's answer" },
      });
      expect(requests).toEqual([
        { schemaVersion: 1, event: "UserPromptSubmit", sessionId: "session-1" },
        {
          schemaVersion: 1,
          event: "UserPromptSubmit",
          sessionId: "session-1",
          deliveredMessageIds: [messageId],
        },
      ]);
    } finally {
      server.closeAllConnections();
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
