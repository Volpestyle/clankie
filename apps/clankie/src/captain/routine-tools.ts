import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { RoutineCommandSchema } from "@clankie/protocol";
import { assertConversationAuthority, captureConversationAuthority } from "./conversation-owner.ts";
import type { HerdrWatchPort } from "./herdr-watch.ts";
import { toolJson, type TurnContext } from "./tools.ts";

const ID = Type.String({ pattern: "^rt_[a-z0-9]{8,32}$", description: "Routine id from list." });

/** The lead's `routine` tool: this conversation's recurring jobs, through the owner's API (ADR 0265). */
export function routineTool(
  routines: NonNullable<HerdrWatchPort["routines"]>,
  turn: TurnContext,
): ToolDefinition {
  return {
    name: "routine",
    label: "Manage routines",
    description:
      'Recurring scheduled jobs for this conversation, so "every morning…" can mean it. A routine has a name, a schedule ' +
      '(plain language such as "every weekday at 9:00", "every friday at 17:30", "every 2 hours", or five cron fields, in the ' +
      "owner's time zone unless timeZone is given) and a target: turn (a turn here with your prompt), hire (hire_agent's fields " +
      "plus a brief, led by this conversation) or check (a command run through `clankie heavy` in a directory; the result " +
      "comes here on failure, or always). missed decides what happens after the Mac slept through runs: catch_up runs once " +
      "on wake, skip logs and waits for the next. Runs never overlap and never repeat a slot across restarts. A routine acts " +
      "with this conversation's authority and no more; you see and change only routines that target this conversation. " +
      "The owner manages every routine from the CLI (`clankie routines`), the TUI and the app. history lists runs newest first.",
    parameters: Type.Union([
      Type.Object({ action: Type.Literal("list") }),
      Type.Object({
        action: Type.Literal("add"),
        name: Type.String({ minLength: 1, maxLength: 80 }),
        when: Type.String({ minLength: 1, maxLength: 200 }),
        timeZone: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        target: Type.Object(
          {
            kind: Type.Union([Type.Literal("turn"), Type.Literal("hire"), Type.Literal("check")]),
            prompt: Type.Optional(Type.String({ description: "turn: what to do each run." })),
            hire: Type.Optional(
              Type.Object(
                {},
                {
                  additionalProperties: true,
                  description:
                    "hire: hire_agent's fields (title, role, workingDirectory, harness, account, …).",
                },
              ),
            ),
            brief: Type.Optional(Type.String({ description: "hire: the worker's first prompt each run." })),
            command: Type.Optional(
              Type.Array(Type.String(), { description: "check: argv, run through clankie heavy." }),
            ),
            workingDirectory: Type.Optional(Type.String({ description: "check: absolute path to run in." })),
            timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
            report: Type.Optional(Type.Union([Type.Literal("always"), Type.Literal("failure")])),
          },
          { additionalProperties: false },
        ),
        missed: Type.Optional(Type.Union([Type.Literal("catch_up"), Type.Literal("skip")])),
        enabled: Type.Optional(Type.Boolean()),
      }),
      Type.Object({
        action: Type.Literal("edit"),
        id: ID,
        name: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
        when: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        timeZone: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
        missed: Type.Optional(Type.Union([Type.Literal("catch_up"), Type.Literal("skip")])),
      }),
      Type.Object({
        action: Type.Union([
          Type.Literal("pause"),
          Type.Literal("resume"),
          Type.Literal("run_now"),
          Type.Literal("remove"),
        ]),
        id: ID,
      }),
      Type.Object({
        action: Type.Literal("history"),
        id: Type.Optional(ID),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      }),
    ]),
    executionMode: "sequential",
    execute: async (_id: string, input: Record<string, unknown>) => {
      const authority = captureConversationAuthority(turn.conversationAuthority);
      await assertConversationAuthority(authority);
      const conversationId = authority.owner.conversationId;
      const { when, timeZone, target, ...rest } = input as {
        when?: string;
        timeZone?: string;
        target?: Record<string, unknown>;
      } & Record<string, unknown>;
      const command = RoutineCommandSchema.parse({
        ...rest,
        ...(when === undefined
          ? {}
          : { schedule: { when, ...(timeZone === undefined ? {} : { timeZone }) } }),
        ...(target === undefined ? {} : { target: { ...target, conversationId } }),
      });
      return toolJson(await routines(command, conversationId));
    },
  } as ToolDefinition;
}
