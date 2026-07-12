import { runWorkerAdapterContract } from "../../worker-sdk/test/worker-contract.ts";
import { SimulatedWorkerAdapter } from "../src/index.ts";

runWorkerAdapterContract(
  "simulated",
  () => {
    let assigned = false;
    return {
      adapter: new SimulatedWorkerAdapter({
        id: "sim-contract",
        kinds: ["implementation"],
        handlers: {
          implementation: (context) => {
            assigned = context.task.id === "task-contract";
            return {
              status: "succeeded",
              summary: "Simulation contract complete.",
              evidence: [{ kind: "log", label: "sim-contract", summary: "simulated" }],
              outputs: { nativeSessionId: null },
            };
          },
        },
      }),
      assigned: () => assigned,
      nativeSessionId: null,
    };
  },
  () => ({
    adapter: new SimulatedWorkerAdapter({
      id: "sim-contract",
      kinds: ["implementation"],
      latencyMs: 60_000,
      handlers: {},
    }),
    nativeSessionId: null,
  }),
);
