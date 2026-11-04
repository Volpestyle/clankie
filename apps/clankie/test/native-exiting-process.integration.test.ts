// Manual, read-only real-kernel regression for #852. Run while a same-user
// process is stuck in kernel exit; the test never creates or signals that state.
// FLEET_PROOF_EXITING_TEST=1 clankie heavy -- pnpm exec vitest run <this file>
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { expect, it } from "vitest";
import { LocalFleetLink } from "../src/local-fleet-link.ts";
import { localFleetAdmissionProof } from "../src/local-fleet-proof.ts";
import { localProofDiagnostics } from "../src/local-fleet-proof-log.ts";
import { NativeProcessDiagnosticSchema } from "../src/local-fleet-process.ts";
import { closeNativeProcessObservers, nativeProcessRequest } from "../src/native-process-transport.ts";

const exec = promisify(execFile);
const native = it.skipIf(process.platform !== "darwin" || process.env.FLEET_PROOF_EXITING_TEST !== "1");

native(
  "refuses an owned loopback report with a bounded typed kernel-exit cause, retaining the possible sharer (#852)",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-exiting-proof-"));
    const helper = join(root, "native-proof");
    await exec("cc", [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-mmacosx-version-min=14.0",
      "-lproc",
      process.env.FLEET_PROOF_BASELINE_SOURCE ?? resolve("integrations/fleet-proof/native-process-proof.c"),
      "-o",
      helper,
    ]);
    const logs: Record<string, unknown>[] = [];
    const diagnostic = localProofDiagnostics(
      {
        warn: (fields: unknown) => {
          logs.push(fields as Record<string, unknown>);
        },
        debug: (fields: unknown) => {
          logs.push(fields as Record<string, unknown>);
        },
      },
      "fleet",
    );
    // No Herdr call can be reached: a complete native socket proof is required first.
    const binding = {
      runtime: "external" as const,
      session: "owned-fixture",
      socketPath: join(root, "unused.sock"),
    };
    const link = new LocalFleetLink({
      directory: join(root, "links"),
      binding: async () => binding,
      prove: localFleetAdmissionProof({
        binding: async () => binding,
        herdrBinary: "herdr",
        processHelper: helper,
        diagnostics: diagnostic,
      }),
    });
    let forwarded = 0;
    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: link.fetch(() => {
        forwarded++;
        return Response.json({ received: true });
      }),
    });
    await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw Error("Missing owned HTTP address");
      const replies: unknown[] = [];
      for (let call = 0; call < 2; call++) {
        const reply = await fetch(`http://127.0.0.1:${address.port}/v1/fleet/seats/w1%3Ap1/messages`, {
          method: "POST",
          headers: { "x-clankie-pane": "w1:p1", "content-type": "application/json" },
          body: JSON.stringify({ text: "This owned report must never be dispatched." }),
        });
        expect(reply.status).toBe(503);
        const value = await reply.json();
        expect(value).toMatchObject({
          error: "fleet_admission_unavailable",
          observation: "process_exiting",
          retryable: true,
        });
        replies.push(value);
      }
      expect(forwarded).toBe(0);
      const nativeEvents = logs
        .filter((row) => row.source === "native")
        .map((row) =>
          NativeProcessDiagnosticSchema.parse(
            Object.fromEntries(
              Object.entries(row).filter(
                ([key]) =>
                  !["event", "operation", "source", "checkpoint", "requestId", "connectionId"].includes(key),
              ),
            ),
          ),
        );
      const exits = nativeEvents.filter((event) => event.reason === "process_exiting");
      expect(exits).toHaveLength(2);
      expect(
        nativeEvents.some(
          (event) => event.reason === "attempts_exhausted" || event.reason === "budget_exhausted",
        ),
      ).toBe(false);
      for (const event of exits)
        expect(event).toMatchObject({
          reason: "process_exiting",
          errno: 3,
          attempt: 1,
          retry: false,
          exitingProcess: { pid: expect.any(Number), birth: expect.any(Array) },
        });
      const process = exits[0]!.exitingProcess!;
      expect(exits[1]!.exitingProcess).toEqual(process);
      if (globalThis.process.env.FLEET_PROOF_EXITING_PID)
        expect(process.pid).toBe(Number(globalThis.process.env.FLEET_PROOF_EXITING_PID));
      for (const value of replies) {
        expect(JSON.stringify(value)).not.toContain(String(process.pid));
        expect(value).not.toHaveProperty("exitingProcess");
      }
      const contexts = logs.filter((row) => row.event === "fleet.local_proof.refusal_context");
      expect(contexts).toHaveLength(2);
      const first = contexts[0]!.exitingProcess as Record<string, unknown>;
      const second = contexts[1]!.exitingProcess as Record<string, unknown>;
      expect(first).toMatchObject({
        ...process,
        firstObservedAt: expect.any(String),
        observedAt: expect.any(String),
      });
      expect(second).toMatchObject({ ...process, firstObservedAt: first.firstObservedAt });
      // The independent account cwd census (#850) must refuse the very same
      // possible user process, never return an incomplete inventory for cleanup.
      const cwd = await nativeProcessRequest(helper, ["--cwds", "--diagnostics"]);
      expect(cwd?.stdout).toBe("");
      const prefix = "Native process proof diagnostic: ";
      const cwdEvents = cwd!.stderr
        .split("\n")
        .filter((line) => line.startsWith(prefix))
        .map((line) => NativeProcessDiagnosticSchema.parse(JSON.parse(line.slice(prefix.length))));
      const cwdExits = cwdEvents.filter((event) => event.reason === "process_exiting");
      expect(cwdExits).toHaveLength(1);
      expect(
        cwdEvents.some(
          (event) => event.reason === "attempts_exhausted" || event.reason === "budget_exhausted",
        ),
      ).toBe(false);
      expect(cwdExits[0]).toMatchObject({
        reason: "process_exiting",
        attempt: 1,
        retry: false,
        exitingProcess: process,
      });
      await writeFile(
        resolve(".local/native-exiting-evidence.json"),
        JSON.stringify({ replies, forwarded, nativeEvents, contexts, cwdEvents }, null, 2) + "\n",
      );
    } finally {
      await closeNativeProcessObservers();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
