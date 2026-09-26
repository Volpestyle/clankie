import type { ModelPurpose } from "@clankie/model-provider";
import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai/compat";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { RoutedSelection } from "./model.ts";

/**
 * What moved a routine run onto the escalation model.
 *
 * - `asked`: he called `escalate` — the turn turned out to be real work.
 * - `looping`: the run reached its model-call limit without finishing.
 * - `provider_error`: the routine model failed with an error Pi retries; the
 *   retry runs on the escalation model instead.
 */
export type EscalationTrigger = "asked" | "looping" | "provider_error";

export interface EscalationRecord {
  readonly purpose: ModelPurpose;
  readonly from: string;
  readonly to: string;
  readonly trigger: EscalationTrigger;
}

export const ESCALATE_TOOL_NAME = "escalate";

/**
 * One run's escalation budget. A run escalates at most once, whatever fires
 * first; the next run starts back on the routine model. Pure, so the bounds
 * are testable without a model.
 */
export class RoutineRunBudget {
  private limit: number | undefined;
  private calls = 0;
  private escalated = false;

  /** Starts a run. An undefined limit is a run that may not escalate at all. */
  public start(limit: number | undefined): void {
    this.limit = limit;
    this.calls = 0;
    this.escalated = false;
  }

  public get canEscalate(): boolean {
    return this.limit !== undefined && !this.escalated;
  }

  public get hasEscalated(): boolean {
    return this.escalated;
  }

  /** Counts one finished model call; `looping` once the limit is reached. */
  public modelCallEnded(): EscalationTrigger | undefined {
    this.calls += 1;
    return this.canEscalate && this.calls >= (this.limit ?? Infinity) ? "looping" : undefined;
  }

  /** Only an error Pi will retry escalates: the retry is what runs on the bigger model. */
  public modelCallFailed(retryable: boolean): EscalationTrigger | undefined {
    return this.canEscalate && retryable ? "provider_error" : undefined;
  }

  /** Takes the run's one escalation; false when it is spent or never existed. */
  public claim(): boolean {
    if (!this.canEscalate) return false;
    this.escalated = true;
    return true;
  }
}

/** What he is told when a turn runs on the routine model and may escalate. */
function routineCard(routed: RoutedSelection): string {
  return [
    "## This turn's model",
    `This turn runs on your routine model (\`${routed.selection.ref}\`), which your person picked for everyday conversation.`,
    routed.resolveEscalation === undefined
      ? "It cannot hand off to a bigger model."
      : `If it turns out to be real work — code, a multi-step investigation, leading agents, a hard question — call \`${ESCALATE_TOOL_NAME}\` and the rest of the turn runs on \`${routed.route.escalation?.ref ?? "your work model"}\`. Once per turn; it costs more.`,
  ].join("\n");
}

/**
 * Task-based routing inside a Pi session. The session starts each run on the
 * model its purpose routes to (`syncModel` in captain.ts); this extension is
 * the only thing that ever moves a routine run off it, and only onto the
 * escalation model, once. Pi reads the session model before every model call,
 * so a swap here takes effect on the next call of the same run without
 * replaying the turn, and Pi's own retry of a failed call runs on it too.
 * The swap is recorded in the session file and reported to `onEscalated`.
 */
export function captainRoutingExtension(input: {
  readonly current: () => RoutedSelection | undefined;
  readonly onEscalated: (record: EscalationRecord) => void;
}) {
  return {
    name: "captain-routing",
    hidden: true,
    factory(pi) {
      const budget = new RoutineRunBudget();
      let routed: RoutedSelection | undefined;

      const setToolActive = (active: boolean): void => {
        const tools = pi.getActiveTools().filter((name) => name !== ESCALATE_TOOL_NAME);
        pi.setActiveTools(active ? [...tools, ESCALATE_TOOL_NAME] : tools);
      };

      /** The model the run moved to, or why it did not move. */
      const escalate = async (
        trigger: EscalationTrigger,
      ): Promise<{ readonly to: string } | { readonly refused: string }> => {
        const current = routed;
        if (current?.resolveEscalation === undefined || !budget.claim()) {
          return {
            refused: budget.hasEscalated ? "This turn has already escalated." : "This turn cannot escalate.",
          };
        }
        const target = await current.resolveEscalation();
        if (!(await pi.setModel(target.model))) {
          throw new Error(`Escalation model ${target.ref} has no usable credential`);
        }
        pi.setThinkingLevel(target.thinkingLevel);
        const record: EscalationRecord = {
          purpose: current.route.purpose,
          from: current.selection.ref,
          to: target.ref,
          trigger,
        };
        pi.appendEntry("clankie-escalation", record);
        input.onEscalated(record);
        return { to: target.ref };
      };

      const escalateQuietly = async (trigger: EscalationTrigger): Promise<void> => {
        try {
          await escalate(trigger);
        } catch (error) {
          console.warn(
            `Routine turn could not escalate (${trigger}):`,
            error instanceof Error ? error.message : String(error),
          );
        }
      };

      pi.registerTool(
        defineTool({
          name: ESCALATE_TOOL_NAME,
          label: "Escalate this turn",
          description:
            "Hand the rest of this turn to your bigger model when it turns out to be real work: code, a multi-step " +
            "investigation, leading agents, or a question your routine model cannot answer well. Once per turn.",
          parameters: Type.Object({
            reason: Type.Optional(Type.String({ maxLength: 500 })),
          }),
          execute: async () => {
            let text: string;
            try {
              const outcome = await escalate("asked");
              text = "to" in outcome ? `The rest of this turn runs on ${outcome.to}.` : outcome.refused;
            } catch (error) {
              text = `Could not escalate: ${error instanceof Error ? error.message : String(error)}`;
            }
            return { content: [{ type: "text" as const, text }], details: undefined };
          },
        }),
      );

      pi.on("before_agent_start", async (event) => {
        routed = input.current();
        const escalation = routed?.resolveEscalation === undefined ? undefined : routed.route.escalation;
        budget.start(escalation?.turnLimit);
        setToolActive(escalation !== undefined);
        if (routed === undefined || routed.route.tier !== "routine") return undefined;
        return { systemPrompt: `${event.systemPrompt}\n\n${routineCard(routed)}` };
      });

      pi.on("turn_end", async () => {
        const trigger = budget.modelCallEnded();
        if (trigger !== undefined) await escalateQuietly(trigger);
      });

      pi.on("message_end", async (event) => {
        const message = event.message;
        if (message.role !== "assistant" || message.stopReason !== "error") return;
        const trigger = budget.modelCallFailed(isRetryableAssistantError(message as AssistantMessage));
        if (trigger !== undefined) await escalateQuietly(trigger);
      });
    },
  } satisfies InlineExtension;
}
