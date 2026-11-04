import { availableParallelism, release, totalmem } from "node:os";
import { createResourceGovernor } from "@clankie/fleet-resources";
import { resolveFleetResourcePolicy } from "@clankie/protocol";
import {
  JoinedMachineResourceRequestSchema,
  JoinedMachineResourceResultSchema,
} from "@clankie/protocol/machine-join";
import type { JoinedMachinePorts } from "./joined-machine-client.ts";

/** One native registry per physical host, shared with every local `clankie heavy`. */
export function joinedMachineResourcePorts(
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    release?: string;
    /** Test seam only; never accepted from a join request or runtime environment. */
    directory?: string;
  } = {},
): Pick<JoinedMachinePorts, "resources" | "closeResources"> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  // WSL cannot have a separate Linux budget alongside Windows' native commands.
  const supported =
    platform === "darwin" ||
    (platform === "linux" &&
      !/microsoft/iu.test(options.release ?? release()) &&
      !env.WSL_INTEROP &&
      !env.WSL_DISTRO_NAME);
  const governor = supported
    ? createResourceGovernor(options.directory ? { directory: options.directory } : {})
    : undefined;
  return {
    async resources(raw, signal, guard) {
      const request = JoinedMachineResourceRequestSchema.parse(raw);
      guard();
      if (!governor) return { status: "unavailable", reason: "unsupported-platform" };
      const specs = {
        platform: platform === "darwin" ? ("darwin" as const) : ("linux" as const),
        cores: availableParallelism(),
        memoryBytes: totalmem(),
      };
      const snapshot =
        request.action === "configure"
          ? await governor.configure(resolveFleetResourcePolicy(request.policy, specs), {
              signal,
              beforeWrite: guard,
            })
          : await governor.snapshot();
      guard();
      return JoinedMachineResourceResultSchema.parse({
        status: "available",
        specs,
        snapshot:
          platform === "darwin"
            ? snapshot
            : { ...snapshot, capacity: { ...snapshot.capacity, simulatorSlots: 0 } },
      });
    },
    async closeResources() {
      // This observer never starts jobs. Closing it leaves other heavy runners alone.
      await governor?.close();
    },
  };
}
