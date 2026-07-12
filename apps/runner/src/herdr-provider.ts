import type {
  ControlLease,
  TerminalFrame,
  TerminalProvider,
  TerminalSession,
} from "@clankie/terminal-protocol";

/**
 * Boundary for an optional Herdr integration.
 *
 * Keep this adapter outside the core runtime because Herdr has its own licensing
 * and release cadence. The implementation should speak Herdr's documented local
 * socket/session API; it must not scrape rendered terminal pixels.
 */
export class HerdrTerminalProvider implements TerminalProvider {
  private readonly socketPath: string;

  public constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  public async listSessions(): Promise<TerminalSession[]> {
    throw new Error(`Herdr adapter not connected: ${this.socketPath}`);
  }

  public observe(_terminalId: string, _fromSequence?: number): AsyncIterable<TerminalFrame> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw new Error(`Herdr adapter not connected: ${this.socketPath}`);
        },
      }),
    };
  }

  public async acquireControl(_terminalId: string, _principalId: string): Promise<ControlLease> {
    throw new Error(`Herdr adapter not connected: ${this.socketPath}`);
  }

  public async sendInput(_terminalId: string, _leaseId: string, _bytes: Uint8Array): Promise<void> {
    throw new Error(`Herdr adapter not connected: ${this.socketPath}`);
  }

  public async resize(_terminalId: string, _leaseId: string, _columns: number, _rows: number): Promise<void> {
    throw new Error(`Herdr adapter not connected: ${this.socketPath}`);
  }

  public async releaseControl(_terminalId: string, _leaseId: string): Promise<void> {
    throw new Error(`Herdr adapter not connected: ${this.socketPath}`);
  }
}
