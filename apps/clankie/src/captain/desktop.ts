import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { DesktopSettings } from "@clankie/settings";
import { desktopIsQuiet } from "@clankie/settings";
import {
  DesktopAnimationSchema,
  DesktopExpressionSchema,
  type DesktopExpression,
} from "@clankie/protocol/presence";

const duration = z.number().int().min(1000).max(30000).default(5000);
const DesktopRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("emote"), animation: DesktopAnimationSchema, durationMs: duration }).strict(),
  z
    .object({ kind: z.literal("say"), text: z.string().trim().min(1).max(200), durationMs: duration })
    .strict(),
  z
    .object({
      kind: z.literal("move"),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      durationMs: duration,
    })
    .strict(),
]);

/** One bounded, process-local expression, independent of the source-derived mood. */
export class DesktopExpressions {
  private expression: DesktopExpression | undefined;
  private readonly settings: () => Promise<DesktopSettings>;
  private readonly now: () => number;
  constructor(settings: () => Promise<DesktopSettings>, now: () => number = Date.now) {
    this.settings = settings;
    this.now = now;
  }

  async publish(input: unknown) {
    const request = DesktopRequestSchema.parse(input);
    const settings = await this.settings();
    const now = this.now();
    if (desktopIsQuiet(settings, new Date(now))) {
      this.expression = undefined;
      return { outcome: "quiet_hours" as const };
    }
    const { durationMs, ...body } = request;
    this.expression = DesktopExpressionSchema.parse({
      ...body,
      id: randomUUID(),
      expiresAt: new Date(now + durationMs).toISOString(),
    });
    return { outcome: "published" as const, expression: this.expression };
  }

  async current(): Promise<DesktopExpression | undefined> {
    if (this.expression === undefined) return undefined;
    const settings = await this.settings();
    const now = this.now();
    if (Date.parse(this.expression.expiresAt) <= now || desktopIsQuiet(settings, new Date(now))) {
      this.expression = undefined;
    }
    return this.expression;
  }
}

export function desktopTools(desktop: DesktopExpressions | undefined): ToolDefinition[] {
  if (desktop === undefined) return [];
  const durationMs = Type.Optional(Type.Integer({ minimum: 1000, maximum: 30000 }));
  return [
    defineTool({
      name: "desktop",
      label: "Express on the desktop",
      description:
        "Emote, say a short line, or move your desktop body when you choose. One transient expression replaces the previous one; default duration is five seconds, maximum thirty. Move coordinates are normalized 0–1 across the current display (x left to right, y top to bottom); the client keeps you on screen. Publication is not proof a desktop is connected or displayed it. Quiet hours suppress expressions. Clients honor expiry and Focus and never take keyboard focus. This does not change your actual mood or send a chat message.",
      parameters: Type.Union([
        Type.Object(
          {
            kind: Type.Literal("emote"),
            animation: Type.Union(DesktopAnimationSchema.options.map((name) => Type.Literal(name))),
            durationMs,
          },
          { additionalProperties: false },
        ),
        Type.Object(
          { kind: Type.Literal("say"), text: Type.String({ minLength: 1, maxLength: 200 }), durationMs },
          { additionalProperties: false },
        ),
        Type.Object(
          {
            kind: Type.Literal("move"),
            x: Type.Number({ minimum: 0, maximum: 1 }),
            y: Type.Number({ minimum: 0, maximum: 1 }),
            durationMs,
          },
          { additionalProperties: false },
        ),
      ]),
      execute: async (_id, params) => {
        const result = await desktop.publish(params);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }),
  ];
}
