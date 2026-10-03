/** Product policy for Clankie's own inference, never the native harness login. */
export const CLAUDE_SUBSCRIPTION_REMOVED =
  "Clankie no longer supports Claude subscription login. Use /auth anthropic with an Anthropic API key. Native Claude Code keeps its own login.";
export const HOSTED_CHATGPT_APPROVAL_REQUIRED =
  "ChatGPT subscription login for hosted Clankie/Pi is unavailable pending OpenAI approval. Use your own provider API key or included model usage. Local/self-hosted Clankie and native Codex login are unchanged.";

export class ModelSubscriptionPolicyError extends Error {
  public readonly code: "claude_subscription_removed" | "hosted_chatgpt_approval_required";
  public constructor(code: "claude_subscription_removed" | "hosted_chatgpt_approval_required") {
    super(
      code === "claude_subscription_removed" ? CLAUDE_SUBSCRIPTION_REMOVED : HOSTED_CHATGPT_APPROVAL_REQUIRED,
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
