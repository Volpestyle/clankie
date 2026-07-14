import type { TerminalCapabilities, TerminalFrame } from "@clankie/terminal-protocol";
import type {
  TerminalObservation,
  TerminalResumeDisposition,
  TerminalSnapshotProjection,
} from "./terminals.ts";

/** Runner-internal source boundary consumed by the provider-neutral terminal gateway. */
export interface TerminalSourceProvider {
  /** Refresh external discovery state. Native PTYs implement this as a no-op. */
  refresh(): Promise<void>;
  openObservations(): TerminalObservation[];
  observation(terminalId: string): TerminalObservation;
  resumeDisposition(terminalId: string, fromSequence: number): TerminalResumeDisposition;
  awaitSnapshotProjection(
    terminalId: string,
    minBoundary: number,
    signal: AbortSignal,
  ): Promise<
    | { status: "projected"; projection: TerminalSnapshotProjection }
    | { status: "unavailable" }
    | { status: "aborted" }
  >;
  observe(terminalId: string, fromSequence?: number, signal?: AbortSignal): AsyncIterable<TerminalFrame>;
  capabilities(terminalId: string): TerminalCapabilities;
  capabilitiesRevision(terminalId: string): number;
}

/** Compose independent terminal sources without exposing their private identities or transports. */
export class CompositeTerminalSourceProvider implements TerminalSourceProvider {
  private readonly providers: readonly TerminalSourceProvider[];

  public constructor(providers: readonly TerminalSourceProvider[]) {
    if (providers.length === 0) throw new Error("at least one terminal source provider is required");
    this.providers = providers;
  }

  public async refresh(): Promise<void> {
    await Promise.all(this.providers.map((provider) => provider.refresh()));
    const owners = new Map<string, TerminalSourceProvider>();
    for (const provider of this.providers) {
      for (const observation of provider.openObservations()) {
        if (owners.has(observation.terminalId)) {
          throw new Error(`duplicate terminal source identity ${observation.terminalId}`);
        }
        owners.set(observation.terminalId, provider);
      }
    }
  }

  public openObservations(): TerminalObservation[] {
    return this.providers.flatMap((provider) => provider.openObservations());
  }

  public observation(terminalId: string): TerminalObservation {
    return this.owner(terminalId).observation(terminalId);
  }

  public resumeDisposition(terminalId: string, fromSequence: number): TerminalResumeDisposition {
    return this.owner(terminalId).resumeDisposition(terminalId, fromSequence);
  }

  public awaitSnapshotProjection(
    terminalId: string,
    minBoundary: number,
    signal: AbortSignal,
  ): Promise<
    | { status: "projected"; projection: TerminalSnapshotProjection }
    | { status: "unavailable" }
    | { status: "aborted" }
  > {
    return this.owner(terminalId).awaitSnapshotProjection(terminalId, minBoundary, signal);
  }

  public observe(
    terminalId: string,
    fromSequence?: number,
    signal?: AbortSignal,
  ): AsyncIterable<TerminalFrame> {
    return this.owner(terminalId).observe(terminalId, fromSequence, signal);
  }

  public capabilities(terminalId: string): TerminalCapabilities {
    return this.owner(terminalId).capabilities(terminalId);
  }

  public capabilitiesRevision(terminalId: string): number {
    return this.owner(terminalId).capabilitiesRevision(terminalId);
  }

  private owner(terminalId: string): TerminalSourceProvider {
    const matches = this.providers.filter((provider) => {
      try {
        provider.observation(terminalId);
        return true;
      } catch {
        return false;
      }
    });
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0 ? `Unknown terminal ${terminalId}` : `Ambiguous terminal ${terminalId}`,
      );
    }
    return matches[0]!;
  }
}
