import { createInterface } from "node:readline/promises";
import { resolveOperatorCredential } from "@clankie/credential-broker";
import {
  HARNESS_LOGINS_PATH,
  HARNESS_LOGIN_ACCOUNTS_PATH,
  HARNESS_LOGIN_CANCEL_PATH,
  HARNESS_LOGIN_CODE_PATH,
  HARNESS_LOGIN_INSTALL_PATH,
  HARNESS_LOGIN_REMOVE_PATH,
  HARNESS_LOGIN_START_PATH,
  HARNESS_LOGIN_STATUS_PATH,
  HarnessInstallResultSchema,
  HarnessLoginAccountsResponseSchema,
  HarnessLoginRemoveResultSchema,
  HarnessAccountLoginResultSchema,
  HarnessLoginsResponseSchema,
  HarnessProfileSchema,
  LoginHarnessSchema,
  type HarnessAccountLoginResult,
} from "@clankie/protocol/harness-logins";
import type { BrowserCommandOptions } from "./browser.ts";
import { commandHost } from "./io.ts";
import { confirmMachineSetupApproval } from "./machine-setup.ts";

const USAGE =
  "Usage: clankie harness login [status | accounts | claude|codex [--add [LABEL] | --profile LABEL] | install claude|codex [--approve] | remove claude|codex LABEL [--yes] | cancel SESSION_ID]";

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
    /** Asks the person at this terminal to approve machine setup; headless is refused. */
    readonly confirmApproval?: (detail: string) => Promise<void>;
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
  if (verb === "accounts" && args.length === 2) {
    const { status, body } = await call("GET", HARNESS_LOGIN_ACCOUNTS_PATH);
    if (status !== 200) throw new Error(`Harness accounts unavailable (${status})`);
    return HarnessLoginAccountsResponseSchema.parse(body);
  }
  if (verb === "cancel" && args.length === 3)
    return HarnessAccountLoginResultSchema.parse(
      (await call("POST", HARNESS_LOGIN_CANCEL_PATH, { sessionId: args[2] })).body,
    );
  if (verb === "install" && (args.length === 3 || (args.length === 4 && args[3] === "--approve"))) {
    const installing = LoginHarnessSchema.safeParse(args[2]);
    if (!installing.success) throw new Error(USAGE);
    // `--approve` asks the owner here, as every machine-setup approval does: a flag is not consent.
    if (args[3] === "--approve")
      await (options.confirmApproval ?? confirmMachineSetupApproval)(
        `Install ${installing.data === "claude" ? "Claude Code" : "Codex"} on the service's machine with its vendor's own installer.`,
      );
    // The vendor's installer runs on the service's machine; its output comes here (stderr) as it runs.
    const tell = options.tell ?? ((text: string) => process.stderr.write(`${text}\n`));
    let shown: string[] = [];
    const show = (progress: readonly string[]) => {
      // Progress is a rolling window: print only what follows what was already shown.
      let overlap = Math.min(shown.length, progress.length);
      while (overlap > 0 && !shown.slice(-overlap).every((line, index) => line === progress[index]))
        overlap -= 1;
      for (const line of progress.slice(overlap)) tell(line);
      shown = [...progress];
    };
    let result = HarnessInstallResultSchema.parse(
      (
        await call("POST", HARNESS_LOGIN_INSTALL_PATH, {
          harness: installing.data,
          ...(args[3] === "--approve" ? { ownerApproved: true } : {}),
        })
      ).body,
    );
    const installId = result.ok ? result.install.installId : undefined;
    while (result.ok && result.install.state === "running") {
      show(result.install.progress);
      await new Promise((done) => setTimeout(done, options.pollMs ?? 2_000));
      result = HarnessInstallResultSchema.parse((await call("GET", HARNESS_LOGIN_INSTALL_PATH)).body);
      if (result.ok && result.install.installId !== installId)
        throw new Error("Another install replaced this one; read it with GET /v1/harness-logins/install");
    }
    if (result.ok) show(result.install.progress);
    return result;
  }
  if (verb === "remove" && (args.length === 4 || (args.length === 5 && args[4] === "--yes"))) {
    const removing = LoginHarnessSchema.safeParse(args[2]);
    const profile = HarnessProfileSchema.safeParse(args[3]);
    if (!removing.success || !profile.success) throw new Error(USAGE);
    // Its harness's own logout may revoke the sign-in: the owner confirms which account.
    if (args[4] !== "--yes") {
      const { body } = await call("GET", HARNESS_LOGIN_ACCOUNTS_PATH);
      const row = HarnessLoginAccountsResponseSchema.safeParse(body)
        .data?.harnesses.find((entry) => entry.harness === removing.data)
        ?.accounts.find(
          (account) => account.profile === profile.data || account.profiles.includes(profile.data),
        );
      const ask = options.prompt ?? (process.stdin.isTTY ? terminalPrompt : undefined);
      if (ask === undefined)
        throw new Error("Removing an account signs it out; confirm in a terminal or pass --yes");
      const who = row?.identity ? ` (${row.identity})` : "";
      const answer = await ask(
        `Sign ${removing.data} profile ${profile.data}${who} out${row?.managed ? " and delete it" : ""}? [y/N] `,
      );
      if (!/^y(es)?$/iu.test(answer.trim())) return { ok: false, error: "cancelled" };
    }
    return HarnessLoginRemoveResultSchema.parse(
      (await call("POST", HARNESS_LOGIN_REMOVE_PATH, { harness: removing.data, profile: profile.data })).body,
    );
  }
  const harness = LoginHarnessSchema.safeParse(verb);
  // `--add [LABEL]` signs a new account into a new profile; `--profile LABEL` re-signs that one.
  const [flag, label, ...extra] = args.slice(2);
  const named = label === undefined ? undefined : HarnessProfileSchema.safeParse(label);
  if (
    !harness.success ||
    extra.length ||
    (flag !== undefined && flag !== "--add" && flag !== "--profile") ||
    (flag === "--profile" && named === undefined) ||
    named?.success === false
  )
    throw new Error(USAGE);
  const target =
    flag === "--add"
      ? { add: named === undefined ? {} : { label: named.data } }
      : flag === "--profile"
        ? { profile: named!.data }
        : {};
  const tell = options.tell ?? ((text: string) => process.stderr.write(`${text}\n`));
  const prompt = options.prompt ?? (process.stdin.isTTY ? terminalPrompt : undefined);
  let result = HarnessAccountLoginResultSchema.parse(
    (await call("POST", HARNESS_LOGIN_START_PATH, { harness: harness.data, ...target })).body,
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
        result = HarnessAccountLoginResultSchema.parse(
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
      result = HarnessAccountLoginResultSchema.parse(
        (
          await call("POST", HARNESS_LOGIN_STATUS_PATH, {
            sessionId: result.sessionId,
          })
        ).body,
      );
    }
  }
}

async function terminalPrompt(question: string): Promise<string> {
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await reader.question(question);
  } finally {
    reader.close();
  }
}

/** The final JSON carries the outcome only, never the link or code. */
function strip(result: HarnessAccountLoginResult): HarnessAccountLoginResult {
  if (!result.ok) return result;
  const { url: _url, userCode: _code, ...rest } = result;
  return rest;
}
