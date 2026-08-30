/**
 * The body seam. One interface, implemented by whatever is holding the
 * cartridge — today that is Clankie's seat in a hosted PokeAgents world
 * ([ADR 0129](../../../docs/adr/0129-each-player-owns-a-body.md)).
 *
 * The mind above it does not branch on where the body is, so this file
 * deliberately carries no transport, no core, and no game specifics: only
 * what a player can ask a body to do, and what it hands back.
 */
import type {
  EnvironmentActionResult,
  GbaEmulatorAction,
  GbaEmulatorObservation,
  GbaEmulatorObservationKind,
} from "@clankie/interactive-environment";

export interface GbaDriverIo {
  observe(kind: GbaEmulatorObservationKind): GbaEmulatorObservation;
  act(action: GbaEmulatorAction): Promise<EnvironmentActionResult>;
  pause(reason: string): Promise<void>;
  /** Undo a pause. A safety pause must be reversible by the mind that judged the state safe again. */
  resume(): Promise<void>;
}

export interface GbaDriverView {
  danger: Extract<GbaEmulatorObservation, { kind: "danger" }>;
  overworld: Extract<GbaEmulatorObservation, { kind: "overworld" }>;
  battle: Extract<GbaEmulatorObservation, { kind: "battle" }> | null;
  dialog: Extract<GbaEmulatorObservation, { kind: "dialog" }> | null;
  menu?: Extract<GbaEmulatorObservation, { kind: "menu" }> | null;
}
