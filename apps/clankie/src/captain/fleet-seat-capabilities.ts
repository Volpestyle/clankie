import type { FleetSeatInputCapabilities } from "@clankie/protocol";
import type { HerdrAgentSnapshot } from "./herdr-watch.ts";

/** Fresh display observations only; delivery still revalidates its own native proof. */
export async function readFleetSeatCapabilities(
  seats: readonly (HerdrAgentSnapshot | undefined)[],
  read: (seat: HerdrAgentSnapshot) => Promise<FleetSeatInputCapabilities>,
): Promise<(FleetSeatInputCapabilities | undefined)[]> {
  const results: (FleetSeatInputCapabilities | undefined)[] = Array.from(
    { length: seats.length },
    () => undefined,
  );
  const failures: { index: number; error: unknown }[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, seats.length) }, async () => {
      while (next < seats.length && failures.length === 0) {
        const index = next++;
        const seat = seats[index];
        if (!seat) continue;
        try {
          results[index] = await read(seat);
        } catch (error) {
          failures.push({ index, error });
        }
      }
    }),
  );
  // Drain started observations before rejecting, so a failed refresh leaves no
  // background reads competing with the next one. Preserve the original error.
  if (failures.length) throw failures.sort((a, b) => a.index - b.index)[0]!.error;
  return results;
}
