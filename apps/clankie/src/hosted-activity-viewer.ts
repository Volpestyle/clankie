import { ActivityViewerRequestSchema } from "@clankie/protocol/activity-sharing";
import { verifyActivityViewerPermit } from "@clankie/protocol/activity-sharing-crypto";
import type { ActivitySharing } from "./activity-sharing.ts";
import type { HostedBodyClient } from "./hosted-body.ts";

/** A fleet media permit grants only this read stream; live audience checks remain authoritative. */
export async function hostedActivityViewer(
  request: Request,
  body: Pick<HostedBodyClient, "bootstrap" | "keys" | "revalidateActivity">,
  sharing: ActivitySharing,
  clock: () => number = Date.now,
): Promise<Response> {
  const parsed = ActivityViewerRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "activity_viewer_denied" }, { status: 403 });
  try {
    verifyActivityViewerPermit(parsed.data.permit, {
      ...body.bootstrap,
      session: parsed.data.session,
      authorization: parsed.data.authorization,
      keys: body.keys,
      nowMs: clock(),
    });
  } catch {
    return Response.json({ error: "activity_viewer_denied" }, { status: 403 });
  }
  let proofUntil = 0;
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  const authorize = async () => {
    if (controller.signal.aborted) return false;
    if (proofUntil > clock()) return true;
    try {
      const proof = await body.revalidateActivity(parsed.data.authorization);
      const scope = parsed.data.session.scope;
      if (
        proof.session.shareId !== parsed.data.session.shareId ||
        proof.session.generation < parsed.data.session.generation ||
        proof.session.scope.tenantId !== scope.tenantId ||
        proof.session.scope.installationId !== scope.installationId ||
        proof.session.scope.guildId !== scope.guildId ||
        proof.session.scope.channelId !== scope.channelId
      )
        return false;
      proofUntil = Math.min(
        Date.parse(proof.expiresAt),
        Date.parse(proof.session.expiresAt),
        clock() + 15_000,
      );
      return proofUntil > clock();
    } catch {
      return false;
    }
  };
  if (!(await authorize())) {
    request.signal.removeEventListener("abort", abort);
    return Response.json({ error: "activity_viewer_denied" }, { status: 403 });
  }
  let upstream: Response;
  try {
    upstream = await sharing.openViewer(parsed.data.session, authorize, controller.signal);
  } catch {
    controller.abort();
    request.signal.removeEventListener("abort", abort);
    return Response.json({ error: "activity_viewer_denied" }, { status: 403 });
  }
  if (!upstream.ok || !upstream.body) {
    controller.abort();
    request.signal.removeEventListener("abort", abort);
    return Response.json({ error: "activity_viewer_denied" }, { status: 403 });
  }
  const reader = upstream.body.getReader();
  let timer: ReturnType<typeof setInterval> | undefined;
  const cleanup = () => {
    if (timer) clearInterval(timer);
    request.signal.removeEventListener("abort", abort);
    controller.abort();
    void reader.cancel().catch(() => undefined);
  };
  const stream = new ReadableStream<Uint8Array>({
    start(output) {
      let checking = false;
      timer = setInterval(() => {
        if (checking) return;
        checking = true;
        void authorize()
          .then((ok) => {
            if (!ok) {
              cleanup();
              try {
                output.close();
              } catch {
                /* already ended */
              }
            }
          })
          .finally(() => {
            checking = false;
          });
      }, 1000);
      timer.unref();
    },
    async pull(output) {
      try {
        const next = await reader.read();
        if (next.done) {
          cleanup();
          output.close();
          return;
        }
        if (!(await authorize())) {
          cleanup();
          output.close();
          return;
        }
        output.enqueue(next.value);
      } catch {
        cleanup();
        try {
          output.close();
        } catch {
          /* already ended */
        }
      }
    },
    cancel: cleanup,
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" },
  });
}
