import { MinecraftHostCommandSchema } from "@clankie/protocol";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { commandHost } from "./io.ts";

const USAGE =
  "Usage: clankie minecraft host status|configure [JSON]|start|stop|restart|backup|admin JSON|approve USERNAME|tunnel claim";
export async function runMinecraftHostCommand(
  args: readonly string[],
  options: {
    env?: NodeJS.ProcessEnv;
    host?: string;
    fetchImpl?: typeof fetch;
    operatorCredentialStore?: CredentialStore;
    conversationId?: string;
    onClaimUrl?: (url: string) => void;
  } = {},
): Promise<Record<string, unknown>> {
  const [action = "status", ...rest] = args;
  let raw: unknown;
  if (["status", "start", "stop", "restart", "backup"].includes(action) && !rest.length) raw = { action };
  else if (action === "configure") {
    if (!rest.length) raw = { action: "configuration" };
    else {
      try {
        raw = { action: "configure", settings: JSON.parse(rest.join(" ")) };
      } catch {
        throw new Error(USAGE);
      }
    }
  } else if (action === "admin" && rest.length) {
    try {
      raw = { action: "admin", command: JSON.parse(rest.join(" ")) };
    } catch {
      throw new Error(USAGE);
    }
  } else if (action === "approve" && rest.length === 1)
    raw = { action: "approve_enrollment", username: rest[0] };
  else if (action === "tunnel" && rest.length === 1 && rest[0] === "claim") raw = { action: "claim" };
  else throw new Error(USAGE);
  const command = MinecraftHostCommandSchema.safeParse(raw);
  if (!command.success) throw new Error(USAGE);
  const env = options.env ?? process.env;
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
  });
  if (!credential)
    throw new Error("No operator credential is available; start the clankie service once first.");
  const send = async (body: unknown) => {
    const response = await (options.fetchImpl ?? fetch)(
      new URL("/v1/minecraft/host", commandHost({ ...options, env })),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential.token}`,
          "content-type": "application/json",
          ...(options.conversationId ? { "x-clankie-conversation-id": options.conversationId } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(command.data.action === "claim" ? 650_000 : 180_000),
      },
    );
    if (!response.ok) throw new Error(`Minecraft hosting request refused (${response.status}).`);
    return (await response.json()) as Record<string, unknown>;
  };
  const result = await send(command.data);
  if (command.data.action !== "claim" || typeof result.claimUrl !== "string") return result;
  const url = new URL(result.claimUrl);
  if (url.protocol !== "https:" || url.hostname !== "playit.gg" || !url.pathname.startsWith("/claim/"))
    throw new Error("Invalid playit claim response.");
  (
    options.onClaimUrl ??
    ((value) => process.stderr.write(`Approve this claim in your personal playit account: ${value}\n`))
  )(url.href);
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const claimed = await send({ action: "claim_complete" });
    if (claimed.outcome !== "pending") return claimed;
    await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
  }
  return { outcome: "pending", reason: "claim_not_approved", claimUrl: url.href };
}
