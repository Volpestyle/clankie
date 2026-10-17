import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { sampleReference, decodePNG, decodeReference, digest, IMAGE_LIMITS } from "@clankie/lead-skin";
import {
  SKIN_KEY_POSES,
  SkinDraftCommandSchema,
  SkinDraftSchema,
  type SkinDraft,
  type SkinDraftCommand,
  type SkinDraftSource,
  type SkinPoseInput,
  type SkinGeneration,
  type SkinDraftResult,
  type SkinKeyPose,
} from "@clankie/protocol/skin-drafts";
import { authorizeQuestion, type QuestionAuthority } from "./captain/conversation-questions.ts";
import type { SkinDraftGenerator } from "./skin-draft-generation.ts";
import type { DeliveredFileStore } from "./delivered-files.ts";
import { withSerializedLock } from "./app/request-state.ts";

const locks = new Map<string, Promise<unknown>>();
const generationLocks = new Map<string, Promise<unknown>>();
const RECORD_BYTES = 256 * 1024;
const RecordSchema = z
  .object({
    creationDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    draft: SkinDraftSchema,
  })
  .strict();
type Record = z.infer<typeof RecordSchema>;

export class SkinDraftError extends Error {
  readonly code: string;
  readonly status: 400 | 403 | 404 | 409 | 413;
  constructor(code: string, status: SkinDraftError["status"]) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
async function authorized(authority: QuestionAuthority | undefined) {
  try {
    await authorizeQuestion(authority);
  } catch {
    throw new SkinDraftError("skin_draft_owner_required", 403);
  }
}
async function bounded(path: string, limit: number) {
  const file = await open(path, "r");
  try {
    if ((await file.stat()).size > limit) throw new SkinDraftError("skin_draft_bytes_exceeded", 413);
    const bytes = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await file.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    if (count > limit) throw new SkinDraftError("skin_draft_bytes_exceeded", 413);
    return bytes.subarray(0, count);
  } finally {
    await file.close();
  }
}
async function atomic(path: string, bytes: Buffer) {
  const pending = path + "." + randomUUID() + ".pending";
  try {
    await writeFile(pending, bytes, { mode: 0o600, flag: "wx" });
    await rename(pending, path);
  } finally {
    await rm(pending, { force: true });
  }
}
function seal(input: Omit<SkinDraft, "revision"> | SkinDraft): SkinDraft {
  const parsed = SkinDraftSchema.parse({ ...input, revision: "0".repeat(64) });
  return { ...parsed, revision: digest(Buffer.from(JSON.stringify({ ...parsed, revision: undefined }))) };
}
const complete = (draft: SkinDraft) => SKIN_KEY_POSES.every((pose) => draft.poses[pose]);

/** One host-proven owner domain. Generation requires separate host admission; never animates or selects a look. */
export class SkinDraftService {
  private readonly root: string;
  readonly owner: string;
  private readonly files: Pick<DeliveredFileStore, "attachment" | "read">;
  private readonly generator: SkinDraftGenerator | undefined;
  constructor(options: {
    root: string;
    /** Stable owner account selected by the host, never a request or model field. */
    ownerId: string;
    files: Pick<DeliveredFileStore, "attachment" | "read">;
    generator?: SkinDraftGenerator;
  }) {
    if (!options.ownerId) throw Error("skin_draft_owner_missing");
    this.owner = createHash("sha256").update(options.ownerId).digest("hex");
    this.root = resolve(options.root, this.owner);
    this.files = options.files;
    this.generator = options.generator;
  }
  private async read(id: string, version?: number): Promise<Record | undefined> {
    // current.json is the commit marker. A revoked/crashed write may have staged
    // a future history file, but it must never become a visible revision.
    if (version !== undefined) {
      const current = await this.read(id);
      if (!current || version > current.draft.version) return undefined;
      if (version === current.draft.version) return current;
    }
    const path = join(
      this.root,
      "drafts",
      id,
      version === undefined ? "current.json" : "v" + version + ".json",
    );
    let bytes: Buffer;
    try {
      bytes = await bounded(path, RECORD_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const parsed = RecordSchema.safeParse(JSON.parse(bytes.toString("utf8")));
    if (!parsed.success || parsed.data.draft.owner !== this.owner || parsed.data.draft.id !== id)
      throw new SkinDraftError("skin_draft_storage_invalid", 409);
    const draft = parsed.data.draft;
    if (
      seal(draft).revision !== draft.revision ||
      (version !== undefined && draft.version !== version) ||
      (draft.state === "approved" && (!complete(draft) || !draft.approval)) ||
      (draft.state !== "approved" && draft.approval) ||
      (draft.approval &&
        (draft.approval.owner !== this.owner ||
          SKIN_KEY_POSES.some((pose) => draft.approval!.poseDigests[pose] !== draft.poses[pose]?.sha256)))
    )
      throw new SkinDraftError("skin_draft_storage_invalid", 409);
    return parsed.data;
  }
  private async blob(bytes: Buffer): Promise<string> {
    const sha = digest(bytes);
    const directory = join(this.root, "blobs");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, sha);
    // Content is copied into this owner's private store; conversation retention cannot alter a draft.
    await atomic(path, bytes);
    return sha;
  }
  private async source(reference: SkinPoseInput, draft?: SkinDraft) {
    // A previously committed owner input remains usable after conversation retention.
    const stored = [
      draft?.reference,
      ...Object.values(draft?.poses ?? {}).map((pose) => pose?.source),
      ...(draft?.generations ?? []).flatMap((g) => g.steps.map((s) => s.source)),
    ].find(
      (source) =>
        source &&
        ("conversationId" in reference
          ? "conversationId" in source &&
            source.conversationId === reference.conversationId &&
            source.artifactId === reference.artifactId
          : "generationRequestId" in source &&
            source.generationRequestId === reference.generationRequestId &&
            source.pose === reference.pose),
    );
    if (stored) {
      const bytes = await this.sourceBytes(stored);
      return { bytes, source: stored };
    }
    if (!("conversationId" in reference)) throw new SkinDraftError("skin_draft_reference_not_found", 404);
    if (!(await this.files.attachment(reference.conversationId, reference.artifactId)))
      throw new SkinDraftError("skin_draft_reference_not_found", 404);
    const found = await this.files.read(reference.conversationId, reference.artifactId);
    if (!found) throw new SkinDraftError("skin_draft_reference_not_found", 404);
    if (!(["image/png", "image/jpeg"] as string[]).includes(found.file.mediaType))
      throw new SkinDraftError("skin_draft_reference_format", 400);
    if (found.data.length > IMAGE_LIMITS.bytes) throw new SkinDraftError("skin_draft_bytes_exceeded", 413);
    try {
      decodeReference(found.data);
    } catch {
      throw new SkinDraftError("skin_draft_invalid_reference", 400);
    }
    return {
      bytes: found.data,
      source: {
        ...reference,
        sha256: digest(found.data),
        byteCount: found.data.length,
        mediaType: found.file.mediaType as "image/png" | "image/jpeg",
      },
    };
  }
  private async save(record: Record, authority: QuestionAuthority) {
    const directory = join(this.root, "drafts", record.draft.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const bytes = Buffer.from(JSON.stringify(record));
    if (bytes.length > RECORD_BYTES) throw new SkinDraftError("skin_draft_bytes_exceeded", 413);
    await authorized(authority);
    await atomic(join(directory, "v" + record.draft.version + ".json"), bytes);
    await authorized(authority);
    await atomic(join(directory, "current.json"), bytes);
  }
  private async generationUpdate(
    authority: QuestionAuthority,
    id: string,
    update: (draft: SkinDraft) => Promise<SkinDraft> | SkinDraft,
  ): Promise<SkinDraft> {
    return withSerializedLock(locks, this.root, async () => {
      await authorized(authority);
      const record = await this.read(id);
      if (!record) throw new SkinDraftError("skin_draft_not_found", 404);
      if (record.draft.version >= 64) throw new SkinDraftError("skin_draft_versions_exceeded", 413);
      const draft = seal(
        await update({
          ...structuredClone(record.draft),
          version: record.draft.version + 1,
          updatedAt: new Date().toISOString(),
        }),
      );
      await this.save({ ...record, draft }, authority);
      return draft;
    });
  }
  private async generate(
    authority: QuestionAuthority,
    command: Extract<SkinDraftCommand, { action: "generate" }>,
  ): Promise<SkinDraftResult> {
    return withSerializedLock(generationLocks, this.root + command.draftId, async () => {
      const result = await this.handle(authority, { action: "get", draftId: command.draftId });
      if (result.outcome !== "draft") throw Error("skin_draft_not_found");
      let draft = result.draft;
      const prior = draft.generations?.find((g) => g.requestId === command.requestId);
      if (prior) {
        if (prior.inputRevision !== command.expectedRevision)
          throw new SkinDraftError("skin_draft_request_conflict", 409);
        if (prior.state === "running") {
          // This process has no active invocation here. A persisted dispatch may
          // already have cost money; never infer failure or send it again.
          draft = await this.generationUpdate(authority, draft.id, (current) => {
            const journal = current.generations!.find((g) => g.requestId === command.requestId)!;
            journal.state = "uncertain";
            for (const step of journal.steps) if (step.state === "dispatching") step.state = "uncertain";
            current.generation = "uncertain";
            return current;
          });
        }
        return { outcome: "draft", draft };
      }
      if (draft.revision !== command.expectedRevision) throw new SkinDraftError("skin_draft_conflict", 409);
      if (draft.state === "cancelled") throw new SkinDraftError("skin_draft_cancelled", 409);
      if (draft.generations?.some((g) => g.state === "uncertain" || g.state === "running"))
        throw new SkinDraftError("skin_generation_reconciliation_required", 409);
      if ((draft.generations?.length ?? 0) >= 16 || draft.version > 56)
        throw new SkinDraftError("skin_draft_versions_exceeded", 413);
      await authorized(authority);
      if (!this.generator || !(await this.generator.admit(this.owner)))
        throw new SkinDraftError("skin_generation_credit_policy_required", 409);
      draft = await this.generationUpdate(authority, draft.id, (current) => {
        if (current.revision !== command.expectedRevision)
          throw new SkinDraftError("skin_draft_conflict", 409);
        current.generations = [
          ...(current.generations ?? []),
          {
            requestId: command.requestId,
            inputRevision: command.expectedRevision,
            description: current.description,
            state: "running",
            createdAt: new Date().toISOString(),
            steps: [],
          },
        ];
        current.generation = "running";
        current.state = "awaiting_poses";
        delete current.approval;
        return current;
      });
      const journalOf = (current: SkinDraft): SkinGeneration =>
        current.generations!.find((g) => g.requestId === command.requestId)!;
      for (const pose of SKIN_KEY_POSES) {
        // Each individual dispatch is committed before crossing the provider
        // boundary. Reads, edits and cancellation remain available during it.
        draft = await this.generationUpdate(authority, draft.id, (current) => {
          if (current.revision !== draft.revision || current.state === "cancelled")
            throw new SkinDraftError("skin_draft_conflict", 409);
          journalOf(current).steps.push({ pose, state: "dispatching" });
          return current;
        });
        const dispatchedRevision = draft.revision;
        try {
          await authorized(authority);
          if (!(await this.generator.admit(this.owner))) throw Error("skin_generation_admission_changed");
          const reference =
            pose === "rest" ? (draft.reference ?? draft.poses.rest?.source) : draft.poses.rest?.source;
          const generated = await this.generator.generate({
            description: journalOf(draft).description,
            pose,
            ...(reference
              ? { reference: { bytes: await this.sourceBytes(reference), mediaType: reference.mediaType } }
              : {}),
          });
          draft = await this.generationUpdate(authority, draft.id, async (current) => {
            const journal = journalOf(current);
            const step = journal.steps.find((s) => s.pose === pose)!;
            step.receipt = generated.receipt;
            if (generated.receipt.outcome !== "ok") {
              // The existing media seam reports transport failures and invalid
              // downloaded output as refusals too. Neither proves no upstream
              // work/spend occurred. Only known pre-dispatch refusals are final.
              const state = [
                "no_model_configured",
                "credential_unavailable",
                "provider_unsupported",
                "doctrine_denied",
              ].includes(generated.receipt.reason)
                ? "refused"
                : "uncertain";
              step.state = state;
              journal.state = state;
              current.generation = state;
              return current;
            }
            const bytes = generated.bytes;
            if (!bytes || !["image/png", "image/jpeg"].includes(generated.receipt.mimeType))
              throw Error("skin_generation_image_missing");
            const source: SkinDraftSource = {
              generationRequestId: command.requestId,
              pose,
              sha256: await this.blob(bytes),
              mediaType: generated.receipt.mimeType as "image/png" | "image/jpeg",
              byteCount: bytes.length,
              provider: generated.receipt.provider,
              model: generated.receipt.model,
            };
            step.source = source;
            step.state = "complete";
            // Keep the receipt even when an owner edited/cancelled while the
            // provider was working. The late image must not overwrite that edit.
            if (current.revision !== dispatchedRevision || current.state === "cancelled") {
              journal.state = "refused";
              current.generation = "refused";
              step.detail = "draft_changed";
              return current;
            }
            try {
              const image = decodeReference(bytes);
              const pitch = image.width / 32,
                rows = image.height / pitch;
              if (pitch < 1 || !Number.isInteger(rows) || rows < 1 || rows > 96)
                throw Error("unsupported_grid");
              current = await this.withPose(
                current,
                current,
                pose,
                { bytes, source },
                {
                  grid: { pitch, columns: 32, rows },
                  colors: 16,
                },
              );
            } catch {
              journal.state = "refused";
              current.generation = "refused";
              step.detail = "sampling_requires_edit";
              return current;
            }
            if (pose === "comms") {
              journal.state = "complete";
              current.generation = "complete";
            }
            return current;
          });
        } catch {
          draft = await this.generationUpdate(authority, draft.id, (current) => {
            const journal = journalOf(current),
              step = journal.steps.find((s) => s.pose === pose)!;
            step.state = "uncertain";
            step.detail = "provider_result_unconfirmed";
            journal.state = "uncertain";
            current.generation = "uncertain";
            return current;
          });
        }
        if (journalOf(draft).state !== "running") break;
      }
      return { outcome: "draft", draft };
    });
  }
  async handle(authority: QuestionAuthority | undefined, value: SkinDraftCommand): Promise<SkinDraftResult> {
    await authorized(authority);
    const parsed = SkinDraftCommandSchema.safeParse(value);
    if (!parsed.success) throw new SkinDraftError("skin_draft_malformed", 400);
    const command = parsed.data;
    if (command.action === "generate") return this.generate(authority!, command);
    return withSerializedLock(locks, this.root, async () => {
      await authorized(authority);
      if (command.action === "list") {
        const ids = await readdir(join(this.root, "drafts")).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        });
        const drafts: SkinDraft[] = [];
        for (const id of ids.sort()) {
          if (!z.uuid().safeParse(id).success) continue;
          const record = await this.read(id);
          if (record) drafts.push(record.draft);
        }
        if (drafts.length > 128) throw new SkinDraftError("skin_draft_count_exceeded", 413);
        await authorized(authority);
        return { outcome: "list", drafts };
      }
      if (command.action === "create") {
        const creationDigest = digest(Buffer.from(JSON.stringify(command)));
        const prior = await this.read(command.requestId);
        if (prior) {
          if (prior.creationDigest !== creationDigest)
            throw new SkinDraftError("skin_draft_request_conflict", 409);
          await authorized(authority);
          return { outcome: "draft", draft: prior.draft };
        }
        if (
          (
            await readdir(join(this.root, "drafts")).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return [];
              throw error;
            })
          ).length >= 128
        )
          throw new SkinDraftError("skin_draft_count_exceeded", 413);
        const reference = command.reference ? await this.source(command.reference) : undefined;
        if (reference) await this.blob(reference.bytes);
        const now = new Date().toISOString();
        const draft = seal({
          schemaVersion: 1,
          id: command.requestId,
          owner: this.owner,
          version: 1,
          description: command.description,
          state: "awaiting_poses",
          generation: "not_requested",
          createdAt: now,
          updatedAt: now,
          poses: {},
          ...(reference ? { reference: reference.source } : {}),
        });
        await this.save({ creationDigest, draft }, authority!);
        return { outcome: "draft", draft };
      }
      const record = await this.read(command.draftId, command.action === "get" ? command.version : undefined);
      if (!record) throw new SkinDraftError("skin_draft_not_found", 404);
      if (command.action === "get") {
        await authorized(authority);
        return { outcome: "draft", draft: record.draft };
      }
      const before = record.draft;
      if (before.revision !== command.expectedRevision) throw new SkinDraftError("skin_draft_conflict", 409);
      if (before.state === "cancelled") throw new SkinDraftError("skin_draft_cancelled", 409);
      if (before.version >= 64) throw new SkinDraftError("skin_draft_versions_exceeded", 413);
      let draft: SkinDraft = { ...before, version: before.version + 1, updatedAt: new Date().toISOString() };
      delete draft.approval;
      if (command.action === "pose") {
        if (command.pose !== "rest" && !before.poses.rest)
          throw new SkinDraftError("skin_draft_rest_required", 409);
        const source = await this.source(command.source, before);
        draft = await this.withPose(before, draft, command.pose, source, command.sampling);
      } else if (command.action === "revise") {
        draft.description = command.description;
        draft.state = complete(draft) ? "awaiting_approval" : "awaiting_poses";
      } else if (command.action === "approve") {
        if (before.state !== "awaiting_approval" || !complete(before))
          throw new SkinDraftError("skin_draft_poses_required", 409);
        for (const pose of SKIN_KEY_POSES) {
          await this.poseBytes(before, pose, "source");
          await this.poseBytes(before, pose, "native");
        }
        draft.state = "approved";
        draft.approval = {
          owner: this.owner,
          actor: { ...authority!.principal },
          revision: before.revision,
          poseDigests: {
            rest: before.poses.rest!.sha256,
            work: before.poses.work!.sha256,
            comms: before.poses.comms!.sha256,
          },
          approvedAt: draft.updatedAt,
        };
      } else draft.state = command.action === "cancel" ? "cancelled" : "declined";
      draft = seal(draft);
      await this.save({ ...record, draft }, authority!);
      return { outcome: "draft", draft };
    });
  }
  private async withPose(
    before: SkinDraft,
    draft: SkinDraft,
    pose: SkinKeyPose,
    source: { bytes: Buffer; source: SkinDraftSource },
    sampling: NonNullable<SkinDraft["poses"]["rest"]>["sampling"],
  ): Promise<SkinDraft> {
    let sampled;
    try {
      sampled = sampleReference(source.bytes, {
        grid: {
          pitch: sampling.grid.pitch,
          columns: sampling.grid.columns,
          rows: sampling.grid.rows,
          ...(sampling.grid.x === undefined ? {} : { x: sampling.grid.x }),
          ...(sampling.grid.y === undefined ? {} : { y: sampling.grid.y }),
        },
        ...(sampling.background === undefined ? {} : { background: sampling.background }),
        ...(sampling.backgroundTolerance === undefined
          ? {}
          : { backgroundTolerance: sampling.backgroundTolerance }),
        ...(sampling.colors === undefined ? {} : { colors: sampling.colors }),
        ...(pose !== "rest" ? { approvedPalette: before.poses.rest!.palette } : {}),
      });
    } catch {
      throw new SkinDraftError("skin_draft_invalid_sampling", 400);
    }
    if (!sampled.palette.length || !sampled.image.rgba.some((byte, at) => at % 4 === 3 && byte === 255))
      throw new SkinDraftError("skin_draft_empty_pose", 400);
    if (
      pose !== "rest" &&
      (sampled.image.width !== before.poses.rest!.width || sampled.image.height !== before.poses.rest!.height)
    )
      throw new SkinDraftError("skin_draft_pose_geometry", 400);
    const sourceSha = await this.blob(source.bytes);
    if (sourceSha !== source.source.sha256) throw new SkinDraftError("skin_draft_reference_changed", 409);
    const sha = await this.blob(sampled.png);
    draft.poses = {
      ...(pose === "rest" ? {} : before.poses),
      [pose]: {
        source: source.source,
        sampling: sampling,
        sha256: sha,
        width: sampled.image.width,
        height: sampled.image.height,
        palette: sampled.palette as [number, number, number][],
      },
    };
    draft.state = complete(draft) ? "awaiting_approval" : "awaiting_poses";
    return draft;
  }
  private async sourceBytes(source: SkinDraftSource) {
    const bytes = await bounded(join(this.root, "blobs", source.sha256), IMAGE_LIMITS.bytes);
    if (digest(bytes) !== source.sha256 || bytes.length !== source.byteCount)
      throw new SkinDraftError("skin_draft_artifact_changed", 409);
    return bytes;
  }
  async referencePreview(authority: QuestionAuthority | undefined, id: string, revision: string) {
    await authorized(authority);
    if (!z.uuid().safeParse(id).success || !/^[a-f0-9]{64}$/u.test(revision))
      throw new SkinDraftError("skin_draft_malformed", 400);
    const record = await this.read(id);
    if (!record?.draft.reference) throw new SkinDraftError("skin_draft_reference_not_found", 404);
    if (record.draft.revision !== revision) throw new SkinDraftError("skin_draft_conflict", 409);
    const source = record.draft.reference;
    const bytes = await this.sourceBytes(source);
    await authorized(authority);
    return { bytes, sha256: source.sha256, mediaType: source.mediaType };
  }
  private async poseBytes(draft: SkinDraft, pose: SkinKeyPose, kind: "source" | "native") {
    const entry = draft.poses[pose];
    if (!entry) throw new SkinDraftError("skin_draft_pose_not_found", 404);
    const sha = kind === "native" ? entry.sha256 : entry.source.sha256;
    const bytes = await bounded(join(this.root, "blobs", sha), IMAGE_LIMITS.bytes);
    if (digest(bytes) !== sha) throw new SkinDraftError("skin_draft_artifact_changed", 409);
    if (kind === "native") {
      const decoded = decodePNG(bytes);
      if (decoded.width !== entry.width || decoded.height !== entry.height)
        throw new SkinDraftError("skin_draft_artifact_changed", 409);
    }
    return { bytes, sha256: sha, mediaType: kind === "native" ? "image/png" : entry.source.mediaType };
  }
  async preview(
    authority: QuestionAuthority | undefined,
    id: string,
    pose: SkinKeyPose,
    revision: string,
    kind: "source" | "native",
  ) {
    await authorized(authority);
    if (
      !z.uuid().safeParse(id).success ||
      !SKIN_KEY_POSES.includes(pose) ||
      !/^[a-f0-9]{64}$/u.test(revision) ||
      !["source", "native"].includes(kind)
    )
      throw new SkinDraftError("skin_draft_malformed", 400);
    const record = await this.read(id);
    if (!record) throw new SkinDraftError("skin_draft_not_found", 404);
    if (record.draft.revision !== revision) throw new SkinDraftError("skin_draft_conflict", 409);
    const image = await this.poseBytes(record.draft, pose, kind);
    await authorized(authority);
    return image;
  }
}
