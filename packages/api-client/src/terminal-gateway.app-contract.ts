/**
 * Compile-only structural contract for VUH-870.
 *
 * This fixture imports every public terminal-gateway name and proves the client
 * is structurally usable as the app's frozen `TerminalHostAdapter` (clankie-app
 * `5472681`) without importing clankie-app. The app-side shapes below are a
 * local mirror of that frozen seam; the assertions fail the package typecheck if
 * the exported surface ever drifts from it. It emits no runtime code.
 */

import type {
  TerminalGatewayCapabilities,
  TerminalGatewayClient,
  TerminalGatewayClientError,
  TerminalGatewayClientErrorCode,
  TerminalGatewayClientOptions,
  TerminalGatewayObserveRequest,
  TerminalGatewaySession,
  TerminalGatewayStreamEvent,
  TerminalJsonConnector,
  TerminalJsonDuplex,
} from "./terminal-gateway.ts";

// --- Local mirror of the frozen app `TerminalHostAdapter` seam ---

interface AppCapabilities {
  observe: true;
  control: boolean;
  input: boolean;
  resize: boolean;
}

interface AppSession {
  terminalId: string;
  label: string;
  source: "runner" | "herdr" | "mock";
  capabilities: AppCapabilities;
  controlOwner?: unknown;
}

interface AppObserveRequest {
  terminalId: string;
  afterSequence?: number;
  signal: AbortSignal;
}

type AppStreamEvent =
  | {
      type: "snapshot";
      snapshot: {
        terminalId: string;
        geometry: { columns: number; rows: number };
        boundary: { afterSequence: number; nextSequence: number };
        restoreBase64: string;
      };
    }
  | { type: "output"; frame: { terminalId: string; sequence: number; dataBase64: string } }
  | { type: "capabilities"; capabilities: AppCapabilities; controlOwner?: unknown }
  | { type: "closed"; reason: string };

interface AppTerminalHostAdapter {
  listSessions(signal?: AbortSignal): Promise<AppSession[]>;
  observe(request: AppObserveRequest): AsyncIterable<AppStreamEvent>;
}

// --- Assignability assertions (non-distributive) ---

type Assert<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;

export type _CapabilitiesToApp = Assert<Extends<TerminalGatewayCapabilities, AppCapabilities>>;
export type _SessionToApp = Assert<Extends<TerminalGatewaySession, AppSession>>;
export type _EventToApp = Assert<Extends<TerminalGatewayStreamEvent, AppStreamEvent>>;
export type _AppRequestToClient = Assert<Extends<AppObserveRequest, TerminalGatewayObserveRequest>>;
export type _ClientRequestToApp = Assert<Extends<TerminalGatewayObserveRequest, AppObserveRequest>>;
export type _ClientIsAdapter = Assert<Extends<TerminalGatewayClient, AppTerminalHostAdapter>>;

// Reference the remaining public transport/error surface so the full inventory is proven.
export type _ConnectorShape = Assert<Extends<TerminalGatewayClientOptions["connect"], TerminalJsonConnector>>;
export type _DuplexShape = Assert<Extends<Awaited<ReturnType<TerminalJsonConnector>>, TerminalJsonDuplex>>;
export type _ErrorCode = Assert<Extends<TerminalGatewayClientError["code"], TerminalGatewayClientErrorCode>>;
