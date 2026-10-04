import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { QuestionDraftSchema } from "./conversation-questions.ts";
import { toolJson, type TurnContext } from "./tools.ts";

export function questionTools(turn: TurnContext): ToolDefinition[] {
  return [
    defineTool({
      name: "request_user_input",
      label: "Ask the owner",
      description:
        "Ask one bounded text or choice preference question in the current owner workspace conversation. Returns pending metadata immediately; a later authenticated answer starts a separate attributed turn. Choices are context/preferences only, never approval, enrollment, permission, tracker initialization or settings writes. No room or native-seat questions. Do not repeat a pending or uncertain request; inspect the returned ID. You decide when a question is useful.",
      parameters: Type.Object(
        {
          kind: Type.Union([Type.Literal("text"), Type.Literal("choice")]),
          prompt: Type.String({ minLength: 1, maxLength: 2000 }),
          options: Type.Optional(
            Type.Array(
              Type.Object(
                {
                  label: Type.String({ minLength: 1, maxLength: 200 }),
                  description: Type.Optional(Type.String({ maxLength: 500 })),
                },
                { additionalProperties: false },
              ),
              { maxItems: 8 },
            ),
          ),
          allowFreeform: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      execute: async (_id, input) => {
        const request = turn.requestQuestion;
        if (!request) throw new Error("Questions require a current owner workspace conversation");
        return toolJson(await request(QuestionDraftSchema.parse(input)));
      },
    }),
  ];
}
