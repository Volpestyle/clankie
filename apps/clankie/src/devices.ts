import {
  DeviceEventSchema,
  DeviceRecordSchema,
  type DeviceListItem,
  type DeviceRecord,
  type DomainEvent,
} from "@clankie/protocol";

/** In-memory device projection rebuilt from the `device:${deviceId}` event streams. */
export type DeviceRegistry = Map<string, DeviceRecord>;

/**
 * Apply one device lifecycle event to the projection. The same function runs on
 * live writes and on boot replay, so replay parity holds by construction. It is
 * fail-closed: a `device.*` event that does not parse, or an impossible
 * transition, throws (a corrupt or foreign log must not boot silently), matching
 * the approval-replay invariant. Non-device events are ignored.
 */
export function applyDeviceEvent(devices: DeviceRegistry, event: DomainEvent): void {
  if (!event.type.startsWith("device.")) return;
  const parsed = DeviceEventSchema.parse(event);
  switch (parsed.type) {
    case "device.pairing.redeemed": {
      const { deviceId, offerId, name, platform, offeredGrants, mintedBy, pendingExpiresAt } = parsed.data;
      if (devices.has(deviceId)) throw new Error(`device ${deviceId} already exists on redeemed replay`);
      devices.set(
        deviceId,
        DeviceRecordSchema.parse({
          deviceId,
          name,
          platform,
          status: "pending",
          grants: offeredGrants,
          offerId,
          mintedBy,
          createdAt: event.occurredAt,
          pendingExpiresAt,
        }),
      );
      return;
    }
    case "device.activated": {
      const record = requireDevice(devices, parsed.data.deviceId);
      if (record.status !== "pending") {
        throw new Error(`device ${record.deviceId} activated from ${record.status}`);
      }
      devices.set(
        record.deviceId,
        DeviceRecordSchema.parse({
          ...record,
          status: "active",
          grants: parsed.data.grants,
          activatedAt: event.occurredAt,
        }),
      );
      return;
    }
    case "device.session.refreshed": {
      const record = requireDevice(devices, parsed.data.deviceId);
      if (record.status !== "active") {
        throw new Error(`device ${record.deviceId} refreshed from ${record.status}`);
      }
      devices.set(record.deviceId, DeviceRecordSchema.parse({ ...record, lastRefreshAt: event.occurredAt }));
      return;
    }
    case "device.grant.denied":
      // Audit-only: records a rejected terminalControl request, no projection change.
      return;
    case "device.revoked": {
      const record = requireDevice(devices, parsed.data.deviceId);
      if (record.status === "revoked") throw new Error(`device ${record.deviceId} revoked twice`);
      devices.set(
        record.deviceId,
        DeviceRecordSchema.parse({
          ...record,
          status: "revoked",
          revokedAt: event.occurredAt,
          revokedBy: parsed.data.revokedBy,
        }),
      );
      return;
    }
  }
}

/** A pending device whose completion window has elapsed. Treated as absent by read paths. */
export function isDevicePendingExpired(record: DeviceRecord, now: Date): boolean {
  return record.status === "pending" && Date.parse(record.pendingExpiresAt) <= now.getTime();
}

/** Project a device record onto the secret-free operator list row. */
export function deviceListItem(record: DeviceRecord): DeviceListItem {
  return {
    deviceId: record.deviceId,
    name: record.name,
    platform: record.platform,
    status: record.status,
    grants: record.grants,
    createdAt: record.createdAt,
    ...(record.activatedAt !== undefined ? { activatedAt: record.activatedAt } : {}),
    ...(record.lastRefreshAt !== undefined ? { lastRefreshAt: record.lastRefreshAt } : {}),
    ...(record.revokedAt !== undefined ? { revokedAt: record.revokedAt } : {}),
    ...(record.revokedBy !== undefined ? { revokedBy: record.revokedBy } : {}),
  };
}

function requireDevice(devices: DeviceRegistry, deviceId: string): DeviceRecord {
  const record = devices.get(deviceId);
  if (record === undefined) throw new Error(`device ${deviceId} not found on replay`);
  return record;
}
