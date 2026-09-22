import { resolveActivityProducerCredential } from "@clankie/credential-broker";
import { createHash } from "node:crypto";

/** A read-only, session-scoped Rivals frame URL; never a control bearer. */
export async function fetchRivalsSnapshot(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ActivitySnapshotFrame | undefined> {
  const target = new URL(url);
  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username ||
    target.password ||
    target.pathname !== "/frame.png" ||
    !/^[A-Za-z0-9_-]{32,128}$/u.test(target.searchParams.get("key") ?? "")
  )
    return undefined;
  const response = await fetchImpl(target, { redirect: "error", signal: AbortSignal.timeout(1500) });
  if (!response.ok || response.headers.get("content-type") !== "image/png") return undefined;
  const length = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(length) || length < 8 || length > 4 * 1024 * 1024 || !response.body) {
    await response.body?.cancel();
    return undefined;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      received += part.value.length;
      if (received > length) return undefined;
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  const data = Buffer.concat(chunks);
  if (received !== length || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return undefined;
  return {
    mimeType: "image/png",
    data: data.toString("base64"),
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

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
