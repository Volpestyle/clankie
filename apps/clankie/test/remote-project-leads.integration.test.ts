import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { ConversationStore } from "../src/captain/conversations/store.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import * as census from "../src/captain/herdr-census.ts";
import { RemoteProjectLeads } from "../src/remote-project-leads.ts";
import { logger } from "../src/app/log.ts";

// Real launch, captain/store, settings and framed child pipes. The linked
// machine/SSH endpoint is a fixture; installed Windows native admission is live proof.
it("launches an approved Windows workspace through the real conversation store without a local captain fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-remote-launch-"));
  const cwd = "C:\\Users\\volpe\\repos\\kh2-multiplayer";
  const fleet = { id: "pc", session: "kh2-desktop", ssh: { host: "pc", shell: "powershell" as const } };
  const children: ChildProcess[] = [];
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  vi.spyOn(census, "readFleet").mockResolvedValue({ seats: [] });
  const captainTurns = vi.spyOn(ConversationStore.prototype, "runsCaptainTurns");
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    execution: {
      ...current.execution,
      connections: [{ ...fleet, machine: "pc", kind: "herdr", enabled: true, capabilities: ["code"] }],
    },
  }));
  for (const path of [
    "apps/tui/bin/remote-lead-mcp.js",
    "integrations/remote-lead/bootstrap.mjs",
    "integrations/claude-plugin/output-styles/clankie.md",
  ]) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), "fixture artifact");
  }
  const captain = createCaptain(
    {
      herdrAvailable: () => false,
      presence: { listSessions: async () => [] },
      embodiment: { getLiveSession: async () => undefined },
      browser: { catalog: async () => ({ available: false, tools: [] }) },
      mcp: { catalog: async () => [] },
    } as unknown as CaptainDeps,
    { repoRoot: root, stateDir: root, settings },
  );
  let approved = false;
  let transportCalls = 0;
  let malformedReply = false;
  const remoteWorkspace = vi.fn(async (id: string, path: string) => approved && id === "pc" && path === cwd);
  const leads = new RemoteProjectLeads({
    repoRoot: root,
    directory: join(root, "launches"),
    settings,
    captain,
    runtimes: {
      fleets: async () => [fleet],
      remoteWorkspace,
      requireAccess: async () => {},
      fleetStream: () => () => {
        const prepare = transportCalls++ % 2 === 0;
        const child = spawn(
          process.execPath,
          [
            "-e",
            prepare
              ? `
          const {createHash}=require('node:crypto'); let input='';
          process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk=>input+=chunk);
          process.stdin.on('end',()=>console.log(JSON.stringify({directory:'C:\\\\fixture-plugin',hash:createHash('sha256').update(input).digest('hex')})));
        `
              : `
          const {createInterface}=require('node:readline'); let frame=0;
          createInterface({input:process.stdin}).on('line', line=>{
            const input=JSON.parse(line);
            if(frame++===0) {
              if(input.cwd!==${JSON.stringify(cwd)}) process.exit(2);
              console.log(JSON.stringify({stage:'allocated',pane:'w1:p1',shell:{pid:123,startTime:'2026-10-09T00:00:00Z'}}));
            } else {
              if(typeof input.token!=='string'||!input.conversationId) process.exit(3);
              console.log(${malformedReply} ? 'echo:' + input.token.slice(0,10) : JSON.stringify({stage:'dispatched',pane:'w1:p1'}));
            }
          });
        `,
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        children.push(child);
        return child;
      },
    },
  });
  const issue = vi.spyOn(leads.delegations, "issue");
  const input = {
    schemaVersion: 1 as const,
    requestId: randomUUID(),
    fleet: "pc",
    workingDirectory: cwd,
    title: "KH2",
  };
  try {
    await expect(leads.launch(input, async () => {})).rejects.toThrow("owner-approved working directory");
    expect(transportCalls).toBe(0);
    approved = true;
    const launched = await leads.launch(input, async () => {});
    if (launched.stage !== "dispatched") console.info("Launch acceptance receipt", launched);
    expect(launched).toMatchObject({ stage: "dispatched", pane: "pc/w1:p1" });
    await expect(
      captain.serveOperatorConversation({
        op: "create",
        schemaVersion: 1,
        title: "Unapproved",
        scope: { kind: "workspace", workspaceId: cwd, machineId: "pc" },
      }),
    ).rejects.toThrow("approved lead launch");
    const conversationId = launched.conversationId as string;
    const conversation = await captain.serveOperatorConversation({
      op: "get",
      schemaVersion: 1,
      conversationId,
    });
    expect(conversation).toMatchObject({
      conversation: { title: "KH2", scope: { kind: "workspace", workspaceId: cwd, machineId: "pc" } },
    });
    expect(captain.seatContext(conversationId)).toEqual({ conversationId, cwd, machineId: "pc" });
    expect(
      captainTurns.mock.results.some(
        (result, index) => captainTurns.mock.calls[index]?.[0] === conversationId && result.value === false,
      ),
    ).toBe(true);
    expect(await leads.launch(input, async () => {})).toEqual(launched);
    expect(transportCalls).toBe(2); // Original request reconciliation never allocates again.
    await expect(captain.laneToolBank("operator", conversationId)).rejects.toThrow("seat-bound delegation");
    const issued = await issue.mock.results[0]!.value;
    const binding = issued.binding;
    const admitted = await leads.delegations.authorize(
      new Request("http://fixture/lead", { headers: { authorization: `Bearer ${issued.token}` } }),
      {
        fleet: "pc",
        pane: "w1:p1",
        current: () => true,
        validate: async () => true,
        projectProof: async () => ({
          ...binding,
          binding: { socketPath: "fixture-pipe", session: fleet.session },
          workspace: { machineId: "pc", platform: "windows", canonicalPath: cwd },
          processes: [{ pid: 456, startTime: "2026-10-09T00:00:01Z" }],
        }),
      },
    );
    expect(admitted).toBeDefined();
    const bank = await captain.laneToolBank("operator", conversationId, {
      owner: { conversationId },
      current: admitted!.current,
      authorize: admitted!.authorize,
    });
    expect(bank.tools.some((tool) => tool.name === "hire_agent")).toBe(true);
    await captain.serveOperatorConversation({
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        kind: "message",
        conversationId,
        surfaceClientId: "app",
        expectedRevision: 0,
        message: "No native seat attached",
      },
    });
    await vi.waitFor(async () => {
      const events = await readFile(join(root, "conversations", conversationId, "events.jsonl"), "utf8");
      expect(events).toContain("local captain fallback is forbidden");
    });
    malformedReply = true;
    const malformedInput = { ...input, requestId: randomUUID() };
    const malformed = await leads.launch(malformedInput, async () => {});
    expect(malformed).toMatchObject({
      stage: "unconfirmed",
      failedStage: "dispatching",
      error: "Remote lead reply is not valid JSON",
    });
    const failedGrant = await issue.mock.results[1]!.value;
    expect(leads.delegations.revoke(failedGrant.id)).toBe(false); // Failure already revoked it.
    expect(await readFile(join(root, "launches", `${malformedInput.requestId}.json`), "utf8")).not.toContain(
      failedGrant.token,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ failedStage: "dispatching", error: "Remote lead reply is not valid JSON" }),
      "Remote lead launch unconfirmed",
    );

    const failedInput = { ...input, requestId: randomUUID() };
    // Fail inside the journaled launch after reservation, not the initial approval.
    let guards = 0;
    const failed = await leads.launch(failedInput, async () => {
      if (++guards === 3) throw new Error("Preparation failed: authorization: Bearer private-fixture-secret");
    });
    expect(failed).toMatchObject({
      stage: "unconfirmed",
      failedStage: "reserved",
      error: "Preparation failed: authorization: [REDACTED]",
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ failedStage: "reserved", error: failed.error }),
      "Remote lead launch unconfirmed",
    );
    expect(await readFile(join(root, "launches", `${failedInput.requestId}.json`), "utf8")).not.toContain(
      "private-fixture-secret",
    );
  } finally {
    leads.delegations.close();
    for (const child of children) child.kill();
    await captain.close();
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
});
