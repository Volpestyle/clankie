import {
  isInternalSwarmContact,
  OPERATOR_CONVERSATION_REF_MAX,
  OPERATOR_CONVERSATION_TITLE_MAX,
  OPERATOR_FLEET_TASK_MAX,
  OPERATOR_FLEET_TASK_TEXT_MAX,
  type OperatorAgentPersona,
  type OperatorFleetTask,
  type OperatorFleetTaskAgent,
} from "@clankie/protocol";
import type { SwarmTaskAgent, SwarmTaskView } from "@clankie/swarm";

/** Trim to the wire bound; text that is empty after trimming is absent. */
function clamp(value: string | undefined | null, max: number): string | undefined {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The board's tasks, named as contacts where the host can say which one
 * (ADR 0205). A task names a Swarm actor, and a Swarm actor is a contact
 * only when it is a messageable persona; several conversations can each hold
 * that actor, so the one with a DM wins, then the first listed. Nothing here
 * maps an actor to a seat — no fact says which pane one sits in.
 */
export function fleetTasks(
  views: readonly SwarmTaskView[],
  personas: readonly OperatorAgentPersona[],
): OperatorFleetTask[] {
  const contacts = new Map<string, OperatorAgentPersona>();
  for (const persona of personas) {
    if (persona.swarm === undefined || isInternalSwarmContact(persona)) continue;
    const key = `${persona.swarm.scope}\n${persona.swarm.actor}`;
    const held = contacts.get(key);
    if (held === undefined || (held.conversationId === undefined && persona.conversationId !== undefined))
      contacts.set(key, persona);
  }
  const agent = (scope: string, side: SwarmTaskAgent): OperatorFleetTaskAgent => {
    if (side.clankie) return { name: "Clankie", clankie: true };
    const persona = contacts.get(`${scope}\n${side.actor}`);
    return {
      name: clamp(persona?.name ?? side.name, OPERATOR_CONVERSATION_TITLE_MAX) ?? "Swarm agent",
      ...(persona === undefined ? {} : { personaId: persona.personaId }),
    };
  };
  return views.slice(0, OPERATOR_FLEET_TASK_MAX).map((view) => {
    const objective = clamp(view.objective, OPERATOR_FLEET_TASK_TEXT_MAX);
    const worktree = clamp(view.worktree, OPERATOR_CONVERSATION_REF_MAX);
    const reason = clamp(view.reason, OPERATOR_FLEET_TASK_TEXT_MAX);
    return {
      taskId: view.taskId,
      title:
        clamp(view.title, OPERATOR_CONVERSATION_TITLE_MAX) ??
        clamp(objective?.split("\n")[0], OPERATOR_CONVERSATION_TITLE_MAX) ??
        "Untitled task",
      status: view.status,
      lead: agent(view.scope, view.lead),
      ...(view.owner === undefined ? {} : { owner: agent(view.scope, view.owner) }),
      ...(objective === undefined ? {} : { objective }),
      ...(worktree === undefined ? {} : { worktree }),
      ...(reason === undefined ? {} : { reason }),
      ...(view.stale ? { stale: true as const } : {}),
      updatedAt: view.updatedAt,
    };
  });
}
