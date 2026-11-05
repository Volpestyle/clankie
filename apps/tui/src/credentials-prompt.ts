import type { CredentialAnswerResult, CredentialRequestList } from "@clankie/protocol/credential-requests";
import { runCredentialsCommand } from "./command/credentials.ts";
import type { OwnerSettingsApiOptions } from "./command/owner-settings-api.ts";
import type { SetupFlow } from "./shell/setup-flow.ts";

/**
 * `/credentials` (#245): a worker's sign-in request in the console's centered
 * modal. Each value goes into a masked field and straight to the broker over
 * the local owner API, never into the chat, transcript or scrollback.
 */
export async function credentialsPrompt(flow: SetupFlow, api: OwnerSettingsApiOptions): Promise<string> {
  flow.begin("Sign-in requests");
  try {
    const { requests } = (await runCredentialsCommand(["list"], api)) as CredentialRequestList;
    if (!requests.length) return "No sign-in requests";
    const requestId = await flow.readSelect({
      message: "Sign-in requests\nA worker is waiting for you to sign in on a page in Clankie's browser.",
      options: requests.map((request) => ({
        value: request.requestId,
        label: request.origin,
        description: `${request.requester} · ${request.fields.join(", ")}`,
      })),
    });
    const request = requests.find((candidate) => candidate.requestId === requestId);
    if (!request) return "Closed";
    const action = await flow.readSelect({
      message: `Sign in to ${request.origin} for ${request.requester}?\nClankie's browser fills and submits the form; the worker never sees what you type.`,
      allowBack: false,
      options: [
        { value: "answer", label: "Sign in" },
        { value: "decline", label: "Decline", description: "The worker's tab comes back untouched" },
      ],
    });
    if (action !== "answer" && action !== "decline") return "Closed; the request is still open.";
    const result = (await runCredentialsCommand([action, request.requestId], {
      ...api,
      readValue: async (prompt) => {
        const value = await flow.readSecret({ message: prompt.trim(), allowBack: false });
        if (value === undefined) throw new Error("Cancelled; the request is still open.");
        return value;
      },
    })) as CredentialAnswerResult;
    if (result.outcome === "refused") return `Not sent: ${result.reason.replaceAll("_", " ")}`;
    const settled = result.request;
    return `${settled.origin}: ${settled.outcome}${settled.reason ? ` (${settled.reason.replaceAll("_", " ")})` : ""}`;
  } finally {
    flow.end();
  }
}
