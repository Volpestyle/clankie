import {
  writeBodyDiagnosticsConsent,
  BODY_DIAGNOSTICS_CONSENT_MS,
  type BodyTelemetry,
} from "@clankie/observability/body-telemetry";
import type { AccountDiagnosticsDefault } from "@clankie/protocol/account-diagnostics";

/** Hosted service diagnostics follow the fleet account; absent authority never opts in. */
export function createBodyDiagnostics(options: {
  read(): Promise<AccountDiagnosticsDefault>;
  telemetry: BodyTelemetry | undefined;
  spoolDir?: string;
}) {
  let enabled = false,
    generation = 0,
    expiresAt = 0;
  const apply = (value: boolean) => {
    enabled = value;
    expiresAt = Date.now() + BODY_DIAGNOSTICS_CONSENT_MS;
    if (options.spoolDir) {
      try {
        writeBodyDiagnosticsConsent(options.spoolDir, value);
      } catch {
        enabled = false;
      }
    }
  };
  apply(false);
  return {
    async refresh() {
      const request = ++generation;
      try {
        const settings = await options.read();
        if (request === generation) apply(settings.diagnosticsDefault);
      } catch {
        if (request === generation) apply(false);
      }
    },
    emit(event: Parameters<BodyTelemetry["emit"]>[0]) {
      if (enabled && Date.now() < expiresAt) options.telemetry?.emit(event);
    },
  };
}
