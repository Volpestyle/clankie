import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { createApnsSender, type ApnsSender } from "./apns.ts";
import { PushRegistrations } from "./push-registrations.ts";

/**
 * Operator configuration for push delivery (ADR 0159).
 *
 * One optional file switches it on. Absent, the gateway boots exactly as it
 * always has and hosts that ask for a wake are told delivery is unavailable.
 * Present and wrong, the process refuses to start rather than run a doorway
 * that silently drops notifications.
 *
 * The file names paths, never secrets: the signing key is read from
 * `privateKeyFile`, and nothing here holds a device token, a delivery key, or a
 * grant — those live with the host and in the registration database.
 */

export const GATEWAY_PUSH_CONFIG_FILE_ENV = "CLANKIE_GATEWAY_PUSH_CONFIG_FILE";

const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => isAbsolute(value), { error: "must be an absolute path" });

const GatewayPushConfigSchema = z
  .object({
    /** 10-character Apple Team ID. */
    teamId: z.string().regex(/^[A-Z0-9]{10}$/u),
    /** 10-character key id of the `.p8`. */
    keyId: z.string().regex(/^[A-Z0-9]{10}$/u),
    /** The app's bundle id. One gateway serves one topic; a host cannot choose. */
    topic: z.string().regex(/^[A-Za-z0-9.-]{1,155}$/u),
    /** Read-only mount of the `.p8`. Its contents never appear in a log or an error. */
    privateKeyFile: AbsolutePathSchema,
    /**
     * Delivery registrations. Persistent by requirement: losing this file
     * revokes every phone's authorization until each app re-registers.
     */
    databasePath: AbsolutePathSchema.refine((value) => value !== ":memory:", {
      error: "must be a persistent file, not :memory:",
    }),
  })
  .strict();

export type GatewayPushConfig = z.infer<typeof GatewayPushConfigSchema>;

export interface GatewayPush {
  readonly registrations: PushRegistrations;
  readonly sender: ApnsSender;
  /** The creator closes what it opened; the process signal handler calls this. */
  close(): Promise<void>;
}

/**
 * Read the configuration named by {@link GATEWAY_PUSH_CONFIG_FILE_ENV}.
 * Returns undefined when unset — the ordinary no-push deployment.
 */
export function loadGatewayPushConfig(env: NodeJS.ProcessEnv = process.env): GatewayPushConfig | undefined {
  const file = env[GATEWAY_PUSH_CONFIG_FILE_ENV]?.trim();
  if (file === undefined || file.length === 0) return undefined;

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(`Gateway push configuration at ${file} could not be read`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Deliberately without the body: a malformed file may still hold something
    // an operator pasted by mistake.
    throw new Error(`Gateway push configuration at ${file} is not valid JSON`);
  }
  const result = GatewayPushConfigSchema.safeParse(parsed);
  if (!result.success) {
    // Field names and reasons only — never the values that failed.
    const problems = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Gateway push configuration at ${file} is invalid — ${problems}`);
  }
  return result.data;
}

/**
 * Build the delivery dependencies, or nothing when push is unconfigured. The
 * signing key is validated here by the sender's own constructor, so a wrong
 * algorithm fails at boot instead of on the first sleeping phone.
 */
export function createGatewayPush(config: GatewayPushConfig | undefined): GatewayPush | undefined {
  if (config === undefined) return undefined;

  let privateKeyPem: string;
  try {
    privateKeyPem = readFileSync(config.privateKeyFile, "utf8");
  } catch {
    throw new Error(`Gateway push signing key at ${config.privateKeyFile} could not be read`);
  }

  const sender = createApnsSender({
    teamId: config.teamId,
    keyId: config.keyId,
    topic: config.topic,
    privateKeyPem,
  });
  let registrations: PushRegistrations;
  try {
    registrations = new PushRegistrations(config.databasePath);
  } catch (error) {
    void sender.close();
    throw new Error(
      `Gateway push registrations at ${config.databasePath} could not be opened: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }

  return {
    registrations,
    sender,
    async close() {
      await sender.close();
      registrations.close();
    },
  };
}
