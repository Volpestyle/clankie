import { DiscordSDK } from "@discord/embedded-app-sdk";
import { ActivitySessionSchema } from "@clankie/protocol/activity-sharing";

/** Only the server's admitted session selects the media destination. */
export async function admitOfficialActivity(applicationId: string, signal: AbortSignal) {
  if (signal.aborted) throw new Error("activity_cancelled");
  if (!/^\d{1,24}$/u.test(applicationId)) throw new Error("activity_configuration_unavailable");
  const sdk = new DiscordSDK(applicationId, { disableConsoleLogOverride: true });
  const close = () => sdk.close(1000, "viewer_closed");
  signal.addEventListener("abort", close, { once: true });
  const deadline = new AbortController();
  const abort = () => deadline.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timeout = setTimeout(() => deadline.abort(), 15_000);
  const interrupted = new Promise<never>((_, reject) => {
    deadline.signal.addEventListener(
      "abort",
      () => {
        close();
        reject(new Error("activity_handshake_interrupted"));
      },
      { once: true },
    );
  });
  // Authorize -> exchange. The SDK's guild/channel query parameters are never
  // sent as authority; the server reads the instance itself.
  const admit = async (admission: AbortSignal) => {
    const { code } = await sdk.commands.authorize({
      client_id: applicationId,
      response_type: "code",
      state: crypto.randomUUID(),
      prompt: "none",
      scope: ["identify"],
    });
    const response = await fetch("/.proxy/activity/admit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, instanceId: sdk.instanceId }),
      cache: "no-store",
      credentials: "omit",
      signal: admission,
    });
    if (!response.ok) throw new Error("activity_admission_denied");
    const result: unknown = await response.json();
    if (result === null || typeof result !== "object") throw new Error("activity_admission_invalid");
    const value = result as Record<string, unknown>;
    const session = ActivitySessionSchema.parse(value.session);
    if (
      typeof value.grant !== "string" ||
      !/^[A-Za-z0-9_-]{32,128}$/u.test(value.grant) ||
      typeof value.accessToken !== "string" ||
      value.accessToken.length < 1 ||
      value.accessToken.length > 8192 ||
      typeof value.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      Date.parse(value.expiresAt) <= Date.now() ||
      Date.parse(value.expiresAt) > Date.parse(session.expiresAt) ||
      typeof value.mediaPath !== "string" ||
      value.mediaPath !== `/.proxy/activity/shares/${session.shareId}/frames`
    )
      throw new Error("activity_admission_invalid");
    return {
      session,
      grant: value.grant,
      expiresAt: value.expiresAt,
      mediaPath: value.mediaPath,
      accessToken: value.accessToken,
    };
  };
  // A later admission for the same viewer, before its grant lapses (VUH-2833).
  const renew = async () => {
    if (signal.aborted) throw new Error("activity_cancelled");
    const { accessToken: _token, ...next } = await admit(
      AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    );
    return { ...next, renew };
  };
  const handshake = async () => {
    // Discord's ready -> authorize -> exchange -> authenticate sequence.
    await sdk.ready();
    if (deadline.signal.aborted) throw new Error("activity_cancelled");
    const { accessToken, ...admitted } = await admit(deadline.signal);
    const authenticated = await sdk.commands.authenticate({ access_token: accessToken });
    if (!authenticated || deadline.signal.aborted) throw new Error("activity_authentication_failed");
    return { ...admitted, renew };
  };
  try {
    return await Promise.race([handshake(), interrupted]);
  } catch (error) {
    close();
    signal.removeEventListener("abort", close);
    throw error;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  }
}
