import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { RemoteCodexSeats } from "../src/remote-codex-seats.ts";
import { createRemoteProjectObserver } from "../src/remote-project-proof.ts";
import { peerSeatAuthority } from "../src/app/peer-seat-authority.ts";
import { startCodexAppServerSeat } from "../src/captain/codex-app-server.ts";
import { codex0160Protocol } from "./fixtures/codex-0160-protocol.ts";

it("recovers report/peer native proof after an unavailable inventory read, using the actual PC producer golden and native RPC", async () => {
  // Captured on Tess's owned wE:p2, Codex 0.160.1, 2026-10-06.
  // Kernel facts are a golden; controller inventory crosses a real WebSocket.
  // This replay confers no live Windows registration or socket authority.
  const observed = JSON.parse(
    await readFile(
      new URL(
        "../../../docs/testing/2026-10-06-remote-native-channels/sender-completion/pc-sender-probe.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const first = observed.first;
  const fleet = { id: "pc", session: "default", ssh: { host: "pc", shell: "powershell" as const } };
  const directory = await mkdtemp(join(tmpdir(), "remote-sender-rpc-"));
  const native = await codex0160Protocol(directory, { threadId: first.agent.agent_session.value });
  let alive = true;
  const seats = new RemoteCodexSeats(async () => fleet);
  const { cwd: _cwd, listeners: _listeners, ...server } = first.privateServer;
  const shell = first.processes.find((process: { pid: number }) => process.pid === first.info.shell_pid);
  const registration = seats.register(
    {
      fleet,
      pane: first.info.pane_id,
      binding: first.binding,
      shell: { pid: shell.pid, startTime: shell.startTime },
      server,
    },
    () => alive,
  );
  const controller = await startCodexAppServerSeat({
    cwd: directory,
    threadName: "Ada · PC acceptance",
    server: async (input) => ({ ...(await native.launch(input)), remoteRegistration: registration }),
    startView: async () => native.startView(),
  });
  try {
    await controller.send("Fresh owned native brief");
    const methods = native.requests.map(({ method }) => method);
    expect(methods.indexOf("thread/name/set")).toBeLessThan(methods.indexOf("turn/start"));
    expect(native.requests.find(({ method }) => method === "thread/name/set")?.params).toEqual({
      threadId: native.threadId,
      name: "Ada · PC acceptance",
    });
    native.finish("completed", "Native brief completed");
    const observe = createRemoteProjectObserver({
      fleet: async () => fleet,
      privateSeats: seats,
      shell: () => async () => JSON.stringify(observed),
    });
    const stream = { clientPort: 1, serverPort: 2, alive: () => alive };
    const identity = {
      fleet: fleet.id,
      pane: first.info.pane_id,
      validate: async () => alive,
      projectProof: () => observe(fleet.id, first.info.pane_id, stream),
    };
    native.nextLoadedInventory({ data: "unavailable", nextCursor: null });
    expect(await identity.projectProof()).toBeUndefined();
    expect(seats.server(fleet, identity.pane)).toEqual(server);
    native.nextLoadedInventory({ data: [native.threadId] });
    expect(await identity.projectProof()).toBeUndefined();
    expect(seats.server(fleet, identity.pane)).toEqual(server);
    const authority = await peerSeatAuthority(identity, identity.pane);
    expect(authority?.proof).toMatchObject({ privateSeat: true, fleet: "pc", pane: identity.pane });
    expect(await authority?.validate()).toBe(true);
    expect(await observe("pc", `pc/${identity.pane}`, stream)).toMatchObject({ privateSeat: true });
    native.nextLoadedInventory({ data: [native.threadId, "another-native-thread"], nextCursor: null });
    expect(await authority?.validate()).toBe(false);
    expect(seats.server(fleet, identity.pane)).toBeUndefined();
    expect(await identity.projectProof()).toBeUndefined();
    alive = false;
    expect(await peerSeatAuthority(identity, identity.pane)).toBeUndefined();
  } finally {
    await controller.close();
    registration.release();
    await native.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(["rejected", "existing"])("keeps native naming %s within the fresh managed root", async (kind) => {
  const directory = await mkdtemp(join(tmpdir(), "remote-sender-name-"));
  const native = await codex0160Protocol(
    directory,
    kind === "existing" ? { threadName: "Owner's existing name" } : { rejectName: true },
  );
  const seats = new RemoteCodexSeats(async () => undefined);
  const registration = seats.register(
    {
      fleet: { id: "pc", session: "default", ssh: { host: "pc", shell: "powershell" } },
      pane: "w1:p1",
      binding: { session: "default", socketPath: "C:\\herdr.sock" },
      shell: { pid: 10, startTime: "shell" },
      server: { pid: 20, startTime: "server", executable: "C:\\codex.exe", port: 45000 },
    },
    () => true,
  );
  let controller: Awaited<ReturnType<typeof startCodexAppServerSeat>> | undefined;
  try {
    const started = startCodexAppServerSeat({
      cwd: directory,
      threadName: "New hire name",
      server: async (input) => ({ ...(await native.launch(input)), remoteRegistration: registration }),
      startView: async () => native.startView(),
    });
    if (kind === "rejected") {
      await expect(started).rejects.toThrow("Native thread name was rejected");
      expect(native.requests.some(({ method }) => method === "turn/start" || method === "turn/steer")).toBe(
        false,
      );
    } else {
      controller = await started;
      expect(native.requests.some(({ method }) => method === "thread/name/set")).toBe(false);
    }
  } finally {
    await controller?.close();
    registration.release();
    await native.close();
    await rm(directory, { recursive: true, force: true });
  }
});
