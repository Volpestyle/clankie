import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { ObservedFleet, ObservedFleetSeat, ObservedHeadSeat } from "./herdr-census.ts";

const StateSchema = z
  .object({
    schemaVersion: z.literal(1),
    edges: z
      .array(
        z
          .object({
            child: z.string(),
            parent: z.string(),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();

/** An observed launcher edge is provenance, never adoption or permission. */
export class HerdrParentEdges {
  private state: z.infer<typeof StateSchema>;
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
    this.state = { schemaVersion: 1, edges: [] };
    try {
      this.state = StateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      // Lost provenance denies historical ancestry without blocking current
      // native observations. Keep the file until a valid observation replaces it.
    }
  }
  private identity(seat: ObservedFleetSeat | ObservedHeadSeat): string | undefined {
    if (!seat.session) return undefined;
    const file = seat.session.value
      .split(/[\\/]/u)
      .at(-1)
      ?.replace(/\.jsonl$/u, "");
    const session =
      seat.session.kind === "id"
        ? seat.session.value
        : (file?.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu)?.[1] ?? file);
    if (!session) return undefined;
    const fleet = seat.seatId.includes("/") ? seat.seatId.slice(0, seat.seatId.indexOf("/")) : "default";
    return JSON.stringify([fleet, seat.harness, session]);
  }
  public observe(fleet: ObservedFleet): ObservedFleet {
    const all = [...fleet.seats, ...(fleet.head ? [fleet.head] : [])];
    const counts = new Map<string, number>();
    for (const seat of all) {
      const key = this.identity(seat);
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let edges = this.state.edges.filter((edge) => (counts.get(edge.child) ?? 0) < 2);
    for (const child of fleet.seats) {
      if (!child.parentPaneId) continue;
      const parents = all.filter((seat) => seat.paneId === child.parentPaneId);
      const key = this.identity(child);
      const parent = parents.length === 1 ? this.identity(parents[0]!) : undefined;
      if (key) {
        edges = edges.filter((edge) => edge.child !== key);
        if (
          parent &&
          key !== parent &&
          all.filter((seat) => this.identity(seat) === key).length === 1 &&
          all.filter((seat) => this.identity(seat) === parent).length === 1
        )
          edges.push({ child: key, parent });
      }
    }
    edges = edges.slice(-1000);
    if (JSON.stringify(edges) !== JSON.stringify(this.state.edges)) this.save({ schemaVersion: 1, edges });
    return {
      ...fleet,
      seats: fleet.seats.map((child) => {
        // A new actual ancestry always wins. Only a missing reset edge can use history.
        if (child.parentPaneId) return child;
        const key = this.identity(child);
        if (!key || all.filter((seat) => this.identity(seat) === key).length !== 1) return child;
        const edge = this.state.edges.find((candidate) => candidate.child === key);
        if (!edge) return child;
        const parents = all.filter((seat) => this.identity(seat) === edge.parent);
        if (parents.length !== 1 || parents[0]!.paneId === child.paneId) return child;
        return { ...child, parentPaneId: parents[0]!.paneId };
      }),
    };
  }
  private save(next: z.infer<typeof StateSchema>) {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const file = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(file, `${JSON.stringify(next)}\n`);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, this.path);
    const directory = openSync(dirname(this.path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    this.state = next;
  }
}
