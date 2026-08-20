import { resolveActivityProducerCredential } from "@clankie/credential-broker";

/**
 * Frames Clankie is already showing on the activity plane.
 *
 * The producer listener is loopback-only and bearer-gated (ADR 0047). This
 * reader only resolves the brokered token — it never mints one — so a lab
 * body cannot invent a second producer secret.
 */
interface ActivitySnapshotFrame {
  readonly mimeType: "image/png";
  readonly data: string;
  readonly sha256: string;
}

export async function fetchActivitySnapshot(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  resolveToken: (input: {
    env: NodeJS.ProcessEnv;
  }) => Promise<string | undefined> = resolveActivityProducerCredential,
): Promise<ActivitySnapshotFrame | undefined> {
  const token = await resolveToken({ env });
  if (token === undefined) return undefined;
  const port = env.CLANKIE_ACTIVITY_PRODUCER_PORT?.trim() || "4322";
  const response = await fetchImpl(`http://127.0.0.1:${port}/snapshot`, {
    headers: { authorization: `Bearer ${token}` },
    redirect: "error",
    signal: AbortSignal.timeout(750),
  }).catch(() => undefined);
  if (response === undefined || !response.ok) return undefined;
  const body = (await response.json()) as {
    encoding?: string;
    data?: string;
    sha256?: string;
  };
  if (body.encoding !== "png" || typeof body.data !== "string" || typeof body.sha256 !== "string") {
    return undefined;
  }
  return {
    mimeType: "image/png",
    data: body.data,
    sha256: body.sha256,
  };
}
