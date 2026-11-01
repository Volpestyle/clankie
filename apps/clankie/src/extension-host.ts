import { ExtensionSupervisor } from "@clankie/extension";
import type { CredentialStore } from "@clankie/credential-broker";
import type { PublicGatewayDoorwayState } from "@clankie/protocol/public-gateway";
import type { SettingsStore } from "@clankie/settings";
import type { BrowserToolPort, ClankieAppDependencies } from "./app/types.ts";
import type { BodyLeaseStore } from "./body-leases.ts";
import type { MachineJoins } from "./machine-joins.ts";
import type { DeliveredFileStore } from "./delivered-files.ts";
import type { AppearancePort } from "./ports/appearance.ts";
import type { DiagramPort, MediaGeneratorPort, SkinDraftPort } from "./ports/media.ts";
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
  /** Where `clankie.json` is read from: the repo root. Only the full service has it. */
  readonly repoRoot?: string;
  /** Files the captain sent or received. Only the full service has them. */
  readonly deliveredFiles?: Pick<DeliveredFileStore, "attachment" | "read">;
  /**
   * His look, read when a picture of him is made. The persona extension fills
   * it; it reads empty while the persona is off.
   */
  readonly appearance?: AppearancePort;
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
  /** His drawing hand, when the media extension has the tldraw app. */
  readonly diagrams?: DiagramPort;
  /** The browser extension's tools, from its host's catalog and calls. */
  readonly browser?: BrowserToolPort;
  /** Image and video generation and skin drafts, while the media extension runs. */
  readonly media?: MediaProjection;
  /** His look, from the persona extension's images. */
  readonly appearance?: AppearancePort;
}

/** What the media extension adds: his generators and the owner's skin drafts. */
export interface MediaProjection {
  readonly generator: MediaGeneratorPort & { localPath(artifactRef: string): string };
  readonly skinDrafts: SkinDraftPort;
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

/**
 * The owner's switch (ADR 0328) on top of the extension's own requirement:
 * `off` keeps it off, `on` or no entry leaves the requirement to decide.
 */
export function switchedOn(
  settings: { readonly extensions: Readonly<Record<string, "on" | "off">> },
  id: string,
  requirementMet = true,
): boolean {
  return settings.extensions[id] !== "off" && requirementMet;
}

/** The first running extension's addition under one projection key, if any. */
export function projected<Key extends keyof CoreProjection>(
  extensions: CoreExtensions,
  key: Key,
): NonNullable<CoreProjection[Key]> | undefined {
  for (const projection of extensions.projections()) {
    const value = projection[key];
    if (value !== undefined) return value as NonNullable<CoreProjection[Key]>;
  }
  return undefined;
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
