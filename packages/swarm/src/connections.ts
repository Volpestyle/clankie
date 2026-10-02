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
  ssh: true,
})
  .extend({
    capability: z.string().min(32).max(512),
  })
  .strict()
  .refine(
    (value) => value.ssh !== undefined || value.endpoint.startsWith("/"),
    "A Windows named pipe requires an SSH fleet",
  );
type ConnectionEndpoint = Pick<SwarmConnection, "id" | "endpoint" | "ssh">;
export type ConnectionStores = {
  settings: SettingsStore;
  credentials: CredentialStore;
  transport?: {
    endpoint(connection: ConnectionEndpoint): Promise<string>;
    close(id?: string): void;
    generation?(id: string): number;
  };
};

export function resolveConnectionEndpoint(stores: ConnectionStores, connection: ConnectionEndpoint) {
  if (!connection.ssh) return Promise.resolve(connection.endpoint);
  if (!stores.transport) throw new Error("SSH Swarm connections unavailable");
  return stores.transport.endpoint({
    id: connection.id,
    endpoint: connection.endpoint,
    ssh: connection.ssh,
  });
}

export const connectionTarget = (connection: SwarmConnection) => ({
  endpoint: connection.endpoint,
  scope: connection.scope,
  actor: connection.actor,
  ...(connection.ssh === undefined ? {} : { ssh: connection.ssh }),
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
  const existing = (await stores.settings.load()).swarm.connections.find((entry) => entry.id === input.id);
  if (
    existing &&
    (existing.endpoint !== input.endpoint ||
      existing.ssh !== input.ssh ||
      existing.conversationId !== input.conversationId)
  )
    throw new Error("Connection ID is pinned to another coordinator endpoint or conversation; use a new ID");
  let identity;
  try {
    identity = await inspectConnection(await resolveConnectionEndpoint(stores, input), input.capability);
  } catch (error) {
    if (!existing?.enabled) stores.transport?.close(input.id);
    throw error;
  }
  const credential = `swarm:${randomUUID()}`;
  const connection = SwarmConnectionSchema.parse({
    ...identity,
    id: input.id,
    conversationId: input.conversationId,
    endpoint: input.endpoint,
    ...(input.ssh === undefined ? {} : { ssh: input.ssh }),
    credential,
    enabled: true,
  });
  let previous: string | undefined;
  try {
    await stores.credentials.set(credential, { type: "api", key: input.capability });
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
            entry.ssh === input.ssh &&
            entry.actor === identity.actor &&
            entry.scope === identity.scope,
        )
      )
        throw new Error("This Swarm actor already has a connection; enroll a dedicated Clankie session");
      previous = existing?.credential;
      return {
        ...current,
        swarm: {
          ...current.swarm,
          connections: [...current.swarm.connections.filter((entry) => entry.id !== input.id), connection],
        },
      };
    });
  } catch (error) {
    await stores.credentials.delete(credential);
    if (!existing?.enabled) stores.transport?.close(input.id);
    throw error;
  }
  if (previous) await stores.credentials.delete(previous);
  return connection;
}
