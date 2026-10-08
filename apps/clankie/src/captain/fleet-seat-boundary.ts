import type { HarnessSeatAdapter, SeatControl } from "@clankie/agent-hosts";

/** A removed connection releases authority, without stopping its native worker. */
export function fenceFleetSeatAdapter(
  adapter: HarnessSeatAdapter,
  current: () => Promise<boolean>,
): HarnessSeatAdapter {
  const detail = "Machine connection changed or disconnected";
  const admit = async () => {
    if (!(await current())) throw new Error(detail);
  };
  const fence = (control: SeatControl): SeatControl => ({
    ...control,
    ref: control.ref,
    ...(control.refreshToolCatalog === undefined
      ? {}
      : {
          refreshToolCatalog: async (input) => {
            await admit();
            const result = await control.refreshToolCatalog!({
              ...input,
              beforeDispatch: async () => {
                await admit();
                await input?.beforeDispatch?.();
                await admit();
              },
            });
            await admit();
            return result;
          },
        }),
    send: async (message, options) =>
      (await current()) ? control.send(message, options) : { outcome: "offline", detail },
    status: async () => ((await current()) ? control.status() : "offline"),
    interrupt: async () => ((await current()) ? control.interrupt() : false),
    ...(control.stopTask === undefined
      ? {}
      : {
          stopTask: async (guard: () => Promise<void>) =>
            control.stopTask!(async () => {
              await admit();
              await guard();
              await admit();
            }),
        }),
    close: async () => {
      if (await current()) await control.close();
    },
    ...(control.verify === undefined
      ? {}
      : {
          verify: async () => {
            await admit();
            const proof = await control.verify!();
            await admit();
            return proof;
          },
        }),
    ...(control.exit === undefined
      ? {}
      : {
          exit: async (beforeExit) => {
            await admit();
            await control.exit!(async () => {
              await admit();
              await beforeExit?.();
              await admit();
            });
          },
        }),
    settled: async (signal) => {
      if (!(await current())) return { type: "released", at: new Date().toISOString() };
      const event = await control.settled(signal);
      return (await current()) ? event : { type: "released", at: new Date().toISOString() };
    },
  });
  return {
    harness: adapter.harness,
    ...(adapter.prepare === undefined
      ? {}
      : {
          prepare: async (launch, signal) => {
            await admit();
            const prepared = await adapter.prepare!(launch, signal);
            try {
              await admit();
            } catch (error) {
              await prepared.dispose();
              throw error;
            }
            return {
              ...prepared,
              verify: async (ref) => {
                await admit();
                const proof = await prepared.verify(ref);
                await admit();
                return proof;
              },
              start: async (view, startSignal) => {
                await admit();
                const result = await prepared.start(
                  {
                    ...view,
                    guard: async () => {
                      await admit();
                      await view.guard?.();
                      await admit();
                    },
                  },
                  startSignal,
                );
                if (!(await current())) {
                  await prepared.dispose();
                  return { outcome: "failed", reason: "not_ready", detail };
                }
                return result.outcome === "started" ? { ...result, control: fence(result.control) } : result;
              },
            };
          },
        }),
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
