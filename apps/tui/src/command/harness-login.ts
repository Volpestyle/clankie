import { createInterface } from "node:readline/promises";
import { resolveOperatorCredential } from "@clankie/credential-broker";
import {
  HARNESS_LOGINS_PATH,
  HARNESS_LOGIN_CANCEL_PATH,
  HARNESS_LOGIN_CODE_PATH,
  HARNESS_LOGIN_START_PATH,
  HARNESS_LOGIN_STATUS_PATH,
  HarnessLoginResultSchema,
  HarnessLoginsResponseSchema,
  LoginHarnessSchema,
  type HarnessLoginResult,
} from "@clankie/protocol/harness-logins";
import type { BrowserCommandOptions } from "./browser.ts";
import { commandHost } from "./io.ts";

const USAGE = "Usage: clankie harness login [status | claude | codex | cancel SESSION_ID]";

/**
 * Sign a worker harness into the owner's own account with its official login.
 * The link and code go to the person at this terminal (stderr), never to stdout
 * JSON, logs or a conversation.
 */
export async function runHarnessLoginCommand(
  args: readonly string[],
  options: BrowserCommandOptions & {
    readonly prompt?: (question: string) => Promise<string>;
    readonly tell?: (text: string) => void;
    readonly pollMs?: number;
  } = {},
): Promise<unknown> {
  if (args[0] !== "login") throw new Error(USAGE);
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
  });
  if (!credential?.token) throw new Error("Harness sign-in needs the operator credential");
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await (options.fetchImpl ?? fetch)(new URL(path, commandHost(options)), {
      method,
      headers: {
        authorization: `Bearer ${credential.token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  };
  const verb = args[1] ?? "status";
  if (verb === "status" && args.length <= 2) {
    const { status, body } = await call("GET", HARNESS_LOGINS_PATH);
    if (status !== 200) throw new Error(`Harness sign-in status unavailable (${status})`);
    return HarnessLoginsResponseSchema.parse(body);
  }
  if (verb === "cancel" && args.length === 3)
    return HarnessLoginResultSchema.parse(
      (await call("POST", HARNESS_LOGIN_CANCEL_PATH, { sessionId: args[2] })).body,
    );
  const harness = LoginHarnessSchema.safeParse(verb);
  if (!harness.success || args.length !== 2) throw new Error(USAGE);
  const tell = options.tell ?? ((text: string) => process.stderr.write(`${text}\n`));
  const prompt =
    options.prompt ??
    (process.stdin.isTTY
      ? async (question: string) => {
          const reader = createInterface({
            input: process.stdin,
            output: process.stderr,
          });
          try {
            return await reader.question(question);
          } finally {
            reader.close();
          }
        }
      : undefined);
  let result = HarnessLoginResultSchema.parse(
    (await call("POST", HARNESS_LOGIN_START_PATH, { harness: harness.data })).body,
  );
  // Ctrl-C ends this sign-in on the service too, so the next one is not blocked.
  const sessionId = result.ok ? result.sessionId : undefined;
  const interrupt = () => {
    const cancel = sessionId ? call("POST", HARNESS_LOGIN_CANCEL_PATH, { sessionId }) : Promise.resolve();
    void cancel.finally(() => process.exit(130));
  };
  process.once("SIGINT", interrupt);
  try {
    return await follow();
  } catch (error) {
    // A prompt aborted with Ctrl-C (or any failure here) ends the sign-in too.
    if (sessionId) await call("POST", HARNESS_LOGIN_CANCEL_PATH, { sessionId }).catch(() => undefined);
    throw error;
  } finally {
    process.off("SIGINT", interrupt);
  }
  async function follow(): Promise<unknown> {
    let shown = false;
    for (;;) {
      if (!result.ok) return result;
      if (result.url !== undefined && !shown) {
        shown = true;
        if (result.userCode !== undefined)
          tell(`Open ${result.url} on any device and enter the code ${result.userCode}.`);
        else tell(`Open ${result.url} on any device, sign in, and copy the code it shows.`);
      }
      if (result.state === "needs_code") {
        if (prompt === undefined) {
          await call("POST", HARNESS_LOGIN_CANCEL_PATH, {
            sessionId: result.sessionId,
          });
          throw new Error("Claude sign-in needs the code typed here; run it in a terminal, or use the app.");
        }
        if (result.codeRejected) tell("That code was not accepted; copy the whole code and try again.");
        const code = (await prompt("Code: ")).trim();
        result = HarnessLoginResultSchema.parse(
          (
            await call("POST", HARNESS_LOGIN_CODE_PATH, {
              sessionId: result.sessionId,
              code,
            })
          ).body,
        );
        continue;
      }
      if (!["pending", "verifying"].includes(result.state)) return strip(result);
      await new Promise((done) => setTimeout(done, options.pollMs ?? 2_000));
      result = HarnessLoginResultSchema.parse(
        (
          await call("POST", HARNESS_LOGIN_STATUS_PATH, {
            sessionId: result.sessionId,
          })
        ).body,
      );
    }
  }
}

/** The final JSON carries the outcome only, never the link or code. */
function strip(result: HarnessLoginResult): HarnessLoginResult {
  if (!result.ok) return result;
  const { url: _url, userCode: _code, ...rest } = result;
  return rest;
}
