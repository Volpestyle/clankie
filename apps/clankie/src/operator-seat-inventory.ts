import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resourceNativeHelperPath } from "@clankie/fleet-resources";
import { z } from "zod";
import type { OperatorSeatBindings } from "./operator-seat-bindings.ts";
import type { OperatorSeatBindingStatus } from "@clankie/protocol";

export function operatorSeatPolicy(root: string): "observe" | "enforce" {
  return z
    .object({ schemaVersion: z.literal(1), mode: z.enum(["observe", "enforce"]) })
    .strict()
    .parse(JSON.parse(readFileSync(`${root}/apps/clankie/operator-seat-policy.json`, "utf8"))).mode;
}

const Census = z
  .object({
    schemaVersion: z.literal(1),
    seats: z
      .array(
        z
          .object({
            pid: z.number().int().positive(),
            startTime: z.string().min(1),
            command: z.string(),
            nativeSessionOnly: z.boolean().optional(),
            conversationId: z.string().nullable(),
            sessionId: z.uuid().nullable(),
            processes: z
              .array(z.object({ pid: z.number().int().positive(), startTime: z.string() }))
              .min(1)
              .max(1024),
          })
          .strict(),
      )
      .max(1024),
  })
  .strict();

/** Fresh local launcher discovery; a failed or changing census never means all seats are ready. */
export async function operatorSeatInventory(
  bindings: OperatorSeatBindings,
): Promise<NonNullable<OperatorSeatBindingStatus["inventory"]>> {
  try {
    const stdout = await new Promise<string>((resolve, reject) =>
      execFile(
        process.platform === "darwin" ? "/usr/bin/python3" : "python3",
        ["-I", resourceNativeHelperPath(), "operator-seats"],
        { timeout: 12_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      ),
    );
    const census = Census.parse(JSON.parse(stdout));
    const seats = await Promise.all(
      census.seats.map(async (seat) => {
        const registered = await bindings.registeredLauncher(seat.pid, seat.startTime);
        const controller = registered ?? (await bindings.registeredLauncher(seat.pid, seat.startTime, false));
        return {
          ...seat,
          bound: registered !== undefined,
          state: registered
            ? ("bound" as const)
            : controller
              ? ("bridge-pending" as const)
              : ("unregistered" as const),
          ...(controller === undefined ? {} : { conversationId: controller }),
          ...(registered === undefined
            ? {
                recovery: controller
                  ? "The launcher registered; its bridge is still starting or awaiting a trust/hook prompt. Wait for that exact bridge; do not start a replacement session."
                  : "Unregistered launcher: preserve the exact native session and profile; use clankie doctor for its recovery. An older launcher without registration needs exact-session migration; a current launcher may still be starting. Do not replay an uncertain call.",
              }
            : {}),
        };
      }),
    );
    return { complete: true, ready: seats.every((seat) => seat.bound), seats };
  } catch {
    return { complete: false, ready: false, seats: [], error: "operator_seat_inventory_unavailable" };
  }
}
