import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import {
  type OperatorConversationServiceRequest,
  type OperatorTerminalObservationRequest,
  createOperatorConversationServiceClient,
  OperatorConversationServiceResultSchema,
} from "@clankie/protocol";
import { ExecutionConnections } from "../src/herdr-session.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { createClankieApp } from "../src/app.ts";

it("routes duplicate terminal IDs to pinned connections across restart, disconnect and endpoint changes", async () => {
  const root = await mkdtemp("/tmp/clankie-terminal-routes-");
  const log = join(root, "calls.jsonl");
  // A controlled CLI speaks the real census, observer and controller protocols.
  await writeFile(
    join(root, "herdr"),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const socket = process.env.HERDR_SOCKET_PATH;
const record = (extra = {}) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args, socket, inheritedPane: process.env.HERDR_PANE_ID, ...extra})+'\\n');
record();
const pane = {pane_id:'p1', terminal_id:'same-terminal', workspace_id:'w1', tab_id:'t1', agent:'codex', title:'Worker'};
const emit = value => console.log(JSON.stringify(value));
if (args[0] === 'api') emit({result:{snapshot:{workspaces:[{workspace_id:'w1',label:'Work',number:1}],tabs:[{tab_id:'t1',label:'Agents',number:1}],panes:[pane]}}});
else if (args[0] === 'pane' && args[1] === 'list') emit({result:{panes:[pane]}});
else if (args[0] === 'pane' && args[1] === 'layout') {
  const finish = () => emit({result:{layout:{panes:[{pane_id:'p1',rect:{width:80,height:24}}]}}});
  if (fs.existsSync(${JSON.stringify(join(root, "hold-layout"))})) {
    const timer = setInterval(()=>{ if (fs.existsSync(${JSON.stringify(join(root, "release-layout"))})) { clearInterval(timer); finish(); } }, 5);
  } else finish();
}
else if (args[0] === 'terminal') {
  if (args[2] === 'observe') emit({type:'terminal.frame',seq:1,encoding:'ansi',width:80,height:24,full:true,bytes:Buffer.from(socket).toString('base64')});
  else require('node:readline').createInterface({input:process.stdin}).on('line',line=>record({input:JSON.parse(line)}));
  process.on('SIGTERM',()=>{record({closed:true});process.exit(0)});
  setInterval(()=>{},1000);
}
`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${root}:${process.env.PATH}`);
  vi.stubEnv("HERDR_SOCKET_PATH", "/tmp/ambient.sock");
  vi.stubEnv("HERDR_PANE_ID", "unrelated-pane");
  const settings = new SettingsStore(join(root, "settings.json"));
  const runtimes = new ExecutionConnections({
    settings,
    primary: { binding: () => undefined, status: () => "disabled" },
  });
  await runtimes.connect({ id: "alpha", session: "one", socketPath: "/tmp/alpha.sock" });
  await runtimes.connect({ id: "beta", session: "two", socketPath: "/tmp/beta.sock" });
  const open = async () => {
    const captain = createCaptain({ herdrAvailable: () => false, runtimes } as unknown as CaptainDeps, {
      repoRoot: root,
      stateDir: root,
      settings,
    });
    const app = await createClankieApp({
      captain,
      authenticateCaptain: async () => ({ captainId: "operator", steerSourceLane: "api" }),
    });
    const dispatch = async (request: OperatorConversationServiceRequest) => {
      const response = await app.app.request("/operator/v1/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      expect(response.status).toBe(200);
      return OperatorConversationServiceResultSchema.parse(await response.json());
    };
    const client = createOperatorConversationServiceClient(dispatch);
    const tail = async (observation: OperatorTerminalObservationRequest) => {
      const result = await dispatch({ op: "terminal_tail", schemaVersion: 1, observation });
      if (result.op !== "terminal_tail") throw new Error("Unexpected result");
      return result.result;
    };
    return {
      client,
      tail,
      close: async () => {
        app.close();
        await captain.close();
      },
    };
  };
  let service = await open();
  const calls = async () =>
    (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const surfaceClientId = "phone";
  try {
    const sessions = await service.client.terminalCatalog!();
    expect(sessions.map((row) => row.runtime)).toEqual([
      { id: "alpha", session: "one" },
      { id: "beta", session: "two" },
    ]);
    expect(sessions.map((row) => row.workspace.id)).toEqual(["w1", "w1"]);
    const [alpha, beta] = sessions.map((row) => row.terminalId);
    expect(alpha).not.toBe(beta);
    expect(JSON.stringify(sessions)).not.toMatch(/sock|ambient|unrelated-pane/u);
    const granted = await service.client.terminalControl!({
      schemaVersion: 1,
      terminalId: beta!,
      surfaceClientId,
      action: "request",
    });
    expect(granted.status).toBe("granted");
    if (granted.status !== "granted") throw new Error("grant missing");
    expect(granted.grant.terminalId).toBe(beta);
    const input = {
      schemaVersion: 1 as const,
      terminalId: beta!,
      surfaceClientId,
      leaseToken: granted.grant.leaseToken,
      dataBase64: Buffer.from("hello").toString("base64"),
    };
    expect((await service.client.terminalInput!(input)).status).toBe("delivered");
    expect((await service.client.terminalInput!({ ...input, terminalId: alpha! })).status).toBe("denied");
    await vi.waitFor(async () =>
      expect((await calls()).filter((row) => row.input).map((row) => row.socket)).toEqual(["/tmp/beta.sock"]),
    );
    const observation = { schemaVersion: 1 as const, terminalId: beta!, surfaceClientId };
    const page = await service.tail(observation);
    expect(page.status).toBe("page");
    if (page.status !== "page") throw new Error("page missing");
    expect(page.terminalId).toBe(beta);
    expect(page.frames[0]?.terminalId).toBe(beta);
    expect(Buffer.from(page.frames[0]!.data, "base64").toString()).toContain("/tmp/beta.sock");
    await service.close();
    service = await open();
    // No catalog call needed to recover a device's previously issued address.
    expect((await service.tail({ ...observation, cursor: page.cursor })).status).toBe("reset");
    expect((await service.client.terminalInput!(input)).status).toBe("denied");
    expect((await service.tail(observation)).status).toBe("page");
    const renewed = await service.client.terminalControl!({
      schemaVersion: 1,
      terminalId: beta!,
      surfaceClientId,
      action: "request",
    });
    if (renewed.status !== "granted") throw new Error("fresh lease missing");
    input.leaseToken = renewed.grant.leaseToken;
    await runtimes.disconnect("beta");
    await runtimes.connect({ id: "beta", session: "two", socketPath: "/tmp/beta.sock" });
    // Revocation is immediate even if no request observes the disabled interval.
    expect((await service.client.terminalInput!(input)).status).toBe("denied");
    await runtimes.disconnect("beta");
    expect((await service.client.terminalInput!(input)).status).toBe("unavailable");
    expect((await service.tail(observation)).status).toBe("unavailable");
    expect((await service.client.terminalCatalog!()).map((row) => row.runtime?.id)).toEqual(["alpha"]);
    await settings.update((current) => ({
      ...current,
      execution: {
        connections: current.execution.connections.map((row) =>
          row.id === "beta" ? { ...row, enabled: true, socketPath: "/tmp/replacement.sock" } : row,
        ),
      },
    }));
    expect((await service.tail(observation)).status).toBe("unavailable");
    const replacement = (await service.client.terminalCatalog!()).find((row) => row.runtime?.id === "beta")!;
    expect(replacement.terminalId).not.toBe(beta);
    await writeFile(join(root, "hold-layout"), "");
    const attaching = service.tail({ ...observation, terminalId: replacement.terminalId });
    await vi.waitFor(async () =>
      expect(
        (await calls()).some(
          (row) =>
            row.socket === "/tmp/replacement.sock" && row.args[0] === "pane" && row.args[1] === "layout",
        ),
      ).toBe(true),
    );
    await runtimes.disconnect("beta");
    await writeFile(join(root, "release-layout"), "");
    expect((await attaching).status).toBe("unavailable");

    expect(
      (
        await service.client.terminalControl!({
          schemaVersion: 1,
          terminalId: "rt:missing:invalid",
          surfaceClientId,
          action: "request",
        })
      ).status,
    ).toBe("unavailable");
    expect(
      (await calls()).every((row) => row.socket !== "/tmp/ambient.sock" && row.inheritedPane === undefined),
    ).toBe(true);
  } finally {
    await service.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
