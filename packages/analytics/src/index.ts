export const ProductEventNames = [
  "workspace_created",
  "runner_paired",
  "mission_created",
  "mission_started",
  "mission_completed",
  "mission_failed",
  "plan_approved",
  "worker_started",
  "worker_replaced",
  "human_takeover_started",
  "human_takeover_completed",
  "approval_requested",
  "approval_decided",
  "terminal_opened",
  "garden_command_issued",
  "garden_command_completed",
  "doctrine_changed",
  "eval_completed",
] as const;

export type ProductEventName = (typeof ProductEventNames)[number];

export interface ProductEvent {
  name: ProductEventName;
  distinctId: string;
  occurredAt: string;
  properties: Record<string, string | number | boolean | null>;
}

export interface AnalyticsSink {
  capture(event: ProductEvent): Promise<void>;
  flush?(): Promise<void>;
}

export class NoopAnalyticsSink implements AnalyticsSink {
  public async capture(): Promise<void> {}
}

export class ConsentGatedAnalytics implements AnalyticsSink {
  private readonly enabled: () => boolean;
  private readonly delegate: AnalyticsSink;

  public constructor(enabled: () => boolean, delegate: AnalyticsSink) {
    this.enabled = enabled;
    this.delegate = delegate;
  }

  public async capture(event: ProductEvent): Promise<void> {
    if (!this.enabled()) return;
    await this.delegate.capture({ ...event, properties: minimizeProperties(event.properties) });
  }

  public async flush(): Promise<void> {
    if (!this.enabled()) return;
    await this.delegate.flush?.();
  }
}

const forbiddenProperty = /prompt|transcript|terminal|source|diff|token|secret|email|name|message/i;

export function minimizeProperties(properties: ProductEvent["properties"]): ProductEvent["properties"] {
  return Object.fromEntries(Object.entries(properties).filter(([key]) => !forbiddenProperty.test(key)));
}
