// Manual native integration: owns an isolated Herdr daemon, never a live seat.
// A proven connection's later requests reuse its proof (VUH-2389, ADR 0217) only while
// its pane, Herdr binding, shell and owner lineage hold. Each case below changes one of
// them under a live, already-reused connection, and requires that the next request
// runs a full proof again (a whole-machine census or a full proof's refusal), with the
// refusal that proof reaches.
import { serve } from "@hono/node-server";
import { Server as HttpServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { LocalFleetLink } from "../src/local-fleet-link.ts";
import { localFleetProof } from "../src/local-fleet-proof.ts";
import { fleetProcessHelper } from "../src/local-fleet-process.ts";
import { isolatedHerdr } from "./fixtures/local-fleet-proof/herdr-fixture.ts";

const nativeIt = it.skipIf(process.platform !== "darwin" || process.env.FLEET_PROOF_NATIVE_TEST !== "1");
const checkout = fileURLToPath(new URL("../../../", import.meta.url));

/** A full proof leaves a socket-owner census or a refusal in diagnostics; reuse leaves neither. */
const fullProofs = (entries: readonly { source?: string }[]) =>
  entries.filter((entry) => entry.source === "socket_owner" || entry.source === "proof").length;

async function proven(name: string) {
  const logDirectory = join(checkout, ".local/proof-cost", `reuse-${name}-${Date.now()}`);
  await mkdir(logDirectory, { recursive: true });
  const helper = fleetProcessHelper(checkout);
  const herdr = await isolatedHerdr(logDirectory);
  const original = { runtime: "external" as const, socketPath: herdr.socketPath, session: "default" };
  const state: { binding: typeof original | undefined } = { binding: original };
  const trace: { source?: string; event?: { reason?: string } }[] = [];
  const prove = localFleetProof({
    herdrBinary: "herdr",
    processHelper: helper,
    binding: async () => state.binding,
    diagnostics: (event) => trace.push(event as (typeof trace)[number]),
    run: async (command, args, env) =>
      (await promisify(execFile)(command, args, { env, timeout: 5_000 })).stdout,
  });
  const link = new LocalFleetLink({
    directory: join(herdr.root, "links"),
    binding: async () => state.binding,
    prove: (socket, pane) => prove(socket, pane),
  });
  let effects = 0;
  const forward = link.fetch(() => {
    effects++;
    return Response.json({ forwarded: true });
  });
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request, env) => {
      const response = await forward(request, env);
      return Response.json(
        { ...(await response.json()), port: env.incoming.socket.remotePort, effects },
        { status: response.status },
      );
    },
  });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener port");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const close = async () => {
    await link.close();
    if (server instanceof HttpServer) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await herdr.close();
  };
  try {
    const ownerPid = await herdr.startClient("member", endpoint, true);
    // Proven once by a full census, then reused on the same connection.
    const cold = await herdr.request("member");
    expect(cold.status).toBe(200);
    expect(fullProofs(trace)).toBeGreaterThan(0);
    const reuseStart = trace.length;
    const reused = await herdr.request("member");
    expect(reused).toMatchObject({ status: 200, port: cold.port });
    expect(fullProofs(trace.slice(reuseStart))).toBe(0);
    /** The next request on the proven connection, and the full proofs it ran. */
    const next = async (client = "member", pane = herdr.pane) => {
      const start = trace.length;
      const reply = await herdr.request(client, pane);
      return { reply, fullProofs: fullProofs(trace.slice(start)), diagnostics: trace.slice(start) };
    };
    return { herdr, state, original, trace, endpoint, ownerPid, port: cold.port, next, close };
  } catch (error) {
    await close();
    throw error;
  }
}

