import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  FileCredentialStore,
  ensureOperatorCredential,
  rotateOperatorCredential,
} from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { encodePNG, decodePNG, digest } from "@clankie/lead-skin";
import {
  SKIN_DRAFTS_PATH,
  SkinDraftResultSchema,
  isSkinDraftRoute,
  type SkinDraft,
  type SkinDraftCommand,
} from "@clankie/protocol/skin-drafts";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createCredentialBackedOperatorAuthenticator } from "../src/operator-auth.ts";
import { DeliveredFileStore } from "../src/delivered-files.ts";
import { skinDraftRoutes } from "../src/skin-draft-routes.ts";
import { SkinDraftService } from "../src/skin-drafts.ts";
import { skinDraftTool } from "../src/captain/skin-draft-tools.ts";
import type { TurnContext } from "../src/captain/tools.ts";
import type { QuestionAuthority } from "../src/captain/conversation-questions.ts";
import { startFixtureServer } from "./owner-settings-surface-fixture.ts";

const owner: QuestionAuthority = {
  principal: { kind: "operator", id: "diagnostic-owner" },
  current: () => true,
  authorize: async () => true,
};
const grid = { grid: { pitch: 1, columns: 32, rows: 64 }, colors: 2 };
function image() {
  // Mathematical primary-color sentinel, never character art or a sampled palette.
  const pixels = Buffer.alloc(32 * 64 * 4);
  for (let y = 2; y < 63; y++) pixels.set([255, 0, 0, 255], (y * 32 + 15) * 4);
  return encodePNG(32, 64, pixels);
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "skin-draft-"));
  const files = new DeliveredFileStore(join(root, "files"));
  const service = new SkinDraftService({ root: join(root, "drafts"), ownerId: owner.principal.id, files });
  async function upload(bytes = image()) {
    const conversationId = "diagnostic-conversation";
    const start = await files.beginUpload({
      conversationId,
      filename: "sentinel.png",
      mediaType: "image/png",
      byteCount: bytes.length,
      sha256: digest(bytes),
    });
    if (start.status !== "uploading") throw Error("Upload refused");
    await files.appendUpload({
      conversationId,
      uploadId: start.uploadId,
      offset: 0,
      dataBase64: bytes.toString("base64"),
    });
    const end = await files.commitUpload(conversationId, start.uploadId);
    if (end.status !== "committed") throw Error("Upload did not commit");
    return { conversationId, artifactId: end.file.artifactId };
  }
  async function command(command: SkinDraftCommand, authority = owner) {
    const result = await service.handle(authority, command);
    if (result.outcome !== "draft") throw Error("Expected draft");
    return result.draft;
  }
  async function ready() {
    const source = await upload();
    let draft = await command({
      action: "create",
      requestId: randomUUID(),
      description: "A tall primary-color sentinel",
    });
    for (const pose of ["rest", "work", "comms"] as const)
      draft = await command({
        action: "pose",
        draftId: draft.id,
        expectedRevision: draft.revision,
        pose,
        source,
        sampling: grid,
      });
    return { draft, source };
  }
  return {
    root,
    files,
    service,
    upload,
    command,
    ready,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

describe("owner key-pose draft boundary", () => {
  it("persists exact native poses and approval, invalidates edits, and reconciles restart/cancellation", async () => {
    const f = await fixture();
    try {
      const { draft: ready, source } = await f.ready();
      expect(ready).toMatchObject({ state: "awaiting_approval", generation: "not_requested", version: 4 });
      const preview = await f.service.preview(owner, ready.id, "rest", ready.revision, "native");
      expect([decodePNG(preview.bytes).width, decodePNG(preview.bytes).height]).toEqual([32, 64]);
      let draft = await f.command({ action: "approve", draftId: ready.id, expectedRevision: ready.revision });
      await f.files.removeConversation(source.conversationId);
      expect((await f.service.preview(owner, draft.id, "rest", draft.revision, "source")).sha256).toBe(
        draft.poses.rest!.source.sha256,
      );
      expect(draft.approval).toMatchObject({
        actor: owner.principal,
        revision: ready.revision,
        poseDigests: { rest: preview.sha256, work: preview.sha256, comms: preview.sha256 },
      });
      const restarted = new SkinDraftService({
        root: join(f.root, "drafts"),
        ownerId: owner.principal.id,
        files: new DeliveredFileStore(join(f.root, "files")),
      });
      expect(await restarted.handle(owner, { action: "get", draftId: draft.id })).toEqual({
        outcome: "draft",
        draft,
      });
      draft = await f.command({
        action: "revise",
        draftId: draft.id,
        expectedRevision: draft.revision,
        description: "Keep native height; update the brief",
      });
      expect(draft.state).toBe("awaiting_approval");
      expect(draft.approval).toBeUndefined();
      await expect(
        f.command({ action: "approve", draftId: draft.id, expectedRevision: ready.revision }),
      ).rejects.toThrow("skin_draft_conflict");
      draft = await f.command({
        action: "pose",
        draftId: draft.id,
        expectedRevision: draft.revision,
        pose: "rest",
        source,
        sampling: grid,
      });
      expect(Object.keys(draft.poses)).toEqual(["rest"]);
      await expect(
        f.command({ action: "approve", draftId: draft.id, expectedRevision: draft.revision }),
      ).rejects.toThrow("skin_draft_poses_required");
      draft = await f.command({ action: "decline", draftId: draft.id, expectedRevision: draft.revision });
      expect(draft.state).toBe("declined");
      draft = await f.command({
        action: "revise",
        draftId: draft.id,
        expectedRevision: draft.revision,
        description: "Reopened for edits",
      });
      draft = await f.command({ action: "cancel", draftId: draft.id, expectedRevision: draft.revision });
      await expect(
        f.command({
          action: "revise",
          draftId: draft.id,
          expectedRevision: draft.revision,
          description: "Cannot reopen cancellation",
        }),
      ).rejects.toThrow("skin_draft_cancelled");
      expect(await restarted.handle(owner, { action: "get", draftId: ready.id, version: 4 })).toEqual({
        outcome: "draft",
        draft: ready,
      });
      const reference = await f.upload();
      const referenceDraft = await f.command({
        action: "create",
        requestId: randomUUID(),
        description: "A retained reference",
        reference,
      });
      await f.files.removeConversation(reference.conversationId);
      expect(
        (await f.service.referencePreview(owner, referenceDraft.id, referenceDraft.revision)).sha256,
      ).toBe(digest(image()));
      expect(
        (
          await f.command({
            action: "pose",
            draftId: referenceDraft.id,
            expectedRevision: referenceDraft.revision,
            pose: "rest",
            source: reference,
            sampling: grid,
          })
        ).poses.rest!.height,
      ).toBe(64);
      const create = {
        action: "create",
        requestId: randomUUID(),
        description: "One durable request",
      } as const;
      expect(await f.command({ ...create, requestId: create.requestId.toUpperCase() })).toEqual(
        await f.command(create),
      );
      await expect(f.command({ ...create, description: "Different intent" })).rejects.toThrow(
        "skin_draft_request_conflict",
      );
    } finally {
      await f.close();
    }
  });

  it("refuses missing owner proof, foreign owner IDs, forged tool approval and revoked writes", async () => {
    const f = await fixture();
    try {
      const { draft } = await f.ready();
      await expect(f.service.handle(undefined, { action: "get", draftId: draft.id })).rejects.toThrow(
        "skin_draft_owner_required",
      );
      const foreign = new SkinDraftService({
        root: join(f.root, "drafts"),
        ownerId: "another-owner",
        files: f.files,
      });
      await expect(foreign.handle(owner, { action: "get", draftId: draft.id })).rejects.toThrow(
        "skin_draft_not_found",
      );
      await expect(
        foreign.handle(owner, { action: "approve", draftId: draft.id, expectedRevision: draft.revision }),
      ).rejects.toThrow("skin_draft_not_found");
      const tool = skinDraftTool(f.service, { skinDraftAuthority: owner } as TurnContext);
      // Bypass the published input schema as a hostile caller might; execute still refuses.
      await expect(
        tool.execute(
          "test",
          {
            action: "approve",
            draftId: draft.id,
            expectedRevision: draft.revision,
          } as never,
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow("skin_draft_owner_approval_required");
      await expect(
        skinDraftTool(f.service, {} as TurnContext).execute(
          "test",
          { action: "get", draftId: draft.id },
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow("skin_draft_owner_required");
      let checks = 0;
      const revoked: QuestionAuthority = { ...owner, authorize: async () => ++checks < 4 };
      await expect(
        f.command(
          {
            action: "revise",
            draftId: draft.id,
            expectedRevision: draft.revision,
            description: "Revoked before commit",
          },
          revoked,
        ),
      ).rejects.toThrow("skin_draft_owner_required");
      expect(await f.command({ action: "get", draftId: draft.id })).toEqual(draft);
      await expect(
        f.command({ action: "get", draftId: draft.id, version: draft.version + 1 }),
      ).rejects.toThrow("skin_draft_not_found");
      // A fresh accepted update can replace the uncommitted history without exposing it.
      expect(
        (
          await f.command({
            action: "revise",
            draftId: draft.id,
            expectedRevision: draft.revision,
            description: "Accepted revision",
          })
        ).description,
      ).toBe("Accepted revision");
    } finally {
      await f.close();
    }
  });

  it("blocks unowned inputs, bad geometry, empty art and changed approval bytes", async () => {
    const f = await fixture();
    try {
      const { draft, source } = await f.ready();
      await expect(
        f.command({
          action: "pose",
          draftId: draft.id,
          expectedRevision: draft.revision,
          pose: "work",
          source: { ...source, artifactId: "0".repeat(48) },
          sampling: grid,
        }),
      ).rejects.toThrow("skin_draft_reference_not_found");
      await expect(
        f.command({
          action: "pose",
          draftId: draft.id,
          expectedRevision: draft.revision,
          pose: "work",
          source,
          sampling: { ...grid, grid: { ...grid.grid, rows: 32 } },
        }),
      ).rejects.toThrow("skin_draft_pose_geometry");
      const empty = await f.upload(encodePNG(32, 64, Buffer.alloc(32 * 64 * 4)));
      await expect(
        f.command({
          action: "pose",
          draftId: draft.id,
          expectedRevision: draft.revision,
          pose: "work",
          source: empty,
          sampling: grid,
        }),
      ).rejects.toThrow("skin_draft_empty_pose");
      await expect(
        f.command({
          action: "create",
          requestId: randomUUID(),
          description: "Injected path",
          reference: { ...source, path: "/private/art.png" },
        } as never),
      ).rejects.toThrow("skin_draft_malformed");
      await writeFile(join(f.root, "worker.png"), image());
      const delivered = await f.files.publish({
        conversationId: "worker-conversation",
        sourceRoot: f.root,
        path: "worker.png",
      });
      await expect(
        f.command({
          action: "create",
          requestId: randomUUID(),
          description: "Not an owner upload",
          reference: { conversationId: "worker-conversation", artifactId: delivered.artifactId },
        }),
      ).rejects.toThrow("skin_draft_reference_not_found");
      const blob = join(f.root, "drafts", f.service.owner, "blobs", draft.poses.rest!.sha256);
      await writeFile(blob, Buffer.from("changed"));
      await expect(
        f.command({ action: "approve", draftId: draft.id, expectedRevision: draft.revision }),
      ).rejects.toThrow("skin_draft_artifact_changed");
      expect((await f.command({ action: "get", draftId: draft.id })).state).toBe("awaiting_approval");
    } finally {
      await f.close();
    }
  });

  it("uses real owner-authenticated HTTP and bundled CLI without mutating the live appearance", async () => {
    const f = await fixture();
    const settings = new SettingsStore(join(f.root, "settings.json"));
    const store = new FileCredentialStore(join(f.root, "credentials.json"));
    const credential = await ensureOperatorCredential({ env: {}, store });
    const app = await createClankieApp({
      captain: createStubCaptain(),
      settings,
      deliveredFiles: f.files,
      extensionRoutes: [skinDraftRoutes(f.service)],
      authenticateOperator: createCredentialBackedOperatorAuthenticator({
        env: {},
        store,
        identity: { operatorId: owner.principal.id },
      }),
    });
    const server = await startFixtureServer(app.app.fetch);
    try {
      const before = await settings.load();
      expect((await fetch(server.host + SKIN_DRAFTS_PATH)).status).toBe(401);
      const run = promisify(execFile),
        repo = new URL("../../../", import.meta.url).pathname,
        cli = join(f.root, "clankie.mjs");
      await run(
        join(repo, "node_modules/esbuild/bin/esbuild"),
        [
          "apps/tui/bin/clankie.ts",
          "--bundle",
          "--platform=node",
          "--format=esm",
          "--target=node24",
          "--outfile=" + cli,
          '--banner:js=import { createRequire as __clankieCreateRequire } from "node:module"; const require = __clankieCreateRequire(import.meta.url);',
          ...[
            "@browser_use/pi",
            "mineflayer",
            "mineflayer-pathfinder",
            "minecraft-data",
            "prismarine-viewer",
            "playwright-core",
            "express",
            "socket.io",
            "vec3",
          ].map((p) => "--external:" + p),
        ],
        { cwd: repo },
      );
      const cliRun = async (...args: string[]) => {
        const result = await run(process.execPath, [cli, "skin", "draft", ...args], {
          cwd: f.root,
          env: {
            ...process.env,
            NODE_ENV: "test",
            VITEST: "true",
            CLANKIE_STATE: join(f.root, "state"),
            CLANKIE_CONTROL_PLANE_URL: server.host,
            CLANKIE_OPERATOR_TOKEN: credential.token,
          },
        });
        return SkinDraftResultSchema.parse(JSON.parse(result.stdout));
      };
      const created = await cliRun("create", "A native tall sentinel", "--request", randomUUID());
      if (created.outcome !== "draft") throw Error("Expected draft");
      let draft: SkinDraft = created.draft;
      const source = await f.upload();
      for (const pose of ["rest", "work", "comms"] as const) {
        const commandFile = join(f.root, "pose.json");
        await writeFile(
          commandFile,
          JSON.stringify({
            action: "pose",
            draftId: draft.id,
            expectedRevision: draft.revision,
            pose,
            source,
            sampling: grid,
          }),
        );
        const result = await cliRun("pose", commandFile);
        if (result.outcome !== "draft") throw Error("Expected draft");
        draft = result.draft;
      }
      const response = await fetch(
        `${server.host}${SKIN_DRAFTS_PATH}/${draft.id}/poses/rest/native?revision=${draft.revision}`,
        { headers: { authorization: "Bearer " + credential.token } },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(decodePNG(Buffer.from(await response.arrayBuffer())).height).toBe(64);
      expect(await cliRun("approve", draft.id, draft.revision)).toMatchObject({
        outcome: "draft",
        draft: { state: "approved", approval: { actor: owner.principal } },
      });
      expect(await cliRun("get", draft.id, "--version", "1")).toMatchObject({
        draft: { version: 1, state: "awaiting_poses" },
      });
      expect(await cliRun("list")).toMatchObject({ outcome: "list", drafts: [{ state: "approved" }] });
      expect(await settings.load()).toEqual(before);
      await expect(cliRun("approve", draft.id, draft.revision)).rejects.toThrow("Skin draft conflicts");
      expect(
        (
          await fetch(`${server.host}${SKIN_DRAFTS_PATH}/${draft.id}?owner=other`, {
            headers: { authorization: "Bearer " + credential.token },
          })
        ).status,
      ).toBe(400);
      const path = `${SKIN_DRAFTS_PATH}/${draft.id}/poses/rest/native?revision=${draft.revision}`;
      expect(isSkinDraftRoute("GET", path)).toBe(true);
      for (const bad of [
        path + "&owner=other",
        path.replace("/poses/", "/%70oses/"),
        path + "&revision=" + draft.revision,
      ])
        expect(isSkinDraftRoute("GET", bad)).toBe(false);
      const stored = await readFile(
        join(f.root, "drafts", f.service.owner, "drafts", draft.id, "current.json"),
        "utf8",
      );
      expect(stored).not.toContain(credential.token);
      await rotateOperatorCredential({ env: {}, store });
      await expect(cliRun("get", draft.id)).rejects.toThrow();
      expect((await f.command({ action: "get", draftId: draft.id })).state).toBe("approved");
      const proof = process.env.SKIN_DRAFT_PROOF_DIRECTORY;
      if (proof) {
        await writeFile(
          join(proof, "native-rest.png"),
          (
            await f.service.preview(
              owner,
              draft.id,
              "rest",
              (await f.command({ action: "get", draftId: draft.id })).revision,
              "native",
            )
          ).bytes,
        );
        await writeFile(join(proof, "draft.json"), stored);
      }
    } finally {
      app.close();
      await server.close();
      await f.close();
    }
  });
});
