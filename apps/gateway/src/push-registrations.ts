import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  DevicePushBinding,
  PublicGatewayPushClearRequest,
  PublicGatewayPushRegistrationRequest,
} from "@clankie/protocol";

interface RegistrationRow {
  registration_id: string;
  owner_id: string;
  key_hash: string;
  sequence: number;
  token: string | null;
  token_hash: string | null;
  environment: "sandbox" | "production" | null;
  host_id: string | null;
  device_id: string | null;
  registered_at_ms: number | null;
}

export interface PushDelivery extends DevicePushBinding {
  readonly deviceToken: string;
  readonly environment: "sandbox" | "production";
  readonly hostId: string;
  readonly deviceId: string;
  readonly registeredAtMs: number;
}

export class PushRegistrationError extends Error {
  public readonly reason:
    | "mismatched_delivery_key"
    | "stale_registration"
    | "token_already_registered"
    | "registration_limit"
    | "not_registered";
  constructor(
    reason:
      | "mismatched_delivery_key"
      | "stale_registration"
      | "token_already_registered"
      | "not_registered"
      | "registration_limit",
  ) {
    super(reason);
    this.reason = reason;
  }
}

/** Delivery authorization only. No device sessions, grants, messages or signing keys. */
export class PushRegistrations {
  private readonly database: DatabaseSync;
  private readonly clock: () => number;

  constructor(path: string, clock: () => number = Date.now) {
    this.clock = clock;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.database.exec(`
      PRAGMA busy_timeout = 2000;
      CREATE TABLE IF NOT EXISTS push_registrations (
        registration_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK(sequence > 0),
        token TEXT,
        token_hash TEXT,
        environment TEXT CHECK(environment IN ('sandbox', 'production')),
        host_id TEXT,
        device_id TEXT,
        registered_at_ms INTEGER,
        UNIQUE(token_hash, environment)
      );
      CREATE INDEX IF NOT EXISTS push_registration_owner ON push_registrations(owner_id);
    `);
  }

  register(
    request: PublicGatewayPushRegistrationRequest,
    verifiedDeviceId: string,
    ownerId: string,
  ): DevicePushBinding {
    return this.transaction(() => {
      const previous = this.row(request.registrationId);
      this.authorize(previous, request.deliveryKey);
      if (previous?.owner_id !== ownerId) this.checkCapacity(ownerId);
      const token = request.deviceToken.toLowerCase();
      const tokenHash = hash(token);
      if (previous !== undefined && request.sequence <= previous.sequence) {
        if (
          request.sequence === previous.sequence &&
          previous.token_hash === tokenHash &&
          previous.environment === request.environment &&
          previous.host_id === request.hostId &&
          previous.device_id === verifiedDeviceId
        )
          return this.binding(previous);
        throw new PushRegistrationError("stale_registration");
      }
      const conflict = this.database
        .prepare(
          "SELECT registration_id FROM push_registrations WHERE token_hash = ? AND environment = ? AND registration_id != ?",
        )
        .get(tokenHash, request.environment, request.registrationId);
      if (conflict !== undefined) throw new PushRegistrationError("token_already_registered");
      this.database
        .prepare(`
        INSERT INTO push_registrations (registration_id, owner_id, key_hash, sequence, token, token_hash, environment, host_id, device_id, registered_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(registration_id) DO UPDATE SET owner_id=excluded.owner_id, sequence=excluded.sequence, token=excluded.token,
          token_hash=excluded.token_hash, environment=excluded.environment, host_id=excluded.host_id,
          device_id=excluded.device_id, registered_at_ms=excluded.registered_at_ms
      `)
        .run(
          request.registrationId,
          ownerId,
          hash(request.deliveryKey),
          request.sequence,
          token,
          tokenHash,
          request.environment,
          request.hostId,
          verifiedDeviceId,
          this.clock(),
        );
      return { registrationId: request.registrationId, sequence: request.sequence };
    });
  }

  clear(request: PublicGatewayPushClearRequest, verifiedOwnerId?: string): DevicePushBinding {
    return this.transaction(() => {
      const previous = this.row(request.registrationId);
      if (previous === undefined) {
        if (verifiedOwnerId === undefined) throw new PushRegistrationError("not_registered");
        this.checkCapacity(verifiedOwnerId);
        // A clear may beat the first registration over the network. Keep its
        // version so that delayed registration cannot restore delivery.
        this.database
          .prepare(
            "INSERT INTO push_registrations (registration_id, owner_id, key_hash, sequence) VALUES (?, ?, ?, ?)",
          )
          .run(request.registrationId, verifiedOwnerId, hash(request.deliveryKey), request.sequence);
        return { registrationId: request.registrationId, sequence: request.sequence };
      }
      this.authorize(previous, request.deliveryKey);
      if (
        request.sequence < previous.sequence ||
        (request.sequence === previous.sequence && previous.token !== null)
      ) {
        throw new PushRegistrationError("stale_registration");
      }
      this.database
        .prepare(`UPDATE push_registrations SET sequence=?, token=NULL,
        host_id=NULL, device_id=NULL, registered_at_ms=NULL WHERE registration_id=?`)
        .run(request.sequence, request.registrationId);
      return { registrationId: request.registrationId, sequence: request.sequence };
    });
  }

  /** The authenticated socket and the host's device reference must name this exact version. */
  delivery(
    hostId: string,
    deviceId: string,
    binding: DevicePushBinding,
  ): PushDelivery | "not_registered" | "superseded" {
    const row = this.row(binding.registrationId);
    if (row === undefined || row.token === null) return "not_registered";
    if (row.host_id !== hostId || row.device_id !== deviceId || row.sequence !== binding.sequence)
      return "superseded";
    if (row.environment === null || row.registered_at_ms === null)
      throw new Error("Invalid persisted push registration");
    return {
      ...this.binding(row),
      deviceToken: row.token,
      environment: row.environment,
      hostId,
      deviceId,
      registeredAtMs: row.registered_at_ms,
    };
  }

  /** A late APNs response cannot clear a registration or token that has changed since send. */
  invalidate(delivery: PushDelivery, timestampMs: number | undefined): boolean {
    if (timestampMs === undefined || timestampMs < delivery.registeredAtMs) return false;
    const result = this.database
      .prepare(`UPDATE push_registrations SET token=NULL,
      host_id=NULL, device_id=NULL, registered_at_ms=NULL
      WHERE registration_id=? AND sequence=? AND token_hash=? AND registered_at_ms=?`)
      .run(delivery.registrationId, delivery.sequence, hash(delivery.deviceToken), delivery.registeredAtMs);
    return result.changes > 0;
  }

  close(): void {
    this.database.close();
  }

  private row(id: string): RegistrationRow | undefined {
    return this.database
      .prepare("SELECT * FROM push_registrations WHERE registration_id=?")
      .get(id) as unknown as RegistrationRow | undefined;
  }

  private checkCapacity(ownerId: string): void {
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM push_registrations WHERE owner_id=?")
      .get(ownerId);
    // Tombstones retain ordering. Bound installations per authenticated account,
    // not host id: one account may create many host installations.
    if (Number(row?.count) >= 1024) throw new PushRegistrationError("registration_limit");
  }

  private binding(row: RegistrationRow): DevicePushBinding {
    return { registrationId: row.registration_id, sequence: row.sequence };
  }

  private authorize(row: RegistrationRow | undefined, key: string): void {
    if (
      row !== undefined &&
      !timingSafeEqual(Buffer.from(row.key_hash, "hex"), Buffer.from(hash(key), "hex"))
    ) {
      throw new PushRegistrationError("mismatched_delivery_key");
    }
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
