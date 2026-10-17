import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import {
  SKIN_DRAFTS_PATH,
  SkinDraftCommandSchema,
  SkinDraftResultSchema,
} from "@clankie/protocol/skin-drafts";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";

export async function runSkinDraftCommand(args: readonly string[], options: OwnerSettingsApiOptions = {}) {
  const [action, id, revision] = args;
  let value: unknown;
  if (action === "list" && args.length === 1) value = { action };
  else if (action === "get" && (args.length === 2 || (args.length === 4 && args[2] === "--version")))
    value = { action, draftId: id, ...(args.length === 4 ? { version: Number(args[3]) } : {}) };
  else if (action === "create" && (args.length === 2 || (args.length === 4 && args[2] === "--request")))
    value = { action, description: id, requestId: args[3] ?? randomUUID() };
  else if (["approve", "decline", "cancel"].includes(action ?? "") && args.length === 3)
    value = { action, draftId: id, expectedRevision: revision };
  else if (action === "generate" && args.length === 5 && args[3] === "--request")
    value = { action, draftId: id, expectedRevision: revision, requestId: args[4] };
  else if (action === "revise" && args.length === 4)
    value = { action, draftId: id, expectedRevision: revision, description: args[3] };
  else if (action === "pose" && args.length === 2) {
    const file = await open(id!, "r");
    try {
      if ((await file.stat()).size > 16384) throw Error("Skin pose command exceeds 16 KiB");
      const bytes = Buffer.alloc(16385);
      let count = 0;
      while (count < bytes.length) {
        const next = await file.read(bytes, count, bytes.length - count, count);
        if (!next.bytesRead) break;
        count += next.bytesRead;
      }
      if (count > 16384) throw Error("Skin pose command exceeds 16 KiB");
      value = JSON.parse(bytes.subarray(0, count).toString("utf8"));
      if ((value as { action?: unknown })?.action !== "pose")
        throw Error("Pose command requires action pose");
    } finally {
      await file.close();
    }
  } else
    throw Error(
      "Usage: clankie skin draft create SENTENCE [--request UUID] | list | get ID [--version N] | pose COMMAND.json | generate ID REVISION --request UUID | revise ID REVISION SENTENCE | approve|decline|cancel ID REVISION",
    );
  const command = SkinDraftCommandSchema.parse(value);
  try {
    return await (await ownerSettingsApi(options)).write(SKIN_DRAFTS_PATH, command, SkinDraftResultSchema);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "skin_generation_credit_policy_required")
      throw Error("Automatic drawing is waiting for an approved spending limit. Your draft is saved.");
    if (error instanceof Error && "code" in error && error.code === "skin_generation_reconciliation_required")
      throw Error(
        "An earlier drawing has an unconfirmed result. Read its saved journal; do not start a replacement request.",
      );
    if (error instanceof Error && "status" in error && error.status === 409)
      throw Error(
        "Skin draft conflicts with this action. Read the current draft and review the change again.",
      );
    throw error;
  }
}
