import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { FileCredentialStore, ensureOperatorCredential } from "@clankie/credential-broker";
import { encodePNG, decodePNG } from "@clankie/lead-skin";
import {
  SKIN_DRAFTS_PATH,
  SkinDraftResultSchema,
  type SkinDraft,
  type SkinDraftCommand,
} from "@clankie/protocol/skin-drafts";
import { startFixtureServer } from "./owner-settings-surface-fixture.ts";
import { runSkinDraftCommand } from "../../tui/src/command/skin-draft.ts";

async function fixture(admitted = true) {
  const root = await mkdtemp(join(tmpdir(), "skin-generation-"));
  await mkdir(join(root, "config", "clankie"), { recursive: true });
  await writeFile(
    join(root, "config", "clankie", "clankie.json"),
    JSON.stringify({ image_model: "openai/gpt-image-2" }),
  );
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const credential = await ensureOperatorCredential({ env: {}, store: credentials });
  await credentials.set("openai", { type: "api", key: "local-fixture-only" });
  let calls = 0,
    holdAt = -1,
    failAt = -1;
  let release: (() => void) | undefined;
  const prompts: string[] = [];
  const providerApp = new Hono();
  providerApp.post("/v1/images/:action", async (context) => {
    const index = ++calls;
    if (context.req.param("action") === "edits") {
      const form = await context.req.formData();
      expect(form.get("image[]")).toBeInstanceOf(File);
      prompts.push(String(form.get("prompt")));
    } else prompts.push((await context.req.json()).prompt);
    if (index === holdAt)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    if (index === failAt) return context.json({ error: "upstream_result_lost" }, 503);
    // Mathematical primary-color sentinel, not generated character art.
    const rgba = Buffer.alloc(32 * 64 * 4);
    for (let y = 2; y < 63; y++) rgba.set([255, 0, 0, 255], (y * 32 + 13 + (index % 3)) * 4);
    return context.json({ data: [{ b64_json: encodePNG(32, 64, rgba).toString("base64") }] }, 200, {
      "x-request-id": `fixture-image-${index}`,
    });
  });
  const provider = await startFixtureServer(providerApp.fetch);
  let child: ChildProcess | undefined,
    host = "";
  const start = async () => {
    child = fork(
      new URL("./skin-generation-service-fixture.ts", import.meta.url),
      [root, provider.host, admitted ? "admitted" : "closed"],
      {
        execArgv: ["--import", import.meta.resolve("tsx")],
        env: { ...process.env, NODE_ENV: "test", VITEST: "true" },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    let stderr = "";
    child.stderr?.on("data", (bytes) => {
      stderr += String(bytes);
    });
    host = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(Error("Fixture startup timed out: " + stderr));
      }, 20_000);
      child!.once("exit", () => {
        clearTimeout(timeout);
        reject(Error("Fixture exited: " + stderr));
      });
      child!.on("message", (message) => {
        const ready = message as { kind?: string; host?: string };
        if (ready.kind === "ready" && ready.host) {
          clearTimeout(timeout);
          resolve(ready.host);
        }
      });
    });
  };
  const stop = async (crash = false) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    if (crash) child.kill("SIGKILL");
    else child.send("stop");
    const fallback = setTimeout(() => child?.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(fallback);
  };
  const raw = (command: SkinDraftCommand) =>
    fetch(host + SKIN_DRAFTS_PATH, {
      method: "POST",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify(command),
    });
  const command = async (input: SkinDraftCommand) => {
    const response = await raw(input);
    const value = await response.json();
    if (!response.ok) throw Error(JSON.stringify(value));
    const result = SkinDraftResultSchema.parse(value);
    if (result.outcome !== "draft") throw Error("Expected draft");
    return result.draft;
  };
  await start();
  return {
    root,
    prompts,
    start,
    stop,
    raw,
    command,
    calls: () => calls,
    hold: (at: number) => {
      holdAt = at;
    },
    release: () => release?.(),
    fail: (at: number) => {
      failAt = at;
    },
    create: () =>
      command({ action: "create", requestId: randomUUID(), description: "A tall red mathematical sentinel" }),
    cli: (...args: string[]) =>
      runSkinDraftCommand(args, { host, env: {}, operatorCredentialStore: credentials }),
    preview: async (draft: SkinDraft) => {
      const response = await fetch(
        `${host}${SKIN_DRAFTS_PATH}/${draft.id}/poses/rest/native?revision=${draft.revision}`,
        { headers: { authorization: `Bearer ${credential.token}` } },
      );
      expect(response.status).toBe(200);
      return decodePNG(Buffer.from(await response.arrayBuffer()));
    },
    close: async () => {
      release?.();
      await stop();
      await provider.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("takes a sentence through real media HTTP into editable poses and exact owner approval, retaining receipts after restart", async () => {
  const f = await fixture();
  try {
    const created = await f.create(),
      request = {
        action: "generate",
        draftId: created.id,
        expectedRevision: created.revision,
        requestId: randomUUID(),
      } as const;
    const result = await f.cli("generate", created.id, created.revision, "--request", request.requestId);
    if (result.outcome !== "draft") throw Error("Expected draft");
    let draft = result.draft;
    expect(draft).toMatchObject({ state: "awaiting_approval", generation: "complete" });
    expect(Object.keys(draft.poses)).toEqual(["rest", "work", "comms"]);
    expect((await f.preview(draft)).height).toBe(64);
    expect(
      draft.generations?.[0]?.steps.map((s) =>
        s.receipt?.outcome === "ok" ? s.receipt.providerRequestId : null,
      ),
    ).toEqual(["fixture-image-1", "fixture-image-2", "fixture-image-3"]);
    expect(f.calls()).toBe(3);
    expect(await readdir(join(f.root, "private-media", "generated"))).toEqual([]);
    expect(f.prompts.every((prompt) => prompt.includes(created.description))).toBe(true);
    await f.stop();
    await f.start();
    expect(await f.command(request)).toEqual(draft);
    expect(f.calls()).toBe(3);
    const approved = await f.command({
      action: "approve",
      draftId: draft.id,
      expectedRevision: draft.revision,
    });
    expect(approved.approval?.revision).toBe(draft.revision);
    draft = await f.command({
      action: "revise",
      draftId: draft.id,
      expectedRevision: approved.revision,
      description: "More like a taller red sentinel",
    });
    expect(draft.approval).toBeUndefined();
    await expect(
      f.command({ action: "approve", draftId: draft.id, expectedRevision: approved.revision }),
    ).rejects.toThrow("conflict");
    draft = await f.command({
      action: "generate",
      draftId: draft.id,
      expectedRevision: draft.revision,
      requestId: randomUUID(),
    });
    expect(draft.state).toBe("awaiting_approval");
    expect(f.calls()).toBe(6);
    expect(draft.generations).toHaveLength(2);
    expect(
      (await f.command({ action: "get", draftId: draft.id, version: created.version })).description,
    ).toBe(created.description);
  } finally {
    await f.close();
  }
}, 40_000);

it("never replays completed or uncertain provider work after an actual service crash", async () => {
  const f = await fixture();
  try {
    const draft = await f.create(),
      request = {
        action: "generate",
        draftId: draft.id,
        expectedRevision: draft.revision,
        requestId: randomUUID(),
      } as const;
    f.hold(2);
    const pending = f.raw(request).catch(() => undefined);
    await expect.poll(f.calls).toBe(2);
    const during = await f.command({ action: "get", draftId: draft.id });
    expect(during.generations?.[0]?.steps.map((s) => s.state)).toEqual(["complete", "dispatching"]);
    await f.stop(true);
    f.release();
    await pending;
    await f.start();
    const recovered = await f.command(request);
    expect(recovered.generation).toBe("uncertain");
    expect(recovered.generations?.[0]?.steps[0]?.receipt?.outcome).toBe("ok");
    expect(recovered.generations?.[0]?.steps[1]?.state).toBe("uncertain");
    expect(await f.command(request)).toEqual(recovered);
    await expect(
      f.command({ ...request, requestId: randomUUID(), expectedRevision: recovered.revision }),
    ).rejects.toThrow("reconciliation_required");
    expect(f.calls()).toBe(2);
  } finally {
    await f.close();
  }
}, 40_000);

it("retains a late media receipt without overwriting owner cancellation", async () => {
  const f = await fixture();
  try {
    const draft = await f.create();
    f.hold(1);
    const pending = f.command({
      action: "generate",
      draftId: draft.id,
      expectedRevision: draft.revision,
      requestId: randomUUID(),
    });
    await expect.poll(f.calls).toBe(1);
    const during = await f.command({ action: "get", draftId: draft.id });
    await f.command({ action: "cancel", draftId: draft.id, expectedRevision: during.revision });
    f.release();
    expect(await pending).toMatchObject({
      state: "cancelled",
      poses: {},
      generations: [{ steps: [{ state: "complete", detail: "draft_changed", receipt: { outcome: "ok" } }] }],
    });
    expect(f.calls()).toBe(1);
  } finally {
    await f.close();
  }
}, 30_000);

it("keeps paid generation closed when host admission has no approved credit policy", async () => {
  const f = await fixture(false);
  try {
    const draft = await f.create();
    const response = await f.raw({
      action: "generate",
      draftId: draft.id,
      expectedRevision: draft.revision,
      requestId: randomUUID(),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "skin_generation_credit_policy_required" });
    expect(await f.command({ action: "get", draftId: draft.id })).toEqual(draft);
    expect(f.calls()).toBe(0);
  } finally {
    await f.close();
  }
}, 30_000);

it("treats an ambiguous provider failure as uncertain and retains its media result without retrying", async () => {
  const f = await fixture();
  try {
    const draft = await f.create();
    f.fail(1);
    const request = {
      action: "generate",
      draftId: draft.id,
      expectedRevision: draft.revision,
      requestId: randomUUID(),
    } as const;
    const result = await f.command(request);
    expect(result).toMatchObject({
      generation: "uncertain",
      generations: [
        {
          state: "uncertain",
          steps: [{ state: "uncertain", receipt: { outcome: "refused", reason: "provider_failed" } }],
        },
      ],
    });
    await f.stop();
    await f.start();
    expect(await f.command(request)).toEqual(result);
    expect(f.calls()).toBe(1);
  } finally {
    await f.close();
  }
}, 30_000);
