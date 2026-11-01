/**
 * One verified activity from a connected tracker, already shaped by that
 * tracker's adapter (ADR 0328). The core appends it to the chosen chat and may
 * wake him; it never reads the tracker's own payload.
 */
export interface TrackerActivity {
  /** Stable identity for replay protection: 64 lowercase hex characters. */
  readonly eventId: string;
  /** Compact, quoted context for the conversation journal and the coalesced wake. */
  readonly prompt: string;
  readonly project?: { readonly id: string; readonly name?: string };
  /** Why the host chose this chat. */
  readonly route?: "project_lead" | "project_fallback" | "default";
  readonly receiver?: { readonly userId: string; readonly workspaceId: string };
  readonly notificationTypes?: readonly string[];
}

/** A woken activity's notification, which the tracker may mark read once the chat confirms it. */
export interface TrackerWakeReference {
  readonly eventId: string;
  readonly receiver: { readonly userId: string; readonly workspaceId: string };
  readonly notificationTypes: readonly string[];
}
