import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import {
  EVALUATOR_PATH,
  EvaluatorCommandSchema,
  EvaluatorStatusSchema,
  type EvaluatorCommand,
  type EvaluatorStatus,
} from "@clankie/protocol";
import { commandHost } from "./io.ts";

const USAGE = "Usage: clankie evaluator [status|enable [--harness codex|claude]|disable|open|retry ID]";

export function parseEvaluatorArgs(args: readonly string[]): EvaluatorCommand | undefined {
  if (args.length === 0 || (args.length === 1 && args[0] === "status")) return undefined;
  let input: unknown;
  if (args.length === 1 && ["enable", "disable", "open"].includes(args[0]!)) input = { action: args[0] };
  if (args.length === 3 && args[0] === "enable" && args[1] === "--harness")
    input = { action: "enable", harness: args[2] };
  if (args.length === 2 && args[0] === "retry") input = { action: "retry", id: args[1] };
  const parsed = EvaluatorCommandSchema.safeParse(input);
  if (!parsed.success) throw new Error(USAGE);
  return parsed.data;
}

export async function runEvaluatorCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    operatorCredentialStore?: CredentialStore;
  } = {},
): Promise<{ ok: true; evaluator: EvaluatorStatus } | { ok: false; error: string }> {
  const command = parseEvaluatorArgs(args);
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
  });
  if (credential === undefined)
    return { ok: false, error: "Evaluator controls need the local operator credential. Run clankie doctor." };
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${commandHost({ ...options, env })}${EVALUATOR_PATH}`,
      {
        method: command === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
        ...(command === undefined ? {} : { body: JSON.stringify(command) }),
        signal: AbortSignal.timeout(90_000),
      },
    );
    if (!response.ok) throw new Error(`Evaluator: ${response.status} ${await response.text()}`);
    return { ok: true, evaluator: EvaluatorStatusSchema.parse(await response.json()) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function formatEvaluatorStatus(status: EvaluatorStatus): string {
  return [
    `Evaluator: ${status.enabled ? "on" : "off"} · ${status.harness} · ${status.queued} queued`,
    ...(status.paneId === undefined ? [] : [`Pane: ${status.paneId} · /evaluator open`]),
    ...(status.error === undefined ? [] : [`Attention: ${status.error}`]),
    ...status.jobs
      .slice(0, 8)
      .flatMap((job) => [
        `${job.status} · ${job.id} · ${job.report?.summary ?? job.error ?? job.taskId}`,
        ...(job.report?.findings.flatMap((finding) =>
          [finding.issueUrl, finding.mergeRequestUrl].filter((url): url is string => url !== undefined),
        ) ?? []),
      ]),
    `Evidence: ${status.directory}`,
  ].join("\n");
}
