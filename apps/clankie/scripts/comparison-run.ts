/**
 * Drives one captain turn through the operator path and prints what happened.
 *
 * ```
 * pnpm --filter @clankie/clankie comparison-run --base URL --brief FILE [--title T]
 *   [--timeout MS] [--conversation ID --run ID] [--check]
 * ```
 *
 * VUH-1107 compares whole Clankie jobs across models. Every headless `clankie`
 * command reads or writes configuration; none submits a turn, because the
 * operator console is a TTY surface. This is the missing non-interactive
 * entrance to the same route the console uses — `POST /operator/v1/dispatch`
 * with the shared captain bearer — and nothing more. Op shaping, result
 * matching and typing all come from `createOperatorConversationServiceClient`
 * in `@clankie/protocol`, the same client the TUI drives; this file only adds
 * the authenticated transport, a deadline and a receipt. It resolves no models,
 * scores no output, and keeps no state: the evidence is the durable
 * conversation log and `turn-settled.jsonl` the service already writes.
 *
 * `--base` is required. Defaulting it would point a comparison at whatever
 * service owns the default port, which is normally the owner's live one.
 * `--check` validates arguments, the brief and the wiring against an in-process
 * fake and exits without touching a service or a credential.
 *
 * The bearer is read from `CLANKIE_CAPTAIN_TOKEN` and never printed.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createOperatorConversationServiceClient,
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceResultSchema,
  type OperatorConversationServiceDispatch,
  type OperatorConversationServiceRequest,
  type OperatorConversationServiceResult,
  type OperatorConversationStreamEvent,
} from "@clankie/protocol";

interface Options {
  readonly base: string;
  readonly brief: string;
  readonly title: string;
  readonly timeoutMs: number;
  readonly attach?: { readonly conversationId: string; readonly runId: string };
  readonly check: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const read = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const base = read("--base");
  // Never default the endpoint: the default port belongs to the owner's live
  // service, and a comparison must say out loud which service it drives.
  if (base === undefined || base.length === 0) {
    throw new Error("--base is required (e.g. --base http://127.0.0.1:4410)");
  }
  const brief = read("--brief");
  if (brief === undefined || brief.length === 0) throw new Error("--brief FILE is required");
  const conversationId = read("--conversation");
  const runId = read("--run");
  // Attaching needs both halves; one alone would either send a second turn into
  // an existing conversation or poll a run nothing named.
  if ((conversationId === undefined) !== (runId === undefined)) {
    throw new Error("--conversation and --run must be given together, or neither");
  }
  const timeout = Number(read("--timeout") ?? 25 * 60 * 1000);
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error("--timeout must be positive ms");
  return {
    base,
    brief,
    title: read("--title") ?? "comparison run",
    timeoutMs: timeout,
    check: argv.includes("--check"),
    ...(conversationId === undefined || runId === undefined ? {} : { attach: { conversationId, runId } }),
  };
}

/** The authenticated transport. The route answers `{op, schemaVersion, result}`. */
function createHttpDispatch(input: {
  readonly base: string;
  readonly token: string;
  readonly deadlineAt: number;
}): OperatorConversationServiceDispatch {
  return async (request: OperatorConversationServiceRequest) => {
    // Bound every call by what is left of the run's deadline, never by a fresh
    // window past it: a request started near the end must not outlive the run.
    const remaining = input.deadlineAt - Date.now();
    if (remaining <= 0) throw new Error("deadline exceeded before dispatch");
    const response = await fetch(new URL(OPERATOR_CONVERSATION_DISPATCH_PATH, input.base), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${input.token}` },
      body: JSON.stringify(request),
      redirect: "error",
      signal: AbortSignal.timeout(remaining),
    });
    if (!response.ok) throw new Error(`dispatch ${String(response.status)}: ${await response.text()}`);
    return OperatorConversationServiceResultSchema.parse(await response.json());
  };
}

interface RunReceipt {
  readonly conversationId: string;
  readonly runId: string;
  readonly settled: { readonly phase: string; readonly reasonCode?: string; readonly summary?: string };
  readonly elapsedMs: number;
  readonly counts: Record<string, number>;
  readonly events: readonly OperatorConversationStreamEvent[];
}

async function runComparison(
  options: Options,
  dispatch: OperatorConversationServiceDispatch,
  deadlineAt: number,
  onAccepted: (ids: { readonly conversationId: string; readonly runId: string }) => void,
): Promise<RunReceipt> {
  const client = createOperatorConversationServiceClient(dispatch);
  const surfaceClientId = `comparison-${randomUUID()}`;
  const message = (await readFile(options.brief, "utf8")).trim();
  if (message.length === 0) throw new Error(`brief ${options.brief} is empty`);

  let conversationId: string;
  let runId: string;
  const startedAt = Date.now();
  if (options.attach !== undefined) {
    ({ conversationId, runId } = options.attach);
  } else {
    const conversation = await client.create({ scope: { kind: "global" }, title: options.title });
    conversationId = conversation.conversationId;
    const accepted = await client.send({
      kind: "message",
      schemaVersion: 1,
      conversationId,
      surfaceClientId,
      expectedRevision: conversation.revision,
      message,
    });
    if (accepted.status !== "accepted") {
      throw new Error(`send was not accepted: ${JSON.stringify(accepted).slice(0, 400)}`);
    }
    runId = accepted.runId;
  }
  // Hand the caller the accepted run's identity before any polling. A failure
  // after this point is resumable with `--conversation`/`--run`, so a driver
  // bug never costs a second model turn.
  onAccepted({ conversationId, runId });

  const events: OperatorConversationStreamEvent[] = [];
  let cursor: string | undefined;
  let settled: RunReceipt["settled"] | undefined;
  while (settled === undefined && Date.now() < deadlineAt) {
    const page = await client.replay({
      schemaVersion: 1,
      conversationId,
      surfaceClientId,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (page.status !== "page") throw new Error(`replay recovery: ${JSON.stringify(page).slice(0, 300)}`);
    for (const event of page.events) {
      events.push(event);
      if (event.type === "turn" && event.runId === runId && event.phase !== "accepted") {
        settled = {
          phase: event.phase,
          ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
          ...(event.summary === undefined ? {} : { summary: event.summary }),
        };
      }
    }
    cursor = page.nextCursor;
    if (settled === undefined && !page.hasMore) {
      const nap = Math.min(3_000, deadlineAt - Date.now());
      if (nap > 0) await new Promise((resolve) => setTimeout(resolve, nap));
    }
  }

  const count = (predicate: (event: OperatorConversationStreamEvent) => boolean): number =>
    events.filter(predicate).length;
  return {
    conversationId,
    runId,
    settled: settled ?? { phase: "timed_out_locally" },
    elapsedMs: Date.now() - startedAt,
    counts: {
      events: events.length,
      toolEvents: count((event) => event.type === "tool"),
      captainMessages: count((event) => event.type === "message" && event.role === "captain"),
      inputRequested: count((event) => event.type === "input_requested"),
    },
    events,
  };
}

/**
 * Argument, brief and wiring validation against an in-process fake: proves the
 * op sequence, the pre-poll announcement and settle detection without a
 * service, a credential or a model call.
 */
async function selfCheck(options: Options): Promise<void> {
  const seen: string[] = [];
  const envelope = (result: unknown): OperatorConversationServiceResult =>
    OperatorConversationServiceResultSchema.parse(result);
  const now = new Date().toISOString();
  const fake: OperatorConversationServiceDispatch = (request) => {
    seen.push(request.op);
    if (request.op === "create") {
      return Promise.resolve(
        envelope({
          op: "create",
          schemaVersion: 1,
          conversation: {
            schemaVersion: 1,
            conversationId: "conv-check",
            scope: { kind: "global" },
            title: options.title,
            isDefault: false,
            createdAt: now,
            updatedAt: now,
            sessionState: "unbound",
            revision: 0,
          },
        }),
      );
    }
    if (request.op === "send") {
      return Promise.resolve(
        envelope({
          op: "send",
          schemaVersion: 1,
          result: {
            schemaVersion: 1,
            status: "accepted",
            conversationId: "conv-check",
            runId: "run-check",
            revision: 1,
            safeCursor: "000000000000",
          },
        }),
      );
    }
    return Promise.resolve(
      envelope({
        op: "replay",
        schemaVersion: 1,
        result: {
          schemaVersion: 1,
          status: "page",
          conversationId: "conv-check",
          surfaceClientId: "check",
          events: [
            {
              schemaVersion: 1,
              type: "turn",
              conversationId: "conv-check",
              cursor: "000000000001",
              occurredAt: now,
              revision: 1,
              runId: "run-check",
              phase: "completed",
            },
          ],
          retainedFromCursor: "000000000000",
          nextCursor: "000000000001",
          safeCursor: "000000000001",
          hasMore: false,
        },
      }),
    );
  };
  let announced: { conversationId: string; runId: string } | undefined;
  const receipt = await runComparison(options, fake, Date.now() + 30_000, (ids) => {
    announced = { ...ids };
  });
  const problems: string[] = [];
  if (seen.join(",") !== "create,send,replay") problems.push(`unexpected op sequence: ${seen.join(",")}`);
  if (announced?.runId !== "run-check") problems.push("accepted run ids were not announced before polling");
  if (receipt.settled.phase !== "completed") problems.push(`settle not detected: ${receipt.settled.phase}`);
  if (problems.length > 0) {
    console.error(`comparison-run --check FAILED:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  process.stdout.write(
    `${JSON.stringify({ check: "passed", base: options.base, brief: options.brief, ops: seen }, null, 2)}\n`,
  );
}

const options = parseArgs(process.argv.slice(2));
if (options.check) {
  await selfCheck(options);
} else {
  const token = process.env["CLANKIE_CAPTAIN_TOKEN"];
  if (token === undefined || token.length === 0) {
    console.error("CLANKIE_CAPTAIN_TOKEN is required; it is read from the environment and never printed.");
    process.exit(2);
  }
  const deadlineAt = Date.now() + options.timeoutMs;
  const receipt = await runComparison(
    options,
    createHttpDispatch({ base: options.base, token, deadlineAt }),
    deadlineAt,
    // stderr, so a piped receipt stays valid JSON even if polling dies next.
    (ids) => process.stderr.write(`accepted ${ids.conversationId} ${ids.runId}\n`),
  );
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.settled.phase !== "completed") process.exitCode = 1;
}
