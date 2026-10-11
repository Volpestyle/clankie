import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SkinDraftCommandSchema } from "@clankie/protocol/skin-drafts";
import type { SkinDraftService } from "../skin-drafts.ts";
import { toolJson, type TurnContext } from "./tools.ts";

/** Agents may prepare a draft; only a direct authenticated owner operation can approve it. */
export function skinDraftTool(service: SkinDraftService | undefined, turn: TurnContext) {
  return defineTool({
    name: "skin_draft",
    label: "Prepare a lead-skin draft",
    description:
      "Create, inspect, revise or cancel the owner's durable key-pose draft without spending or changing the live look. " +
      "Use a UUID requestId for create and the returned exact expectedRevision for edits. Pose input names a committed owner attachment by conversationId/artifactId, never a file path or URL. " +
      "Supply an explicit sampling grid and import rest first; work/comms keep its native dimensions and palette. Replacing rest clears the other poses. " +
      "This tool cannot approve poses, animate, generate or publish. Ask the owner to inspect source/native previews and approve the exact revision through the owner API or clankie skin draft approve.",
    parameters: Type.Object({
      action: Type.Union(["create", "list", "get", "pose", "revise", "cancel"].map((v) => Type.Literal(v))),
      requestId: Type.Optional(Type.String()),
      draftId: Type.Optional(Type.String()),
      expectedRevision: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      version: Type.Optional(Type.Number()),
      pose: Type.Optional(Type.Union([Type.Literal("rest"), Type.Literal("work"), Type.Literal("comms")])),
      reference: Type.Optional(Type.Object({ conversationId: Type.String(), artifactId: Type.String() })),
      source: Type.Optional(Type.Object({ conversationId: Type.String(), artifactId: Type.String() })),
      sampling: Type.Optional(
        Type.Object({
          grid: Type.Object({
            pitch: Type.Number(),
            x: Type.Optional(Type.Number()),
            y: Type.Optional(Type.Number()),
            columns: Type.Number(),
            rows: Type.Number(),
          }),
          background: Type.Optional(Type.Array(Type.Number())),
          backgroundTolerance: Type.Optional(Type.Number()),
          colors: Type.Optional(Type.Number()),
        }),
      ),
    }),
    async execute(_callId, input) {
      if (!service) throw Error("skin_drafts_unavailable");
      const command = SkinDraftCommandSchema.parse(input);
      if (command.action === "approve" || command.action === "decline")
        throw Error("skin_draft_owner_approval_required");
      return toolJson(await service.handle(turn.skinDraftAuthority, command));
    },
  });
}
