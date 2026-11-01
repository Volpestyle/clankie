import { ExtensionSupervisor } from "@clankie/extension";
import type { CredentialStore } from "@clankie/credential-broker";
import type { PublicGatewayDoorwayState } from "@clankie/protocol/public-gateway";
import type { SettingsStore } from "@clankie/settings";
import type { BrowserToolPort, ClankieAppDependencies } from "./app/types.ts";
import type { BodyLeaseStore } from "./body-leases.ts";
import type { MachineJoins } from "./machine-joins.ts";
import type { ExtensionRoutes } from "./ports/routes.ts";
import type { PushWakeSender } from "./push.ts";

/**
 * The core's side of ADR 0328: the ports extensions may name, and what their
 * projections may add. Only the composition root builds this and adds
 * extensions to it; the rest of the core reads projections, never an
 * extension's own module.
 */
/** Each doorway transition, metadata only, for the host's telemetry. */
export type DoorwayChange =
  | { readonly state: "connected" | "sign_in_required" }
  | { readonly state: "disconnected"; readonly retryInMs: number; readonly closeCode?: number };

export interface CorePorts {
  readonly credentials: CredentialStore;
  readonly env: NodeJS.ProcessEnv;
  /** The service's own HTTP port and the phone relay's, on loopback. */
  readonly servicePorts: { readonly port: number; readonly relayPort: number };
  readonly logger: {
    info(fields: Readonly<Record<string, unknown>>, message: string): void;
    warn(fields: Readonly<Record<string, unknown>>, message: string): void;
    error(fields: Readonly<Record<string, unknown>>, message: string): void;
  };
  /** Where the service keeps its capabilities' own state. */
  readonly capabilityStateRoot: string;
  /** Where files the captain sends or saves are kept. */
  readonly attachmentRoot: string;
  /** Live settings, read when a choice is made rather than at startup. */
  readonly settings: SettingsStore;
  /** The service's own state directory. */
  readonly stateRoot: string;
  /** Leases on Clankie's own body. Only the full service has them, not a dormant body. */
  readonly bodyLeaseStore?: BodyLeaseStore;
  /** Machines joined to this one. Only the full service has them. */
  readonly machineJoins?: MachineJoins;
  /** Runs once the service's HTTP server listens, or at once if it already does. */
  whenListening(run: () => void): void;
  readonly onDoorwayChange?: (change: DoorwayChange) => void;
}

/** A gateway connection the relay extension adds: pairing offers, wakes and the doorway's state. */
export interface DoorwayProjection {
  readonly connector?: NonNullable<ClankieAppDependencies["pairingOfferPublisher"]> &
    PushWakeSender & { readonly doorway: PublicGatewayDoorwayState; readonly hostBaseUrl: string };
  /** Set when the account credential was rejected before a connector could exist. */
  readonly signInRequiredSince?: string;
}

export interface CoreProjection {
  readonly doorway?: DoorwayProjection;
  /** HTTP routes the extension adds, mounted by the app (ports/routes.ts). */
  readonly routes?: ExtensionRoutes;
  /** The browser extension's tools, from its host's catalog and calls. */
  readonly browser?: BrowserToolPort;
}

export type CoreExtensions = ExtensionSupervisor<CorePorts, CoreProjection>;

export function createCoreExtensions(ports: CorePorts): CoreExtensions {
  return new ExtensionSupervisor<CorePorts, CoreProjection>({
    ports,
    onDegraded: (id, reason) =>
      ports.logger.warn(
        { event: "extension.degraded", extension: id, reason },
        "an extension stopped working",
      ),
  });
}

/** Every running extension's routes, for the app to mount. */
export function routesOf(extensions: CoreExtensions): readonly ExtensionRoutes[] {
  return extensions
    .projections()
    .flatMap((projection) => (projection.routes === undefined ? [] : [projection.routes]));
}

/** The browser tools a running extension adds, if any. */
export function browserOf(extensions: CoreExtensions): BrowserToolPort | undefined {
  return extensions.projections().find((projection) => projection.browser !== undefined)?.browser;
}

/** The first projection that carries a doorway, if any extension added one. */
export function doorwayOf(extensions: CoreExtensions): DoorwayProjection | undefined {
  return extensions.projections().find((projection) => projection.doorway !== undefined)?.doorway;
}
