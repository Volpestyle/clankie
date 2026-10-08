import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { MachineAccessRefused } from "@clankie/protocol";
import { ComputerRequestSchema } from "@clankie/interactive-environment";
import type { BodyConversationIdentity } from "./body-lease-router.ts";
import type { ComputerBody } from "./computer-body.ts";

export function registerComputerRoutes(
  app: Hono,
  options: {
    body?: ComputerBody;
    joined?: import("./joined-computer.ts").JoinedComputer;
    identity(request: Request, conversationId: string): Promise<BodyConversationIdentity | undefined>;
  },
): void {
  // A native Windows observation host uses this service's existing authority;
  // it cannot manufacture a machine grant from a conversation ID.
  app.post("/v1/computer/authority", bodyLimit({ maxSize: 4096 }), async (context) => {
    const parsed = z
      .strictObject({
        conversationId: ComputerRequestSchema.shape.conversationId,
        action: z.enum(["effect", "recover"]),
      })
      .safeParse(await context.req.json().catch(() => undefined));
    if (!parsed.success) return context.json({ error: "invalid_computer_authority_request" }, 400);
    const identity = await options.identity(context.req.raw, parsed.data.conversationId);
    const authorized =
      identity !== undefined &&
      identity.route?.mode === "machine" &&
      identity.current() &&
      (await identity.authorize("computer", parsed.data.action)) &&
      identity.current();
    return context.json({ conversationId: parsed.data.conversationId, authorized }, authorized ? 200 : 401, {
      "cache-control": "no-store",
    });
  });
  app.post("/v1/computer", bodyLimit({ maxSize: 2 * 1024 * 1024 }), async (context) => {
    let raw: unknown;
    try {
      raw = await context.req.json();
    } catch {
      return context.json({ error: "invalid_computer_request" }, 400);
    }
    const parsed = ComputerRequestSchema.safeParse(raw);
    if (!parsed.success) return context.json({ error: "invalid_computer_request" }, 400);
    const identity = await options.identity(context.req.raw, parsed.data.conversationId);
    if (identity === undefined) return context.json({ error: "computer_authorization_required" }, 401);
    if (parsed.data.machineId ? options.joined === undefined : options.body === undefined)
      return context.json({ error: "computer_body_unavailable" }, 503);
    try {
      const result = parsed.data.machineId
        ? await options.joined!.dispatch(identity, parsed.data.machineId, parsed.data.command)
        : await options.body!.dispatch(identity, parsed.data.command);
      return context.json(result as Record<string, unknown>, 200, { "cache-control": "no-store" });
    } catch (error) {
      if (error instanceof MachineAccessRefused)
        return context.json(
          {
            error: error.code,
            machine: error.machine,
            accessLevel: error.accessLevel,
            required: error.required,
            detail: error.message,
          },
          403,
        );
      // Never expose native logs, private snapshot IDs, or filesystem paths in an error.
      return context.json(
        {
          error: "computer_request_refused",
          retry: "observe_status; never replay input with a new requestId",
        },
        409,
      );
    }
  });
}
