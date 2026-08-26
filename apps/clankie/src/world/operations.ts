/**
 * Adapter partition of WORLD_OPERATIONS. The play loop owns BODY; pokeagent_world
 * owns MIND. Derived from the pinned catalog so a new operation fails closed.
 */
import { WORLD_OPERATIONS, type WorldOperationName } from "@pokeagents/world-protocol";

export const HOSTED_WORLD_BODY_OPERATIONS = [
  "world.join",
  "world.leave",
  "play.observe",
  "play.act",
  "play.frame",
  "play.watch",
] as const satisfies readonly WorldOperationName[];

const BODY = new Set<string>(HOSTED_WORLD_BODY_OPERATIONS);

export const HOSTED_WORLD_MIND_OPERATIONS: readonly WorldOperationName[] = WORLD_OPERATIONS.map(
  (operation) => operation.name,
).filter((name) => !BODY.has(name));

export type HostedWorldMindOperation = (typeof HOSTED_WORLD_MIND_OPERATIONS)[number];
