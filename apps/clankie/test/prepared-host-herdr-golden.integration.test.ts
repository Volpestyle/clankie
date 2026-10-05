import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  createPreparedNativeHost,
  type PreparedNativeRoot,
  type PreparedNativeSession,
} from "../src/captain/prepared-native-host.ts";

// Real Unix transport and libproc process boundary; Herdr response is a
// golden from the real 0.9.3 socket, not evidence of invoking OpenCode/Pi here.
test.skipIf(process.platform !== "darwin").each(["grok", "opencode", "pi"] as const)(
  "reported Herdr 0.9.3 %s pane without top-level agent binds; contradictions revoke",
  async (harness) => {
    const directory = await realpath(await mkdtemp("/tmp/herdr-golden-"));
    const socketPath = join(directory, "herdr.sock");
    const executable = await realpath(process.execPath);
    const processFixture = spawn(
      executable,
      [
        "-e",
        "process.on('message', (cwd) => { process.chdir(cwd); process.send({cwd}); }); process.send('ready');",
      ],
      { cwd: directory, stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    const ready = once(processFixture, "message");
    const changeDirectory = async (cwd: string) => {
      const changed = once(processFixture, "message");
      processFixture.send(cwd);
      expect((await changed)[0]).toEqual({ cwd });
    };
    let lastRoot: PreparedNativeRoot | undefined;
    let lastSession: PreparedNativeSession | undefined;
    const golden = JSON.parse(
      await readFile(new URL("./fixtures/herdr-0.9.3-reported-pane.json", import.meta.url), "utf8"),
    );
    let pane = structuredClone(golden.pane);
    let pid = processFixture.pid!;
    const server = createServer((socket) => {
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk;
        if (!text.includes("\n")) return;
        const request = JSON.parse(text.split("\n")[0]!);
        let result: unknown;
        if (request.method === "pane.process_info")
          result = {
            type: "pane_process_info",
            process_info: { pane_id: pane.pane_id, shell_pid: pid, foreground_process_group_id: pid },
          };
        if (request.method === "pane.get") result = { type: "pane_info", pane };
        if (request.method === "pane.report_agent") {
          pane.agent_session = {
            source: request.params.source,
            agent: request.params.agent,
            kind: request.params.agent_session_id ? "id" : "path",
            value: request.params.agent_session_id ?? request.params.agent_session_path,
          };
          result = { type: "ok" };
        }
        socket.end(JSON.stringify({ id: request.id, result }) + "\n");
      });
    });
    try {
      expect((await ready)[0]).toBe("ready");
      const changedDirectory = join(directory, "changed");
      await mkdir(changedDirectory);
      await new Promise<void>((resolve, reject) => {
        server.listen(socketPath, resolve);
        server.once("error", reject);
      });
      pane = structuredClone(golden.pane);
      delete pane.agent;
      delete pane.agent_session;
      const host = createPreparedNativeHost({
        harness,
        binding: async () => ({ runtime: "external" as const, session: "golden", socketPath }),
        processHelper: fileURLToPath(
          new URL("../../../integrations/opencode-plugin/process-birth.py", import.meta.url),
        ),
      });
      const root = await host.capture(pane.pane_id, executable, directory);
      const session: PreparedNativeSession =
        harness === "pi"
          ? { source: "herdr:pi", kind: "path", value: join(directory, "native.jsonl") }
          : harness === "grok"
            ? golden.pane.agent_session
            : { source: "herdr:opencode", kind: "id", value: "ses_golden1234" };
      await root.report(session, "idle");
      expect(await root.proof(session)).toMatchObject({ pane: pane.pane_id, shell: { pid } });
      // A real cwd change revokes the same process; restoring it permits
      // another fresh proof. No cached or caller-provided cwd is admitted.
      await changeDirectory(changedDirectory);
      await expect(root.proof(session)).rejects.toThrow("cwd changed");
      await changeDirectory(directory);
      await expect(root.proof(session)).resolves.toBeDefined();
      pane.agent = harness;
      await expect(root.proof(session)).resolves.toBeDefined();
      pane.agent_session.agent = "contradictory";
      await expect(root.proof(session)).rejects.toThrow("allocation changed");
      pane.agent_session.agent = harness;
      pane.agent = "contradictory";
      await expect(root.proof(session)).rejects.toThrow("allocation changed");
      pane.agent = null;
      await expect(root.proof(session)).rejects.toThrow("allocation changed");
      delete pane.agent;
      delete pane.agent_session.agent;
      await expect(root.proof(session)).rejects.toThrow("allocation changed");
      pane.agent_session.agent = harness;
      for (const field of ["source", "kind", "value"] as const) {
        const saved = pane.agent_session[field];
        pane.agent_session[field] = "replacement";
        await expect(root.proof(session)).rejects.toThrow("allocation changed");
        pane.agent_session[field] = saved;
      }
      const terminal = pane.terminal_id;
      pane.terminal_id = "replacement";
      await expect(root.proof(session)).rejects.toThrow("allocation changed");
      pane.terminal_id = terminal;
      pid += 1;
      await expect(root.proof(session)).rejects.toThrow("allocation changed");
      pid -= 1;
      lastRoot = root;
      lastSession = session;
      const exited = once(processFixture, "exit");
      processFixture.kill();
      await exited;
      await expect(lastRoot!.proof(lastSession!)).rejects.toThrow();
    } finally {
      if (processFixture.exitCode === null && processFixture.signalCode === null) {
        const exited = once(processFixture, "exit");
        processFixture.kill();
        await exited;
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
