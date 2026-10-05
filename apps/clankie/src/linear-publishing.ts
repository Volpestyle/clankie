import { z } from "zod";
import type { ProviderCredential } from "@clankie/credential-broker";
import type { OperatorAgentPersona } from "@clankie/protocol";

const personaId = z
  .string()
  .min(1)
  .max(256)
  .describe("Existing worker persona ID from the fleet roster. Never an email alias.");
const Comment = z
  .object({
    personaId,
    issueId: z.string().min(1).max(256),
    parentId: z.string().uuid().optional(),
    body: z.string().min(1).max(50_000),
  })
  .strict();
const Issue = z
  .object({
    personaId,
    teamId: z.string().uuid(),
    title: z.string().min(1).max(255),
    description: z.string().max(50_000).optional(),
    projectId: z.string().min(1).max(256).optional(),
    parentId: z.string().min(1).max(256).optional(),
    priority: z.number().int().min(0).max(4).optional(),
    labelIds: z.array(z.string().uuid()).max(100).optional(),
  })
  .strict();

export const LINEAR_WORKER_TOOLS = [
  {
    name: "create_worker_comment",
    description:
      "Publish a worker’s durable result or reply on a Linear issue using its existing name and colored Clankie avatar. Requires the connected Linear app. Use personaId from the fleet roster; keep transcripts in the worker thread and link evidence.",
    inputSchema: z.toJSONSchema(Comment),
  },
  {
    name: "create_worker_issue",
    description:
      "Create a Linear issue attributed to an existing worker persona, with its name and colored Clankie avatar through the connected Clankie app. Discover team UUID and personaId first. Ordinary issue edits use Linear’s existing tools.",
    inputSchema: z.toJSONSchema(Issue),
  },
] as const;

export function isLinearWorkerTool(name: string): boolean {
  return LINEAR_WORKER_TOOLS.some((tool) => tool.name === name);
}

/** The app owns this art. The public copies are the unchanged, exported PNGs. */
export function linearWorkerAuthor(persona: OperatorAgentPersona) {
  return {
    name: persona.name,
    avatarUrl: `https://docs.clankie.bot/agents/clankie-${persona.appearance.variant}-v1.png`,
  };
}

export async function publishLinearWorker(input: {
  tool: string;
  args: Record<string, unknown>;
  credential: ProviderCredential | undefined;
  author: (personaId: string) => Promise<{ name: string; avatarUrl: string } | undefined>;
  beforeWrite: () => Promise<void>;
  /** The host's total caller deadline; it must fence setup and the actual write. */
  signal?: AbortSignal;
  beforeDispatch?: () => void;
  fetch?: typeof fetch;
}): Promise<{ content: string; isError: boolean }> {
  const signal = input.signal ?? AbortSignal.timeout(30_000);
  const credential = input.credential;
  if (
    credential?.type !== "oauth" ||
    (credential.linearAuth !== "app" && credential.linearAuth !== "api") ||
    credential.account?.actor !== "app"
  )
    throw new Error("Worker attribution requires a verified Linear app connection");
  const kind =
    input.tool === "create_worker_comment"
      ? "comment"
      : input.tool === "create_worker_issue"
        ? "issue"
        : undefined;
  if (!kind) throw new Error("Unknown worker publishing tool");
  const parsed = (kind === "comment" ? Comment : Issue).safeParse(input.args);
  if (!parsed.success) throw new Error("Invalid worker publishing arguments");
  const { personaId, ...fields } = parsed.data;
  signal.throwIfAborted();
  const author = await beforeDeadline(input.author(personaId), signal);
  if (!author || !author.name.trim()) throw new Error("Unknown worker persona");
  const avatar = new URL(author.avatarUrl);
  if (avatar.protocol !== "https:" || avatar.username || avatar.password)
    throw new Error("Worker avatar must be a public HTTPS URL");
  const variableType = kind === "comment" ? "CommentCreateInput" : "IssueCreateInput";
  const selection =
    kind === "comment" ? "id body updatedAt url" : "id identifier title description updatedAt url";
  // Resolve the author first, then recheck the exact account binding at the wire boundary.
  await beforeDeadline(input.beforeWrite(), signal);
  signal.throwIfAborted();
  input.beforeDispatch?.();
  signal.throwIfAborted();
  // The caller can return earlier while this original write is observed for a
  // receipt. Keep its existing network cap, including response-body consumption.
  const completion = AbortSignal.timeout(30_000);
  let response: Response;
  try {
    response = await beforeDeadline(
      (input.fetch ?? fetch)("https://api.linear.app/graphql", {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${credential.access}`, "content-type": "application/json" },
        body: JSON.stringify({
          query: `mutation WorkerPost($input: ${variableType}!) { ${kind}Create(input: $input) { success ${kind} { ${selection} } } }`,
          variables: { input: { ...fields, createAsUser: author.name, displayIconUrl: author.avatarUrl } },
        }),
        signal: completion,
      }),
      completion,
    );
  } catch {
    throw new Error("Linear worker post unavailable; inspect the issue before retrying");
  }
  if (!response.ok)
    throw new Error(`Linear worker post failed: HTTP ${response.status}; inspect the issue before retrying`);
  const result = z
    .object({ data: z.record(z.string(), z.unknown()).nullish(), errors: z.array(z.unknown()).optional() })
    .safeParse(
      await beforeDeadline(
        response.json().catch(() => undefined),
        completion,
      ),
    );
  if (!result.success || result.data.errors?.length)
    throw new Error("Linear worker post was not confirmed; inspect the issue before retrying");
  const payload = z
    .object({ success: z.literal(true), comment: z.unknown().optional(), issue: z.unknown().optional() })
    .safeParse(result.data.data?.[`${kind}Create`]);
  if (!payload.success)
    throw new Error("Linear worker post returned no receipt; inspect the issue before retrying");
  const receipt = z
    .looseObject({ id: z.string().uuid(), updatedAt: z.string().datetime({ offset: true }), url: z.string() })
    .safeParse(payload.data[kind]);
  if (!receipt.success)
    throw new Error("Linear worker post returned no receipt; inspect the issue before retrying");
  const content = [credential.access, credential.refresh]
    .filter(Boolean)
    .reduce(
      (text, secret) => text.replaceAll(secret, "[redacted]"),
      JSON.stringify({ ...receipt.data, personaId }),
    );
  return { content, isError: false };
}

function beforeDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    if (signal.aborted) {
      // The passed operation may already be running; observe its rejection too.
      void operation.catch(() => undefined);
      aborted();
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    void operation.then(
      (result) => {
        signal.removeEventListener("abort", aborted);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      },
    );
  });
}
