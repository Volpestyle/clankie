import type { HerdrBinding } from "@clankie/protocol";

/** Private app-servers belong to a view allocated by the service, including pending startup. */
export class LocalCodexSeats {
  private readonly seats = new Map<number, { pane: string; binding: HerdrBinding }>();
  private readonly binding: () => HerdrBinding | undefined;
  constructor(binding: () => HerdrBinding | undefined) {
    this.binding = binding;
  }

  register(pid: number, pane: string): () => void {
    const binding = this.binding();
    if (!binding || !Number.isSafeInteger(pid) || pid <= 1 || pane.includes("/")) return () => {};
    const entry = { pane, binding };
    this.seats.set(pid, entry);
    return () => {
      if (this.seats.get(pid) === entry) this.seats.delete(pid);
    };
  }

  allows(ancestors: readonly number[], pane: string, binding: HerdrBinding): boolean {
    return ancestors.some((pid) => {
      const seat = this.seats.get(pid);
      return (
        seat?.pane === pane &&
        seat.binding.socketPath === binding.socketPath &&
        seat.binding.session === binding.session
      );
    });
  }
}
