import type { Socket } from "node:net";
import { expect, it } from "vitest";
import { localProofDiagnostics } from "../src/local-fleet-proof-log.ts";

// #574: a refusal with no reason of its own (native_initial_unavailable) names the last native
// observation that failed for that request, from the fixed vocabulary only.
it("adds the request's last native reason to a refusal's context, and forgets it on success", async () => {
  const warned: Record<string, unknown>[] = [];
  const logger = { warn: (fields: Record<string, unknown>) => void warned.push(fields), debug: () => {} };
  const log = localProofDiagnostics(logger as never, "fleet");
  // Not a loopback socket, so the caller lookup answers at once without the native helper.
  const socket = { remoteAddress: "10.0.0.2", localAddress: "10.0.0.1", destroyed: false } as Socket;
  const context = (requestId: string) =>
    ({ requestId, connectionId: "c1", route: "mcp", method: "POST", socket }) as const;
  const event = {
    schemaVersion: 1,
    stage: "fd_socket",
    reason: "socket_unavailable",
    errno: 0,
    attempt: 3,
    retry: false,
  } as const;

  log({ source: "native", checkpoint: "initial", event }, "w1:p1", context("r1"));
  await log({ source: "proof", reason: "native_initial_unavailable" }, "w1:p1", context("r1"));
  expect(warned.find((fields) => fields.event === "fleet.local_proof.refusal_context")).toMatchObject({
    requestId: "r1",
    reason: "native_initial_unavailable",
    lastNativeReason: "initial:fd_socket:socket_unavailable",
  });

  // A request that succeeded after a retry leaves nothing behind for a later refusal.
  warned.length = 0;
  log({ source: "transport", reason: "timeout" }, "w1:p1", context("r2"));
  log({ source: "proof_success" }, "w1:p1", context("r2"));
  await log({ source: "proof", reason: "not_member" }, "w1:p1", context("r2"));
  expect(warned.find((fields) => fields.event === "fleet.local_proof.refusal_context")).not.toHaveProperty(
    "lastNativeReason",
  );
});
