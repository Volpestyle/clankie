import { randomUUID } from "node:crypto";
import type { ProviderCredential } from "@clankie/credential-broker";
import { runCodexBrowserLogin, runCodexDeviceLogin, runXaiDeviceLogin } from "@clankie/model-provider";
import type { ModelSubscriptionResult, ModelSubscriptionStart } from "@clankie/protocol/model-keys";

export interface ModelSignInAuthority {
  readonly principal: string;
  /** Revalidates the initiating principal inside the device's revoke lock. */
  commit(operation: () => Promise<void>): Promise<boolean>;
}
type Session = Extract<ModelSubscriptionResult, { ok: true }>;
interface Job {
  view: Session;
  principal: string;
  controller: AbortController;
}

/** Bounded, ephemeral login interactions. Readiness, credentials and model selection stay in their existing stores. */
export class ModelSubscriptionSignIns {
  private readonly jobs = new Map<string, Job>();
  private readonly options: {
    env: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    browserPort?: number;
    timeoutMs?: number;
    validate(
      input: ModelSubscriptionStart,
    ): Promise<"unsupported_provider" | "unsupported_model" | undefined>;
    commit(
      input: ModelSubscriptionStart,
      credential: ProviderCredential,
      authority: ModelSignInAuthority,
      signal: AbortSignal,
      admit: () => void,
    ): Promise<void>;
  };
  constructor(options: ModelSubscriptionSignIns["options"]) {
    this.options = options;
  }

  async start(
    input: ModelSubscriptionStart,
    authority: ModelSignInAuthority,
  ): Promise<ModelSubscriptionResult> {
    this.prune();
    if ([...this.jobs.values()].some((job) => ["pending", "committing"].includes(job.view.state)))
      return { ok: false, error: "busy" };
    const controller = new AbortController();
    const job: Job = {
      principal: authority.principal,
      controller,
      view: {
        ok: true,
        sessionId: randomUUID(),
        providerId: input.providerId as Session["providerId"],
        expiresAt: new Date(Date.now() + (this.options.timeoutMs ?? 300_000)).toISOString(),
        state: "pending",
      },
    };
    this.jobs.set(job.view.sessionId, job);
    try {
      const error = await this.options.validate(input);
      if (error) {
        this.jobs.delete(job.view.sessionId);
        return { ok: false, error };
      }
    } catch {
      this.jobs.delete(job.view.sessionId);
      return { ok: false, error: "unavailable" };
    }
    void this.run(job, input, authority);
    return { ...job.view };
  }
  status(sessionId: string, principal: string, cancel = false): ModelSubscriptionResult {
    this.prune();
    const job = this.jobs.get(sessionId);
    if (!job || job.principal !== principal) return { ok: false, error: "session_not_found" };
    if (cancel && job.view.state === "pending") this.end(job, "cancelled");
    return { ...job.view };
  }
  close(): void {
    for (const job of this.jobs.values()) if (job.view.state === "pending") this.end(job, "cancelled");
  }
  private end(job: Job, state: Session["state"]): void {
    job.view = {
      ok: true,
      sessionId: job.view.sessionId,
      providerId: job.view.providerId,
      expiresAt: job.view.expiresAt,
      state,
    };
    job.controller.abort();
  }
  private prune(): void {
    for (const [id, job] of this.jobs) {
      if (Date.parse(job.view.expiresAt) <= Date.now() && job.view.state === "pending")
        this.end(job, "expired");
      if (job.view.state !== "committing" && Date.parse(job.view.expiresAt) + 300_000 <= Date.now())
        this.jobs.delete(id);
    }
    while (this.jobs.size >= 16) {
      const entry = [...this.jobs].find(
        ([, job]) => job.view.state !== "pending" && job.view.state !== "committing",
      );
      if (!entry) break;
      this.jobs.delete(entry[0]);
    }
  }
  private async run(job: Job, input: ModelSubscriptionStart, authority: ModelSignInAuthority): Promise<void> {
    const timer = setTimeout(
      () => {
        if (job.view.state === "pending") this.end(job, "expired");
      },
      Math.max(1, Date.parse(job.view.expiresAt) - Date.now()),
    );
    timer.unref();
    const interaction = (url: string, userCode?: string) => {
      job.controller.signal.throwIfAborted();
      // Never forward an upstream URL with userinfo, a custom scheme or a different issuer.
      const parsed = new URL(url);
      if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        parsed.hostname !== (input.providerId === "xai" ? "auth.x.ai" : "auth.openai.com")
      )
        throw Error("invalid_login_url");
      job.view = { ...job.view, url, ...(userCode ? { userCode } : {}) };
    };
    const common = {
      signal: job.controller.signal,
      timeoutMs: this.options.timeoutMs ?? 300_000,
      ...(this.options.fetchImpl ? { fetchImpl: this.options.fetchImpl } : {}),
    };
    try {
      const credential =
        input.providerId === "xai"
          ? await runXaiDeviceLogin({
              ...common,
              onUserCode: (code, url) => interaction(url, code),
              openUrl: (url) => interaction(url, job.view.userCode),
            })
          : input.method === "device"
            ? await runCodexDeviceLogin({
                ...common,
                env: this.options.env,
                onUserCode: (code, url) => interaction(url, code),
              })
            : await runCodexBrowserLogin({
                ...common,
                env: this.options.env,
                ...(this.options.browserPort === undefined ? {} : { port: this.options.browserPort }),
                openUrl: interaction,
              });
      job.controller.signal.throwIfAborted();
      await this.options.commit(input, credential, authority, job.controller.signal, () => {
        job.controller.signal.throwIfAborted();
        // Once the broker write is admitted, cancellation cannot undo it. Report
        // committing and finish selection rather than claim a cancelled write.
        clearTimeout(timer);
        job.view = {
          ok: true,
          sessionId: job.view.sessionId,
          providerId: job.view.providerId,
          expiresAt: job.view.expiresAt,
          state: "committing",
        };
      });
      job.controller.signal.throwIfAborted();
      this.end(job, "complete");
    } catch {
      if (job.view.state === "pending" || job.view.state === "committing") this.end(job, "failed");
    } finally {
      clearTimeout(timer);
    }
  }
}
