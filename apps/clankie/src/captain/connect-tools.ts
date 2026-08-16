import type { CaptainSessionLaneV2 } from "@clankie/protocol";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CaptainDeps } from "./deps.ts";
import { toolJson as json } from "./tools.ts";

function operatorOnly(lane: CaptainSessionLaneV2): unknown | undefined {
  if (lane === "operator") return undefined;
  return {
    refused: "operator_only",
    detail: "The inbox stays at the console. Ask from the operator TUI, not from this room.",
  };
}

/**
 * Linear and email join the authored tool bank. They refuse when nothing is
 * connected, the same way generate_image refuses a missing key — so a session
 * built before /connect still works the moment the owner stores credentials.
 *
 * Email is operator-lane only: dumping a mailbox into Discord is a
 * cross-channel disclosure. Linear is the work tracker he was given access to,
 * so search/create/comment are available in every room.
 */
export function connectionTools(deps: CaptainDeps, lane: CaptainSessionLaneV2): ToolDefinition[] {
  return [
    defineTool({
      name: "linear_search",
      label: "Search Linear",
      description:
        "Search Linear issues. Use this when someone asks about a ticket, a project, or what is open. " +
        "'refused' with credential_unavailable means nobody has connected Linear yet (/connect linear).",
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 400 }),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 25 })),
      }),
      execute: async (_id, params) => json(await deps.linear.search(params.query, params.limit)),
    }),
    defineTool({
      name: "linear_get",
      label: "Read a Linear issue",
      description:
        "Read one Linear issue by id or identifier (ENG-123). Say when it is missing rather than inventing status.",
      parameters: Type.Object({
        id: Type.String({ minLength: 1, maxLength: 80 }),
      }),
      execute: async (_id, params) => json(await deps.linear.get(params.id)),
    }),
    defineTool({
      name: "linear_create",
      label: "Create a Linear issue",
      description:
        "Create a Linear issue. teamId is optional when /connect set a default team. A refusal is something to say, not retry.",
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 500 }),
        description: Type.Optional(Type.String({ maxLength: 8_000 })),
        teamId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      }),
      execute: async (_id, params) => json(await deps.linear.create(params)),
    }),
    defineTool({
      name: "linear_update",
      label: "Update a Linear issue",
      description: "Update a Linear issue's title or description. Pass the issue id or identifier.",
      parameters: Type.Object({
        id: Type.String({ minLength: 1, maxLength: 80 }),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
        description: Type.Optional(Type.String({ maxLength: 8_000 })),
      }),
      execute: async (_id, params) => json(await deps.linear.update(params)),
    }),
    defineTool({
      name: "linear_comment",
      label: "Comment on a Linear issue",
      description: "Add a comment to a Linear issue.",
      parameters: Type.Object({
        id: Type.String({ minLength: 1, maxLength: 80 }),
        body: Type.String({ minLength: 1, maxLength: 8_000 }),
      }),
      execute: async (_id, params) => json(await deps.linear.comment(params)),
    }),
    defineTool({
      name: "linear_teams",
      label: "List Linear teams",
      description: "List Linear teams you can file issues against, with their ids.",
      parameters: Type.Object({}),
      execute: async () => json(await deps.linear.teams()),
    }),
    defineTool({
      name: "email_list",
      label: "List recent mail",
      description:
        "List recent messages in a mailbox folder (default INBOX). Operator console only — never read mail into Discord. " +
        "'refused' with credential_unavailable means nobody has connected email yet (/connect email).",
      parameters: Type.Object({
        folder: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 25 })),
      }),
      execute: async (_id, params) => {
        const blocked = operatorOnly(lane);
        return json(blocked ?? (await deps.email.list(params)));
      },
    }),
    defineTool({
      name: "email_read",
      label: "Read a mail message",
      description: "Read one message by IMAP uid. Operator console only.",
      parameters: Type.Object({
        uid: Type.Number({ minimum: 1 }),
        folder: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      }),
      execute: async (_id, params) => {
        const blocked = operatorOnly(lane);
        return json(blocked ?? (await deps.email.read(params.uid, params.folder)));
      },
    }),
    defineTool({
      name: "email_search",
      label: "Search mail",
      description: "Search a mailbox folder by text. Operator console only.",
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 400 }),
        folder: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 25 })),
      }),
      execute: async (_id, params) => {
        const blocked = operatorOnly(lane);
        return json(blocked ?? (await deps.email.search(params.query, params)));
      },
    }),
    defineTool({
      name: "email_send",
      label: "Send mail",
      description:
        "Send an email from the connected mailbox. Operator console only. A refusal is something to say, not retry.",
      parameters: Type.Object({
        to: Type.String({ minLength: 3, maxLength: 320 }),
        subject: Type.String({ minLength: 1, maxLength: 500 }),
        text: Type.String({ minLength: 1, maxLength: 20_000 }),
      }),
      execute: async (_id, params) => {
        const blocked = operatorOnly(lane);
        return json(blocked ?? (await deps.email.send(params)));
      },
    }),
  ];
}
