import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNativeServer } from "node:net";
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

it.each(["missing", "missing-codex", "present", "unavailable", "wrong-id"])(
  "startup hook leaves a definitively missing inherited pane unclaimed (%s)",
  async (observation) => {
    const root = await mkdtemp(join(tmpdir(), "worker-hook-pane-"));
    const socketPath = join(root, "herdr.sock");
    const requests: string[] = [];
    const nativeRequests: { method: string; params: { pane_id: string } }[] = [];
    const native = createNativeServer((socket) => {
      let input = "";
      socket.on("data", (chunk) => {
        input += String(chunk);
        if (!input.includes("\n")) return;
        const request = JSON.parse(input);
        nativeRequests.push(request);
        if (observation === "unavailable") return socket.destroy();
        socket.end(
          `${JSON.stringify({
            id: observation === "wrong-id" ? "another-request" : request.id,
            ...(observation.startsWith("missing")
              ? { error: { code: "pane_not_found" } }
              : { result: { process_info: { pane_id: "w3:p8", shell_pid: 1234 } } }),
          })}\n`,
        );
      });
    });
    const service = createServer(async (request, response) => {
      for await (const _chunk of request) {
        /* Drain the actual hook request. */
      }
      requests.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ recorded: true }));
    });
    native.listen(socketPath);
    service.listen(0, "127.0.0.1");
    await Promise.all([once(native, "listening"), once(service, "listening")]);
    try {
      const directory = join(root, ".clankie", "links");
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "fleet.json"),
        JSON.stringify({
          schemaVersion: 2,
          authentication: "local-process",
          fleet: "default",
          socket: socketPath,
          url: `http://127.0.0.1:${(service.address() as { port: number }).port}`,
        }),
      );
      const child = spawn(
        process.execPath,
        [
          join(import.meta.dirname, "../../../integrations/claude-plugin/worker/bin/seat-hook.mjs"),
          ...(observation === "missing-codex" ? ["--codex"] : []),
        ],
        {
          env: {
            ...process.env,
            HOME: root,
            CLANKIE_STATE: join(root, ".clankie"),
            HERDR_PANE_ID: "w3:p8",
            HERDR_SOCKET_PATH: socketPath,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: "session-1" }));
      const [code] = await once(child, "close");
      expect(code).toBe(0);
      expect(nativeRequests).toHaveLength(1);
      expect(nativeRequests[0]).toMatchObject({ method: "pane.process_info", params: { pane_id: "w3:p8" } });
      expect(requests).toEqual(observation.startsWith("missing") ? [] : ["/v1/fleet/seats/w3%3Ap8/hook"]);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
    } finally {
      service.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => native.close(() => resolve())),
        new Promise<void>((resolve) => service.close(() => resolve())),
      ]);
      await rm(root, { recursive: true, force: true });
    }
  },
);
