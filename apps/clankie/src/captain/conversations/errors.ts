export class ConversationResetError extends Error {}
/** A request the conversation understood and declines; its message is the answer. */
export class ConversationRefusedError extends Error {}

export class QuestionCommitError extends Error {
  readonly committed: boolean;
  constructor(committed: boolean, cause: unknown) {
    super("Question persistence unavailable; read its receipt before any further action", { cause });
    this.committed = committed;
  }
}

/** A renamed conversation manifest is consumed even if the directory sync failed. */
export class ConversationCommitError extends Error {
  readonly committed: boolean;
  constructor(committed: boolean, cause: unknown) {
    super(
      `Conversation persistence unavailable; read its receipt before any further action: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.committed = committed;
  }
}
