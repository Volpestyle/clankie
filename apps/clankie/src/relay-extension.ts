import type { ClankieExtension } from "@clankie/extension";
import type { ClankieSettings } from "@clankie/settings";
import { connectBodyToGateway, type BodyConnection } from "./body-doorway.ts";
import type { CoreProjection, CorePorts } from "./extension-host.ts";

/**
 * The clankie.bot relay as an ADR 0328 extension: the phone's encrypted
 * doorway through the public gateway. It builds its connector when started,
 * before the app, so restored pairing routes reach it, and connects only once
 * the service listens.
 */
export const relayExtension: ClankieExtension<
  ClankieSettings["publicGateway"],
  CorePorts,
  "credentials" | "env" | "servicePorts" | "logger" | "whenListening" | "onDoorwayChange",
  CoreProjection
> = {
  contractVersion: 1,
  id: "relay",
  // The settings store has already validated this section.
  settings: { key: "publicGateway", schema: { parse: (input) => input as ClankieSettings["publicGateway"] } },
  needs: ["credentials", "env", "servicePorts", "logger", "whenListening", "onDoorwayChange"],
  create(host, publicGateway) {
    let connection: BodyConnection = {};
    return {
      async start() {
        connection = await connectBodyToGateway({
          publicGateway,
          store: host.credentials,
          env: host.env,
          port: host.servicePorts.port,
          relayPort: host.servicePorts.relayPort,
          logger: host.logger,
          ...(host.onDoorwayChange === undefined ? {} : { onDoorwayChange: host.onDoorwayChange }),
        });
        const connector = connection.connector;
        if (connector !== undefined) host.whenListening(() => connector.start());
      },
      async stop() {
        connection.connector?.close();
      },
      // A sign-in the account needs is the doorway's own state, shown on /health, not a fault.
      health: () => ({ state: "ready" }),
      projection: () => ({
        doorway: {
          ...(connection.connector === undefined ? {} : { connector: connection.connector }),
          ...(connection.signInRequiredSince === undefined
            ? {}
            : { signInRequiredSince: connection.signInRequiredSince }),
        },
      }),
    };
  },
};
