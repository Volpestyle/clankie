import type { HarnessSeatAdapter, SeatControl } from "@clankie/agent-hosts";

/** A removed connection releases authority, without stopping its native worker. */
export function fenceFleetSeatAdapter(
  adapter: HarnessSeatAdapter,
  current: () => Promise<boolean>,
): HarnessSeatAdapter {
  const detail = "Machine connection changed or disconnected";
  const fence = (control: SeatControl): SeatControl => ({
    ref: control.ref,
    send: async (message, options) =>
      (await current()) ? control.send(message, options) : { outcome: "offline", detail },
    status: async () => ((await current()) ? control.status() : "offline"),
    interrupt: async () => ((await current()) ? control.interrupt() : false),
    close: async () => {
      if (await current()) await control.close();
    },
    settled: async (signal) => {
      if (!(await current())) return { type: "released", at: new Date().toISOString() };
      const event = await control.settled(signal);
      return (await current()) ? event : { type: "released", at: new Date().toISOString() };
    },
  });
  return {
    harness: adapter.harness,
    start: async (launch, view, signal) => {
      if (!(await current())) return { outcome: "failed", reason: "not_ready", detail };
      const result = await adapter.start(launch, view, signal);
      return result.outcome === "started" ? { ...result, control: fence(result.control) } : result;
    },
    attach: async (ref) => {
      if (!(await current())) return undefined;
      const control = await adapter.attach(ref);
      return control === undefined ? undefined : fence(control);
    },
  };
}
