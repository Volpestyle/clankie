import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createClankieApp } from "../../clankie/src/app.ts";
import { ConversationStore } from "../../clankie/src/captain/conversations.ts";
import { createStubCaptain } from "../../clankie/src/captain/port.ts";
import { planSeat, runSeatCommand } from "../src/command/seat.ts";

it.each([
  ["claude", "named"],
  ["claude", "legacy"],
  ["opencode", "named"],
  ["opencode", "legacy"],
] as const)(
  "%s %s launches take the free global chat, else separate app chats, and resume their binding",
  async (harness, route) => {
    const seatArgs = route === "legacy" ? ["--harness", harness] : [];
    const root = await mkdtemp(join(tmpdir(), "clankie-seat-isolation-"));
    const conversations = new ConversationStore(join(root, "conversations"), async () => {});
    const launches: Array<{ conversationId: string; sessionId: string; cwd: string }> = [];
    const occupied = new Set<string>();
    const token = `clankie_op_${"a".repeat(43)}`;
    const clankie = await createClankieApp({
      captain: createStubCaptain({
        serveOperatorConversation: async (request) => {
          if (request.op !== "create") throw new Error("unexpected dispatch");
          return conversations.serve(request);
        },
        seatContext: (id = "global-default") => {
          const conversation = conversations.conversation(id);
          return conversation === undefined
            ? undefined
            : {
                conversationId: id,
                cwd: conversation.scope.kind === "workspace" ? conversation.scope.workspaceId : process.cwd(),
              };
        },
        operatorSeatReady: (id = "global-default") => occupied.has(id),
        syncSeatTranscript: (id, upload) =>
          conversations.syncNativeSeatTranscript(id, upload.sessionId, upload.entries, upload.activity),
      }),
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === `Bearer ${token}` ? { operatorId: "fixture" } : undefined,
    });
    const env = {
      XDG_STATE_HOME: root,
      CLANKIE_SETTINGS_FILE: join(root, "settings.json"),
      CLAUDE_CONFIG_DIR: root,
      HOME: root,
      CLANKIE_OPERATOR_TOKEN: token,
      CLANKIE_CONVERSATION_ID: "global-default",
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p2",
      HERDR_SOCKET_PATH: "/tmp/fleet.sock",
    };
    const options = {
      ...(route === "named" ? { harnessCommand: harness } : {}),
      repoRoot: join(import.meta.dirname, "../../.."),
      env,
      execFileImpl: async (command: string, args: readonly string[]) => {
        expect(command).toBe(harness);
        return {
          stdout:
            harness === "claude"
              ? "Claude Code"
              : args[0] === "--version"
                ? "1.18.29"
                : "--session --port --hostname",
          stderr: "",
        };
      },
      fetchImpl: (async (url, init) => {
        const parsed = new URL(String(url));
        return clankie.app.request(`${parsed.pathname}${parsed.search}`, init);
      }) as typeof fetch,
      spawnImpl: async (
        _command: string,
        _args: readonly string[],
        cwd: string,
        childEnv?: NodeJS.ProcessEnv,
      ) => {
        let sessionId = childEnv!.CLANKIE_SEAT_SESSION_ID!;
        if (harness === "opencode") {
          sessionId = _args.includes("--session") ? _args.at(-1)! : `ses_${randomUUID().replaceAll("-", "")}`;
          const bound = await fetch(childEnv!.CLANKIE_OPENCODE_BRIDGE! + "/bind", {
            method: "POST",
            headers: {
              authorization: `Bearer ${childEnv!.CLANKIE_OPENCODE_BRIDGE_TOKEN}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ sessionId }),
          });
          expect(bound.status).toBe(200);
          expect(_args[0]).toBe(cwd);
          expect(childEnv!.CLANKIE_OPERATOR_TOKEN).toBeUndefined();
        }
        launches.push({
          cwd,
          conversationId: childEnv!.CLANKIE_CONVERSATION_ID!,
          sessionId,
        });
        return 0;
      },
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    };
    try {
      const free = await planSeat({ harness, resume: false, dryRun: true }, options);
      expect(free.conversationId).toBe("global-default");
      expect(free.newConversation).toBeUndefined();
      await runSeatCommand(seatArgs, options);
      expect(launches.splice(0)).toMatchObject([{ conversationId: "global-default" }]);
      // A live seat's channel holds the global chat; later launches get their own.
      occupied.add("global-default");
      const dry = await planSeat({ harness, resume: false, dryRun: true }, options);
      expect(dry.newConversation?.scope).toEqual({ kind: "workspace", workspaceId: process.cwd() });
      expect(dry.herdrPaneId).toBeUndefined();
      expect(await conversations.serve({ op: "list", schemaVersion: 1 })).toMatchObject({
        conversations: [{ conversationId: "global-default" }],
      });
      await Promise.all([runSeatCommand(seatArgs, options), runSeatCommand(seatArgs, options)]);
      expect(new Set(launches.map((launch) => launch.conversationId)).size).toBe(2);
      expect(new Set(launches.map((launch) => launch.sessionId)).size).toBe(2);
      for (const [index, launch] of launches.entries()) {
        expect(launch.conversationId).not.toBe("global-default");
        expect(conversations.conversation(launch.conversationId)?.scope).toEqual({
          kind: "workspace",
          workspaceId: process.cwd(),
        });
        const synced = await options.fetchImpl(
          `http://localhost/v1/seat/transcript?conversationId=${launch.conversationId}`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({
              sessionId: launch.sessionId,
              entries: [{ type: "message", id: "same-native-entry", role: "agent", text: `seat ${index}` }],
            }),
          },
        );
        expect(synced.status).toBe(200);
      }
      for (const [index, launch] of launches.entries()) {
        const replay = await conversations.serve({
          op: "replay",
          schemaVersion: 1,
          replay: {
            schemaVersion: 1,
            conversationId: launch.conversationId,
            surfaceClientId: "test",
            limit: 100,
          },
        });
        expect(replay).toMatchObject({ result: { events: [{ type: "message", text: `seat ${index}` }] } });
      }
      const saved = JSON.parse(
        await readFile(
          join(root, harness === "claude" ? "clankie/seat.json" : "clankie/opencode-seat.json"),
          "utf8",
        ),
      );
      await runSeatCommand([...seatArgs, "--resume"], options);
      expect(launches.at(-1)).toEqual({
        conversationId: saved.conversationId,
        sessionId: saved.sessionId,
        cwd: saved.cwd,
      });
      await expect(
        runSeatCommand([...seatArgs, "--resume", "--conversation", "global-default"], options),
      ).rejects.toThrow(/keeps its conversation|cannot change its conversation/);
      const listed = await conversations.serve({ op: "list", schemaVersion: 1 });
      expect(listed.op === "list" && listed.conversations.length).toBe(3);
      const codex = await planSeat(
        { harness: "codex", resume: false, dryRun: false },
        {
          ...options,
          harnessCommand: "codex",
          execFileImpl: async () => ({ stdout: "Codex CLI", stderr: "" }),
          trackerOverrides: async () => [],
        },
      );
      expect(codex.conversationId).toBeUndefined();
      expect(codex.newConversation?.scope).toEqual({ kind: "workspace", workspaceId: process.cwd() });
      occupied.clear();
      await runSeatCommand([...seatArgs, "--new"], options);
      expect(launches.at(-1)?.conversationId).not.toBe("global-default");
      expect(conversations.conversation(launches.at(-1)!.conversationId)?.scope).toEqual({
        kind: "workspace",
        workspaceId: process.cwd(),
      });
      const beforeFailure = launches.length;
      await expect(
        runSeatCommand(seatArgs, {
          ...options,
          fetchImpl: async () => new Response(null, { status: 503 }),
        }),
      ).rejects.toThrow("Seat conversation unavailable (503)");
      expect(launches).toHaveLength(beforeFailure);
    } finally {
      clankie.close();
      await rm(root, { force: true, recursive: true });
    }
  },
);
