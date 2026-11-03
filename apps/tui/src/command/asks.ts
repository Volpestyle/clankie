import {
  WORKER_ASKS_PATH,
  WorkerAskListSchema,
  WorkerAskResultSchema,
  workerAskAnswerPath,
  workerAskWithdrawPath,
  type WorkerAskList,
  type WorkerAskResult,
} from "@clankie/protocol/worker-asks";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";

const ASKS_USAGE =
  "Usage: clankie asks [list] [--all] | asks answer ASK_ID (--value VALUE | --text TEXT) | asks withdraw ASK_ID";

/**
 * `clankie asks` (#604): the structured asks workers raised to their leads,
 * through the same API the app and every lead use. Lists open asks by default.
 */
export async function runAsksCommand(
  args: readonly string[],
  options: OwnerSettingsApiOptions,
): Promise<WorkerAskList | WorkerAskResult> {
  const api = await ownerSettingsApi(options);
  const [action, ...rest] = args;
  if (action === undefined || action === "list") {
    if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--all")) throw new Error(ASKS_USAGE);
    return api.get(
      rest[0] === "--all" ? WORKER_ASKS_PATH : `${WORKER_ASKS_PATH}?state=open`,
      WorkerAskListSchema,
    );
  }
  if (action === "answer") {
    const [askId, flag, value] = rest;
    if (askId === undefined || value === undefined || rest.length !== 3) throw new Error(ASKS_USAGE);
    if (flag !== "--value" && flag !== "--text") throw new Error(ASKS_USAGE);
    return api.write(
      workerAskAnswerPath(askId),
      flag === "--value" ? { value } : { text: value },
      WorkerAskResultSchema,
    );
  }
  if (action === "withdraw") {
    if (rest.length !== 1) throw new Error(ASKS_USAGE);
    return api.write(workerAskWithdrawPath(rest[0]!), {}, WorkerAskResultSchema);
  }
  throw new Error(ASKS_USAGE);
}
