/**
 * Adapter partition of WORLD_OPERATIONS. Every catalog name is classified
 * body or mind; an unclassified name is in neither list and cannot join
 * pokeagent_world until someone classifies it.
 */
import { WORLD_OPERATIONS, type WorldOperationName } from "@pokeagents/world-protocol";

export const HOSTED_WORLD_OPERATION_CLASS = {
  "world.join": "body",
  "world.leave": "body",
  "play.observe": "body",
  "play.act": "body",
  "play.frame": "body",
  "play.watch": "body",
  "world.session": "mind",
  "world.who": "mind",
  "world.regions": "mind",
  "world.travel": "mind",
  "world.challenge": "mind",
  "world.challenges": "mind",
  "world.answer_challenge": "mind",
} as const satisfies Record<WorldOperationName, "body" | "mind">;

export const HOSTED_WORLD_BODY_OPERATIONS = WORLD_OPERATIONS.map((operation) => operation.name).filter(
  (name) => HOSTED_WORLD_OPERATION_CLASS[name] === "body",
);

export const HOSTED_WORLD_MIND_OPERATIONS = WORLD_OPERATIONS.map((operation) => operation.name).filter(
  (name) => HOSTED_WORLD_OPERATION_CLASS[name] === "mind",
);
