import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { RemoteLeadLaunchSchema } from "@clankie/protocol/remote-leads";
import { commandHost, outputJson, type Writable } from "./io.ts";

export async function runRemoteLeadCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    operatorCredentialStore?: CredentialStore;
    stdout?: Writable;
    stdin?: AsyncIterable<unknown>;
  },
) {
  const usage = "clankie conversations lead prepare FLEET | launch --json-stdin | revoke DELEGATION_ID";
  const [action, value] = args;
  if (args.length !== 2 || !["prepare", "launch", "revoke"].includes(action ?? "")) throw new Error(usage);
  let body: unknown;
  if (action === "launch") {
    if (value !== "--json-stdin") throw new Error(usage);
    let text = "";
    for await (const chunk of options.stdin ?? process.stdin) {
      text += String(chunk);
      if (Buffer.byteLength(text) > 16 * 1024) throw new Error("Remote lead launch input too large");
    }
    body = RemoteLeadLaunchSchema.parse(JSON.parse(text));
  } else body = action === "prepare" ? { fleet: value } : { delegationId: value };
  const credential = await resolveOperatorCredential({
    env: options.env ?? process.env,
    ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
  });
  if (!credential) throw new Error("Remote lead launch requires owner operator authentication");
  const response = await (options.fetchImpl ?? fetch)(
    new URL(`/v1/remote-leads/${action}`, commandHost(options)),
    {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    },
  );
  if (!response.ok) {
    const detail = (await response.json().catch(() => undefined)) as { error?: unknown } | undefined;
    throw new Error(
      `Remote lead request refused (${response.status})${typeof detail?.error === "string" ? ": " + detail.error : ""}; retain the launch requestId and inspect its receipt before new intent`,
    );
  }
  const result = await response.json();
  outputJson(options.stdout ?? process.stdout, result);
  return result.stage === "unconfirmed" ? 1 : 0;
}
