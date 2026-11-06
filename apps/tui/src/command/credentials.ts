import {
  CREDENTIAL_REQUESTS_PATH,
  CredentialAnswerResultSchema,
  CredentialRequestListSchema,
  credentialAnswerPath,
  credentialDeclinePath,
  type CredentialAnswerResult,
  type CredentialFieldKind,
  type CredentialRequestList,
} from "@clankie/protocol/credential-requests";
import { ownerSettingsApi, type OwnerSettingsApiOptions } from "./owner-settings-api.ts";

const CREDENTIALS_USAGE =
  "Usage: clankie credentials [list] [--all] | credentials answer REQUEST_ID | credentials decline REQUEST_ID";

const LABELS: Record<CredentialFieldKind, string> = {
  username: "Username",
  password: "Password",
  code: "One-time code",
};

export interface CredentialsCommandOptions extends OwnerSettingsApiOptions {
  /** Reads one value without echoing it; the prompt goes to the terminal, never stdout. */
  readonly readValue?: (prompt: string) => Promise<string>;
}

/**
 * `clankie credentials` (#245): sign-in requests from workers. `answer` asks
 * for each value with echo off and sends it over the local owner API straight
 * to the broker. A value is never an argument, so it stays out of shell
 * history and process listings.
 */
export async function runCredentialsCommand(
  args: readonly string[],
  options: CredentialsCommandOptions = {},
): Promise<CredentialRequestList | CredentialAnswerResult> {
  const api = await ownerSettingsApi(options);
  const [action, ...rest] = args;
  if (action === undefined || action === "list") {
    if (rest.length > 1 || (rest.length === 1 && rest[0] !== "--all")) throw new Error(CREDENTIALS_USAGE);
    return api.get(
      `${CREDENTIAL_REQUESTS_PATH}${rest[0] === "--all" ? "?state=all" : ""}`,
      CredentialRequestListSchema,
    );
  }
  if ((action === "answer" || action === "decline") && rest.length === 1) {
    const requestId = rest[0]!;
    if (action === "decline")
      return api.write(credentialDeclinePath(requestId), {}, CredentialAnswerResultSchema);
    const { requests } = await api.get(CREDENTIAL_REQUESTS_PATH, CredentialRequestListSchema);
    const request = requests.find((candidate) => candidate.requestId === requestId);
    if (!request) return { outcome: "refused", reason: "closed" };
    const read = options.readValue ?? readHidden;
    const values: Partial<Record<CredentialFieldKind, string>> = {};
    for (const kind of request.fields) {
      const value = await read(
        `${LABELS[kind]} for ${request.url ?? request.origin} (${request.requester}): `,
      );
      if (!value) throw new Error("Nothing entered; the request is still open.");
      values[kind] = value;
    }
    return api.write(credentialAnswerPath(requestId), { values }, CredentialAnswerResultSchema);
  }
  throw new Error(CREDENTIALS_USAGE);
}

let piped: Promise<string[]> | undefined;
/** One line from the terminal with echo off, or the next line of piped input. */
async function readHidden(prompt: string): Promise<string> {
  const input = process.stdin;
  const terminal = process.stderr;
  if (!input.isTTY) {
    // Piped: one value per line, in the request's field order.
    piped ??= (async () => {
      let text = "";
      for await (const chunk of input) text += String(chunk);
      return text.split(/\r?\n/u);
    })();
    return (await piped).shift() ?? "";
  }
  terminal.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = "";
      const done = (result: string | Error) => {
        input.off("data", onData);
        terminal.write("\n");
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      const onData = (chunk: string) => {
        for (const character of chunk) {
          if (character === "\r" || character === "\n") return done(value);
          if (character === "\u0003" || character === "\u0004")
            return done(new Error("Cancelled; the request is still open."));
          if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
          else if (character >= " ") value += character;
        }
      };
      input.on("data", onData);
    });
  } finally {
    input.setRawMode(false);
    input.pause();
  }
}
