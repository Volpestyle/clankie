/** Credential policy for Clankie's own inference. */
export const MANAGED_CREDITS_ONLY =
  "Managed Clankie uses AI credits only. Subscription sign-in and customer model keys are available on self-hosted bodies.";
export const CLAUDE_SUBSCRIPTION_REMOVED =
  "Clankie no longer supports Claude subscription login. Use /auth anthropic with an Anthropic API key. Native Claude Code keeps its own login.";
/** Legacy exported name retained for installed provider compatibility. */
export const HOSTED_CHATGPT_APPROVAL_REQUIRED = MANAGED_CREDITS_ONLY;

export class ModelSubscriptionPolicyError extends Error {
  public readonly code:
    | "claude_subscription_removed"
    | "hosted_chatgpt_approval_required"
    | "managed_credits_only";
  public constructor(
    code: "claude_subscription_removed" | "hosted_chatgpt_approval_required" | "managed_credits_only",
  ) {
    super(
      code === "managed_credits_only"
        ? MANAGED_CREDITS_ONLY
        : code === "claude_subscription_removed"
          ? CLAUDE_SUBSCRIPTION_REMOVED
          : HOSTED_CHATGPT_APPROVAL_REQUIRED,
    );
    this.code = code;
  }
}

export function isHostedModelEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.CLANKIE_HOSTED_BOOTSTRAP_FILE?.trim());
}

export function assertChatgptLoginAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (isHostedModelEnvironment(env))
    throw new ModelSubscriptionPolicyError("hosted_chatgpt_approval_required");
}

/** Refuse old stored tokens as well as new token-shaped API-key entries. */
export function assertModelCredentialAllowed(
  providerId: string,
  credential: { readonly type: string; readonly key?: string; readonly token?: string } | undefined,
  options: { readonly env?: NodeJS.ProcessEnv; readonly hosted?: boolean } = {},
): void {
  if (
    providerId === "anthropic" &&
    (credential?.type === "oauth" ||
      credential?.key?.startsWith("sk-ant-oat") ||
      credential?.token?.startsWith("sk-ant-oat") ||
      (credential === undefined && (options.env ?? process.env).ANTHROPIC_API_KEY?.startsWith("sk-ant-oat")))
  )
    throw new ModelSubscriptionPolicyError("claude_subscription_removed");
  if (providerId === "openai-codex" && (options.hosted ?? isHostedModelEnvironment(options.env)))
    throw new ModelSubscriptionPolicyError("hosted_chatgpt_approval_required");
  if (providerId !== "clankie" && (options.hosted ?? isHostedModelEnvironment(options.env)))
    throw new ModelSubscriptionPolicyError("managed_credits_only");
}

/** Shared by setup, doctor and Pi listing so stale entries are never shown as usable auth. */
export function modelCredentialAllowed(
  providerId: string,
  credential: { readonly type: string; readonly key?: string; readonly token?: string } | undefined,
  options: { readonly env?: NodeJS.ProcessEnv; readonly hosted?: boolean } = {},
): boolean {
  try {
    assertModelCredentialAllowed(providerId, credential, options);
    return true;
  } catch {
    return false;
  }
}
