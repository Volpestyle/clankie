import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { SwarmConnectionSchema, type SettingsStore, type SwarmConnection } from "@clankie/settings";
import type { CredentialStore } from "@clankie/credential-broker";
import { CoordinationClient } from "swarm-mcp/runtime";

export const SwarmConnectSchema = SwarmConnectionSchema.pick({
  id: true,
  conversationId: true,
  endpoint: true,
})
  .extend({
    capability: z.string().min(32).max(512),
  })
  .strict();
export type ConnectionStores = { settings: SettingsStore; credentials: CredentialStore };

export const connectionTarget = (connection: SwarmConnection) => ({
  endpoint: connection.endpoint,
  scope: connection.scope,
  actor: connection.actor,
});

export async function inspectConnection(endpoint: string, capability: string) {
  const client = await CoordinationClient.connect(endpoint, capability);
  try {
    return z
      .object({ actor: z.string().min(1), scope: z.string().min(1) })
      .parse(await client.request({ op: "bootstrap" }));
  } finally {
    client.close();
  }
}

/** Reconnect only the same identity. An ID cannot redirect outstanding work. */
export async function connectExternal(stores: ConnectionStores, raw: unknown) {
  const input = SwarmConnectSchema.parse(raw);
  const identity = await inspectConnection(input.endpoint, input.capability);
  const credential = `swarm:${randomUUID()}`;
  const connection = SwarmConnectionSchema.parse({
    ...identity,
    id: input.id,
    conversationId: input.conversationId,
    endpoint: input.endpoint,
    credential,
    enabled: true,
  });
  await stores.credentials.set(credential, { type: "api", key: input.capability });
  let previous: string | undefined;
  try {
    await stores.settings.update((current) => {
      const existing = current.swarm.connections.find((entry) => entry.id === input.id);
      if (
        existing &&
        (!isDeepStrictEqual(connectionTarget(existing), connectionTarget(connection)) ||
          existing.conversationId !== connection.conversationId)
      )
        throw new Error(
          "Connection ID is pinned to another coordinator identity or conversation; use a new ID",
        );
      if (
        current.swarm.connections.some(
          (entry) =>
            entry.id !== input.id &&
            entry.endpoint === input.endpoint &&
            entry.actor === identity.actor &&
            entry.scope === identity.scope,
        )
      )
        throw new Error("This Swarm actor already has a connection; enroll a dedicated Clankie session");
      previous = existing?.credential;
      return {
        ...current,
        swarm: {
          connections: [...current.swarm.connections.filter((entry) => entry.id !== input.id), connection],
        },
      };
    });
  } catch (error) {
    await stores.credentials.delete(credential);
    throw error;
  }
  if (previous) await stores.credentials.delete(previous);
  return connection;
}
