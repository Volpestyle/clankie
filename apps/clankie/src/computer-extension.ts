import { join } from "node:path";
import type { ClankieExtension } from "@clankie/extension";
import { ComputerBody } from "./computer-body.ts";
import { computerRoutes } from "./computer-http.ts";
import { PeekabooComputerAdapter } from "./computer-peekaboo.ts";
import type { CorePorts, CoreProjection } from "./extension-host.ts";
import { JoinedComputer } from "./joined-computer.ts";
import { requireMachineAccess } from "./machine-access.ts";

/**
 * Clankie's own computer body as an ADR 0328 extension: the Mac's screen and
 * input through Peekaboo, and the screens of joined machines. It adds the
 * computer routes; which hired harnesses can do computer work stays in core.
 */
export const computerExtension: ClankieExtension<
  undefined,
  CorePorts,
  "stateRoot" | "settings" | "bodyLeaseStore" | "machineJoins",
  CoreProjection
> = {
  contractVersion: 1,
  id: "computer",
  settings: { key: "computer", schema: { parse: () => undefined } },
  needs: ["stateRoot", "settings", "bodyLeaseStore", "machineJoins"],
  create(host) {
    let routes: CoreProjection["routes"];
    return {
      async start() {
        const { bodyLeaseStore, machineJoins, settings } = host;
        if (bodyLeaseStore === undefined || machineJoins === undefined)
          throw new Error("the computer needs the full service's body leases and machine joins");
        const body =
          process.platform === "darwin"
            ? new ComputerBody(
                new PeekabooComputerAdapter(),
                bodyLeaseStore,
                join(host.stateRoot, "body"),
                () => requireMachineAccess(settings, "local", "screen"),
              )
            : undefined;
        routes = computerRoutes({
          ...(body === undefined ? {} : { body }),
          joined: new JoinedComputer(machineJoins, settings),
        });
      },
      async stop() {},
      health: () => ({ state: "ready" }),
      projection: () => (routes === undefined ? {} : { routes }),
    };
  },
};