nativeIt(
  "a proven connection that names another pane, or whose pane moved, is proven again and refused",
  async () => {
    const f = await proven("pane");
    try {
      // Its owner, lineage and shell are all intact; only the pane they prove changed.
      const other = await f.next("member", f.herdr.foreignPane);
      expect(other.fullProofs).toBeGreaterThan(0);
      expect(other.reply).toMatchObject({ status: 403, port: f.port });
      expect((await f.next()).reply.status).toBe(200);
      // Herdr keeps a pane's shell for its life, and resolves a pane moved to another
      // workspace from its old ID to its new one: the same shell, under a pane the proof
      // never named.
      const elsewhere = (await f.herdr.cli("workspace", "create", "--cwd", f.herdr.root, "--no-focus")).result
        .workspace.workspace_id as string;
      await f.herdr.cli("pane", "move", f.herdr.pane, "--workspace", elsewhere, "--new-tab");
      const moved = await f.next();
      expect(moved.fullProofs).toBeGreaterThan(0);
      expect(moved.reply).toMatchObject({ status: 403, port: f.port });
    } finally {
      await f.close();
    }
  },
  30_000,
);

nativeIt(
  "a proven connection held by an heir after its owner exits is proven again, and refused",
  async () => {
    const f = await proven("heir");
    try {
      const handoff = await f.herdr.request("member", f.herdr.pane, "handoff", "heir");
      expect(await f.herdr.waitForClient("heir")).toBe(handoff.coOwnerPid);
      await f.herdr.quitClient("member");
      await f.herdr.waitForExit(f.ownerPid);
      const { reply, fullProofs } = await f.next("heir");
      expect(fullProofs).toBeGreaterThan(0);
      expect(reply).toMatchObject({ status: 403, port: f.port, error: "local_process_membership_required" });
    } finally {
      await f.close();
    }
  },
  30_000,
);

nativeIt(
  "a proven connection is proven again when its Herdr binding changes, and refused while it is revoked",
  async () => {
    const f = await proven("binding");
    try {
      // The same Herdr core under another socket path is another binding.
      const alias = join(f.herdr.root, "alias.sock");
      await symlink(f.herdr.socketPath, alias);
      f.state.binding = { ...f.original, socketPath: alias };
      const changed = await f.next();
      expect(changed.fullProofs).toBeGreaterThan(0);
      expect(changed.reply).toMatchObject({ status: 200, port: f.port });
      f.state.binding = undefined;
      const revoked = await f.next();
      expect(revoked.fullProofs).toBeGreaterThan(0);
      expect(revoked.reply).toMatchObject({ status: 403, port: f.port });
      f.state.binding = f.original;
      const restored = await f.next();
      expect(restored.fullProofs).toBeGreaterThan(0);
      expect(restored.reply).toMatchObject({ status: 200, port: f.port });
    } finally {
      await f.close();
    }
  },
  30_000,
);

nativeIt(
  "a proven connection shared with a second holder is refused once it is proven again",
  async () => {
    const f = await proven("holder");
    try {
      const shared = await f.herdr.request("member", f.herdr.pane, "share");
      expect(shared.coOwnerPid).toBeGreaterThan(1);
      // ADR 0217's accepted residual: while the proven owner lives, a descriptor it hands
      // to another process after the proof is not seen until the connection is proven again.
      const unseen = await f.next();
      expect(unseen.fullProofs).toBe(0);
      expect(unseen.reply.status).toBe(200);
      // A failed recheck discards the connection's proof, so the next request is a full
      // proof, and that census sees both holders.
      f.state.binding = undefined;
      expect((await f.next()).reply.status).toBe(403);
      f.state.binding = f.original;
      const reproved = await f.next();
      expect(reproved.fullProofs).toBeGreaterThan(0);
      expect(reproved.reply).toMatchObject({
        status: 403,
        port: f.port,
        error: "local_process_membership_required",
      });
      expect(reproved.diagnostics).toContainEqual(
        expect.objectContaining({
          source: "native",
          event: expect.objectContaining({ reason: "multiple_owners" }),
        }),
      );
    } finally {
      await f.close();
    }
  },
  30_000,
);
