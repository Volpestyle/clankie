import { z } from "zod";

export const ACCOUNT_DIAGNOSTICS_PATH = "/v1/devices/self/diagnostics-default";
export const FLEET_BODY_SETTINGS_PATH = "/fleet/v1/body/settings";
/** A read-only projection of the account's default; never account or conversation data. */
export const AccountDiagnosticsDefaultSchema = z.object({ diagnosticsDefault: z.boolean() }).strict();
export type AccountDiagnosticsDefault = z.infer<typeof AccountDiagnosticsDefaultSchema>;
